//! Windows implementation: WASAPI process loopback (one stream per process tree), mixed on the
//! first stream's audio clock and delivered in 20 ms stereo f32 chunks.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use wasapi::{
    AudioCaptureClient, AudioClient, DeviceEnumerator, Direction, Handle, SampleType, SessionState, StreamMode,
    WaveFormat, initialize_mta,
};
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId};

use crate::apm::Apm;
use crate::{AudioApp, CHANNELS, CHUNK_FRAMES, CaptureInfo, CaptureTarget, MicInfo, MicOptions, SAMPLE_RATE, WindowProcess};

const CHUNK_SAMPLES: usize = CHUNK_FRAMES * CHANNELS as usize;
/// Secondary sources keep at most this much audio queued (drift / hiccups), in chunks.
const MAX_QUEUED_CHUNKS: usize = 5;
/// System processes whose audio sessions are not "apps".
const IGNORED_EXES: &[&str] = &["audiodg.exe", "[system process]", "system"];

// ---------- Processes ----------

/// pid -> (parent pid, exe name)
type ProcessTable = HashMap<u32, (u32, String)>;

fn process_table() -> ProcessTable {
    let mut table = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return table;
        };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
                table.insert(entry.th32ProcessID, (entry.th32ParentProcessID, exe));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    table
}

/// Walks up while the parent runs the same executable (browsers, Discord, Electron apps...),
/// so capturing the result's tree includes all of the app's helper processes.
fn root_of(pid: u32, table: &ProcessTable) -> u32 {
    let Some((_, exe)) = table.get(&pid) else { return pid };
    let mut current = pid;
    for _ in 0..32 {
        match table.get(&current) {
            Some(&(parent, _)) if parent != 0 && parent != current => match table.get(&parent) {
                Some((_, parent_exe)) if parent_exe.eq_ignore_ascii_case(exe) => current = parent,
                _ => break,
            },
            _ => break,
        }
    }
    current
}

/// The process tree that plays this app's sound, for "everything except us" captures.
///
/// Measured (see docs/spikes/06-transmissoes.md): Windows' loopback "process tree" of the app's
/// own process does NOT cover its WebView2 processes, even though they are its children in the
/// process list, while the tree of the WebView2 *browser* process (msedgewebview2.exe, a direct
/// child of ours) does include its audio service. All of the app's audio is played by WebView2,
/// so that browser process is the one to exclude.
fn own_audio_root(table: &ProcessTable) -> u32 {
    let me = std::process::id();
    table
        .iter()
        .filter(|(_, (parent, exe))| *parent == me && exe.eq_ignore_ascii_case("msedgewebview2.exe"))
        .map(|(&pid, _)| pid)
        .min() // normally exactly one; min() keeps the choice stable
        .unwrap_or(me)
}

/// True if `pid` is this process or one of its descendants (e.g. our WebView2 processes).
fn in_own_tree(pid: u32, table: &ProcessTable) -> bool {
    let me = std::process::id();
    let mut current = pid;
    for _ in 0..32 {
        if current == me {
            return true;
        }
        match table.get(&current) {
            Some(&(parent, _)) if parent != 0 && parent != current => current = parent,
            _ => return false,
        }
    }
    false
}

// ---------- Queries ----------

pub fn window_process(hwnd: i64) -> Result<WindowProcess, String> {
    let hwnd = HWND(hwnd as *mut _);
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return Err("not a window".into());
    }
    let title = unsafe {
        let len = GetWindowTextLengthW(hwnd).max(0) as usize;
        let mut buf = vec![0u16; len + 1];
        let copied = GetWindowTextW(hwnd, &mut buf).max(0) as usize;
        String::from_utf16_lossy(&buf[..copied])
    };
    let table = process_table();
    Ok(WindowProcess {
        pid,
        root_pid: root_of(pid, &table),
        exe: table.get(&pid).map(|(_, exe)| exe.clone()).unwrap_or_default(),
        title,
    })
}

/// Apps with an audio session on the default playback device, one entry per root process.
pub fn list_audio_apps() -> Result<Vec<AudioApp>, String> {
    initialize_mta().ok().map_err(|e| e.to_string())?;
    let device = DeviceEnumerator::new()
        .and_then(|e| e.get_default_device(&Direction::Render))
        .map_err(|e| e.to_string())?;
    let sessions = device
        .get_iaudiosessionmanager()
        .and_then(|m| m.get_audiosessionenumerator())
        .map_err(|e| e.to_string())?;
    let table = process_table();

    let mut apps: Vec<AudioApp> = Vec::new();
    let mut by_root: HashMap<u32, usize> = HashMap::new();
    for i in 0..sessions.get_count().map_err(|e| e.to_string())? {
        let Ok(control) = sessions.get_session(i) else { continue };
        let active = match control.get_state() {
            Ok(SessionState::Active) => true,
            Ok(SessionState::Inactive) => false,
            _ => continue,
        };
        let Ok(pid) = control.get_process_id() else { continue };
        let Some((_, exe)) = table.get(&pid) else { continue };
        if pid == 0 || in_own_tree(pid, &table) || IGNORED_EXES.contains(&exe.to_ascii_lowercase().as_str()) {
            continue;
        }
        let root = root_of(pid, &table);
        match by_root.get(&root) {
            Some(&index) => apps[index].active |= active,
            None => {
                by_root.insert(root, apps.len());
                let display_name = control.get_display_name().ok().filter(|n| !n.is_empty() && !n.starts_with('@'));
                apps.push(AudioApp {
                    pid: root,
                    display_name: display_name.unwrap_or_else(|| exe.trim_end_matches(".exe").to_string()),
                    exe: exe.clone(),
                    active,
                });
            }
        }
    }
    apps.sort_by(|a, b| b.active.cmp(&a.active).then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase())));
    Ok(apps)
}

// ---------- Capture ----------

type Sink = Box<dyn FnMut(&[f32]) + Send>;
type ErrorSink = Arc<dyn Fn(String) + Send + Sync>;
type SharedQueue = Arc<Mutex<VecDeque<f32>>>;

/// What a capture thread does with its samples.
enum Role {
    /// Secondary source: queue samples for the mixer.
    Feed(SharedQueue),
    /// First source: its audio clock drives mixing in the others and emitting chunks.
    Mix { others: Vec<SharedQueue>, sink: Sink },
}

pub struct Capture {
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

impl Capture {
    pub fn start(
        target: CaptureTarget,
        sink: impl FnMut(&[f32]) + Send + 'static,
        on_error: impl Fn(String) + Send + Sync + 'static,
    ) -> Result<(Capture, CaptureInfo), String> {
        // (pid, include_tree)
        let streams: Vec<(u32, bool)> = if target.exclude_self {
            vec![(own_audio_root(&process_table()), false)]
        } else {
            let mut seen = HashSet::new();
            target.include.iter().copied().filter(|pid| seen.insert(*pid)).map(|pid| (pid, true)).collect()
        };
        if streams.is_empty() {
            return Err("nothing to capture".into());
        }

        let stop = Arc::new(AtomicBool::new(false));
        let on_error: ErrorSink = Arc::new(on_error);
        let queues: Vec<SharedQueue> = (1..streams.len()).map(|_| SharedQueue::default()).collect();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

        let mut capture = Capture { stop: stop.clone(), threads: Vec::new() };
        let mut roles: Vec<Role> = vec![Role::Mix { others: queues.clone(), sink: Box::new(sink) }];
        roles.extend(queues.into_iter().map(Role::Feed));

        for ((pid, include), role) in streams.iter().copied().zip(roles) {
            let (stop, ready, on_error) = (stop.clone(), ready_tx.clone(), on_error.clone());
            let thread = std::thread::Builder::new()
                .name(format!("system-audio-{pid}"))
                .spawn(move || run_stream(pid, include, role, &stop, ready, on_error))
                .map_err(|e| e.to_string())?;
            capture.threads.push(thread);
        }
        drop(ready_tx);

        // Fail start() if any stream can't be opened (dropping `capture` stops the others).
        for _ in 0..streams.len() {
            match ready_rx.recv() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => return Err(error),
                Err(_) => return Err("capture thread exited during start".into()),
            }
        }

        let info = CaptureInfo { sample_rate: SAMPLE_RATE, channels: CHANNELS, chunk_frames: CHUNK_FRAMES, streams: streams.len() };
        Ok((capture, info))
    }
}

fn open_stream(pid: u32, include_tree: bool) -> Result<(AudioClient, AudioCaptureClient, Handle), String> {
    let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, CHANNELS as usize, None);
    let mut client = AudioClient::new_application_loopback_client(pid, include_tree)
        .map_err(|e| format!("can't capture process {pid}: {e}"))?;
    client
        .initialize_client(&format, &Direction::Capture, &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 })
        .map_err(|e| format!("can't start capture of process {pid}: {e}"))?;
    let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    client.start_stream().map_err(|e| e.to_string())?;
    Ok((client, capture, event))
}

fn run_stream(pid: u32, include_tree: bool, mut role: Role, stop: &AtomicBool, ready: mpsc::Sender<Result<(), String>>, on_error: ErrorSink) {
    if let Err(e) = initialize_mta().ok() {
        let _ = ready.send(Err(e.to_string()));
        return;
    }
    let (client, capture, event) = match open_stream(pid, include_tree) {
        Ok(stream) => stream,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let _ = ready.send(Ok(()));

    let mut raw: VecDeque<u8> = VecDeque::new();
    let mut pending: Vec<f32> = Vec::with_capacity(CHUNK_SAMPLES * 4);

    while !stop.load(Ordering::SeqCst) {
        if event.wait_for_event(100).is_err() {
            continue; // timeout: nothing captured this period
        }
        loop {
            match capture.get_next_packet_size() {
                Ok(Some(frames)) if frames > 0 => {
                    if let Err(e) = capture.read_from_device_to_deque(&mut raw) {
                        on_error(format!("capture of process {pid} failed: {e}"));
                        return;
                    }
                }
                Ok(_) => break,
                Err(e) => {
                    on_error(format!("capture of process {pid} failed: {e}"));
                    return;
                }
            }
        }

        let usable = raw.len() / 4 * 4;
        let bytes: Vec<u8> = raw.drain(..usable).collect();
        pending.extend(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));

        match &mut role {
            Role::Feed(queue) => {
                let mut queue = queue.lock().unwrap();
                queue.extend(pending.drain(..));
                let max = CHUNK_SAMPLES * MAX_QUEUED_CHUNKS;
                if queue.len() > max {
                    let excess = queue.len() - CHUNK_SAMPLES * 2; // drop back to 40 ms
                    queue.drain(..excess);
                }
            }
            Role::Mix { others, sink } => {
                while pending.len() >= CHUNK_SAMPLES {
                    let mut chunk: Vec<f32> = pending.drain(..CHUNK_SAMPLES).collect();
                    for queue in others.iter() {
                        let mut queue = queue.lock().unwrap();
                        let take = queue.len().min(CHUNK_SAMPLES);
                        for (out, s) in chunk.iter_mut().zip(queue.drain(..take)) {
                            *out += s;
                        }
                    }
                    if !others.is_empty() {
                        for s in &mut chunk {
                            *s = s.clamp(-1.0, 1.0);
                        }
                    }
                    sink(&chunk);
                }
            }
        }
    }
    let _ = client.stop_stream();
}

// ---------- Call microphone ----------

/// The call microphone: a plain WASAPI capture (unlike WebView2's, it doesn't put the laptop's
/// audio into "call mode"), cleaned by WebRTC's audio processing. The echo reference is a
/// loopback of everything this app plays, so the voices coming out of the speakers are removed
/// from the mic while the user's own music/games (not played by us) are left alone.
pub struct Mic {
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl Drop for Mic {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

impl Mic {
    pub fn start(
        options: MicOptions,
        sink: impl FnMut(&[f32]) + Send + 'static,
        on_error: impl Fn(String) + Send + Sync + 'static,
    ) -> Result<(Mic, MicInfo), String> {
        let stop = Arc::new(AtomicBool::new(false));
        let on_error: ErrorSink = Arc::new(on_error);
        let mut mic = Mic { stop: stop.clone(), threads: Vec::new() };

        // Echo reference: our own WebView2 process tree (all of the app's sound).
        let mut reference = None;
        if options.echo_cancellation {
            let queue = SharedQueue::default();
            let root = own_audio_root(&process_table());
            let (ready_tx, ready_rx) = mpsc::channel();
            let (stop, role, errors) = (stop.clone(), Role::Feed(queue.clone()), on_error.clone());
            mic.threads.push(
                std::thread::Builder::new()
                    .name("system-audio-echo-reference".into())
                    .spawn(move || run_stream(root, true, role, &stop, ready_tx, errors))
                    .map_err(|e| e.to_string())?,
            );
            match ready_rx.recv() {
                Ok(Ok(())) => reference = Some(queue),
                Ok(Err(error)) => log::warn!("no echo reference, echo cancellation disabled: {error}"),
                Err(_) => log::warn!("echo reference thread exited during start"),
            }
        }

        let echo_reference = reference.is_some();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();
        let mut sink: Sink = Box::new(sink);
        let thread_stop = stop.clone();
        mic.threads.push(
            std::thread::Builder::new()
                .name("system-audio-mic".into())
                .spawn(move || run_mic(reference, options.noise_suppression, options.auto_gain_control, &thread_stop, ready_tx, &mut sink, on_error))
                .map_err(|e| e.to_string())?,
        );
        let device = match ready_rx.recv() {
            Ok(Ok(device)) => device,
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err("microphone thread exited during start".into()),
        };

        let info = MicInfo { sample_rate: SAMPLE_RATE, channels: 1, chunk_frames: CHUNK_FRAMES, device, echo_reference };
        Ok((mic, info))
    }
}

fn open_default_mic() -> Result<(String, AudioClient, AudioCaptureClient, Handle), String> {
    let device = DeviceEnumerator::new()
        .and_then(|e| e.get_default_device(&Direction::Capture))
        .map_err(|e| format!("no microphone: {e}"))?;
    let name = device.get_friendlyname().unwrap_or_default();
    let mut client = device.get_iaudioclient().map_err(|e| e.to_string())?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, 1, None);
    client
        .initialize_client(&format, &Direction::Capture, &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 })
        .map_err(|e| format!("can't open the microphone: {e}"))?;
    let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    client.start_stream().map_err(|e| e.to_string())?;
    Ok((name, client, capture, event))
}

fn run_mic(
    reference: Option<SharedQueue>,
    noise_suppression: bool,
    auto_gain: bool,
    stop: &AtomicBool,
    ready: mpsc::Sender<Result<String, String>>,
    sink: &mut Sink,
    on_error: ErrorSink,
) {
    if let Err(e) = initialize_mta().ok() {
        let _ = ready.send(Err(e.to_string()));
        return;
    }
    let (name, client, capture, event) = match open_default_mic() {
        Ok(mic) => mic,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let Some(mut apm) = Apm::new(SAMPLE_RATE, 1, CHANNELS as usize, reference.is_some(), noise_suppression, auto_gain) else {
        let _ = ready.send(Err("couldn't start audio processing".into()));
        return;
    };
    let _ = ready.send(Ok(name));

    let (frame, render_frame) = (apm.capture_frame_len(), apm.render_frame_len());
    let mut raw: VecDeque<u8> = VecDeque::new();
    let mut pending: Vec<f32> = Vec::new();
    let mut out: Vec<f32> = Vec::with_capacity(CHUNK_FRAMES * 2);

    while !stop.load(Ordering::SeqCst) {
        if event.wait_for_event(100).is_err() {
            continue;
        }
        loop {
            match capture.get_next_packet_size() {
                Ok(Some(frames)) if frames > 0 => {
                    if let Err(e) = capture.read_from_device_to_deque(&mut raw) {
                        on_error(format!("microphone failed: {e}"));
                        return;
                    }
                }
                Ok(_) => break,
                Err(e) => {
                    on_error(format!("microphone failed: {e}"));
                    return;
                }
            }
        }
        let usable = raw.len() / 4 * 4;
        let bytes: Vec<u8> = raw.drain(..usable).collect();
        pending.extend(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));

        while pending.len() >= frame {
            // Feed the echo canceller everything we played since the last mic frame.
            if let Some(reference) = &reference {
                let mut queue = reference.lock().unwrap();
                while queue.len() >= render_frame {
                    let played: Vec<f32> = queue.drain(..render_frame).collect();
                    apm.process_render(&played);
                }
            }
            let mut samples: Vec<f32> = pending.drain(..frame).collect();
            apm.process_capture(&mut samples, 0); // AEC3 estimates the speaker->mic delay itself
            out.extend(samples);
            if out.len() >= CHUNK_FRAMES {
                let chunk: Vec<f32> = out.drain(..CHUNK_FRAMES).collect();
                sink(&chunk);
            }
        }
    }
    let _ = client.stop_stream();
}
