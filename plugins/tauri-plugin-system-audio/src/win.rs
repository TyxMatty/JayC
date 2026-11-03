//! Windows implementation: WASAPI process loopback (one stream per process tree; several are
//! mixed on a 20 ms clock of their own), delivered in 20 ms stereo f32 chunks.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

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
/// Queued sources keep at most this much audio (drift / hiccups), in chunks.
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

/// `pid` followed by its ancestors, nearest first.
fn lineage(pid: u32, table: &ProcessTable) -> impl Iterator<Item = u32> + '_ {
    std::iter::successors(Some(pid), move |current| {
        table.get(current).map(|&(parent, _)| parent).filter(|&parent| parent != 0 && parent != *current)
    })
    .take(32)
}

/// True if `pid` is this process or one of its descendants (e.g. our WebView2 processes).
fn in_own_tree(pid: u32, table: &ProcessTable) -> bool {
    let me = std::process::id();
    lineage(pid, table).any(|p| p == me)
}

/// "Discord.exe" matches "discord.exe" and "Discord".
fn same_exe(exe: &str, name: &str) -> bool {
    let base = |s: &str| {
        let s = s.trim().to_ascii_lowercase();
        s.strip_suffix(".exe").map(str::to_string).unwrap_or(s)
    };
    base(exe) == base(name)
}

/// True if `pid` or one of its ancestors runs an excluded executable (so e.g. the WebView2
/// helpers of an excluded app are excluded too).
fn is_excluded(pid: u32, table: &ProcessTable, exclude_exes: &[String]) -> bool {
    lineage(pid, table).any(|p| table.get(&p).is_some_and(|(_, exe)| exclude_exes.iter().any(|name| same_exe(exe, name))))
}

/// The process trees to capture for "everything except us and `exclude_exes`": one per app with
/// an audio session. Must run on an MTA thread (see `list_audio_apps`).
fn included_roots(exclude_exes: &[String]) -> Result<Vec<u32>, String> {
    let apps = list_audio_apps()?;
    let table = process_table();
    let roots: Vec<u32> = apps.iter().map(|app| app.pid).filter(|&pid| !is_excluded(pid, &table, exclude_exes)).collect();
    // A root inside another root's tree is already captured with it; capturing both doubles it.
    Ok(roots.iter().copied().filter(|&pid| !lineage(pid, &table).skip(1).any(|p| roots.contains(&p))).collect())
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
    /// One of several sources (or the echo reference): queue samples for a consumer.
    Feed(SharedQueue),
    /// The only source: emit chunks on its own audio clock, without added latency.
    Emit(Sink),
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
        // With exclusions, a stream that fails to open (e.g. the app just quit) is skipped.
        let per_app = target.exclude_self && !target.exclude_exes.is_empty();
        // (pid, include_tree)
        let streams: Vec<(u32, bool)> = if per_app {
            let exclude_exes = target.exclude_exes.clone();
            // COM must be MTA here; the caller's thread may be the (STA) main thread.
            let roots = std::thread::spawn(move || included_roots(&exclude_exes))
                .join()
                .map_err(|_| "audio session listing panicked".to_string())??;
            roots.into_iter().map(|pid| (pid, true)).collect()
        } else if target.exclude_self {
            vec![(own_audio_root(&process_table()), false)]
        } else {
            let mut seen = HashSet::new();
            target.include.iter().copied().filter(|pid| seen.insert(*pid)).map(|pid| (pid, true)).collect()
        };
        if streams.is_empty() && !per_app {
            return Err("nothing to capture".into());
        }

        let stop = Arc::new(AtomicBool::new(false));
        let on_error: ErrorSink = Arc::new(on_error);
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let mut capture = Capture { stop: stop.clone(), threads: Vec::new() };

        let roles: Vec<Role> = if streams.len() == 1 && !per_app {
            vec![Role::Emit(Box::new(sink))]
        } else {
            let queues: Vec<SharedQueue> = streams.iter().map(|_| SharedQueue::default()).collect();
            let (stop, sources, sink): (_, _, Sink) = (stop.clone(), queues.clone(), Box::new(sink));
            capture.threads.push(
                std::thread::Builder::new()
                    .name("system-audio-mixer".into())
                    .spawn(move || run_mixer(sources, sink, &stop))
                    .map_err(|e| e.to_string())?,
            );
            queues.into_iter().map(Role::Feed).collect()
        };

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
        let mut opened = 0;
        for _ in 0..streams.len() {
            match ready_rx.recv() {
                Ok(Ok(())) => opened += 1,
                Ok(Err(error)) if per_app => log::warn!("system-audio: skipping an app: {error}"),
                Ok(Err(error)) => return Err(error),
                Err(_) => return Err("capture thread exited during start".into()),
            }
        }

        let info = CaptureInfo { sample_rate: SAMPLE_RATE, channels: CHANNELS, chunk_frames: CHUNK_FRAMES, streams: opened };
        Ok((capture, info))
    }
}

/// Mixes several sources on a steady 20 ms clock of its own, so it keeps going when any source
/// goes quiet (a silent process may deliver no packets) or its process quits.
fn run_mixer(sources: Vec<SharedQueue>, mut sink: Sink, stop: &AtomicBool) {
    let period = Duration::from_secs_f64(CHUNK_FRAMES as f64 / SAMPLE_RATE as f64);
    let start = Instant::now();
    let mut primed = vec![false; sources.len()];
    for tick in 1u32.. {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        // Deadlines from a fixed start, so sleep overshoot doesn't accumulate.
        if let Some(wait) = (start + period * tick).checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
        let mut chunk = vec![0f32; CHUNK_SAMPLES];
        for (queue, primed) in sources.iter().zip(primed.iter_mut()) {
            let mut queue = queue.lock().unwrap();
            // Read a source only once 40 ms are queued, so packet jitter doesn't cut its sound.
            if !*primed && queue.len() < CHUNK_SAMPLES * 2 {
                continue;
            }
            let take = queue.len().min(CHUNK_SAMPLES);
            *primed = take == CHUNK_SAMPLES;
            for (out, s) in chunk.iter_mut().zip(queue.drain(..take)) {
                *out += s;
            }
        }
        for s in &mut chunk {
            *s = s.clamp(-1.0, 1.0);
        }
        sink(&chunk);
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
            Role::Emit(sink) => {
                while pending.len() >= CHUNK_SAMPLES {
                    let chunk: Vec<f32> = pending.drain(..CHUNK_SAMPLES).collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excludes_by_exe_or_ancestor() {
        // 1 explorer -> 10 Discord -> 11 Discord -> 12 msedgewebview2; 1 -> 20 brave
        let table: ProcessTable = [
            (1, (0, "explorer.exe")),
            (10, (1, "Discord.exe")),
            (11, (10, "Discord.exe")),
            (12, (11, "msedgewebview2.exe")),
            (20, (1, "brave.exe")),
        ]
        .into_iter()
        .map(|(pid, (parent, exe))| (pid, (parent, exe.to_string())))
        .collect();
        let exclude = vec!["discord".to_string()];
        assert!(is_excluded(11, &table, &exclude));
        assert!(is_excluded(12, &table, &exclude), "helper of an excluded app");
        assert!(!is_excluded(20, &table, &exclude));
        assert!(!is_excluded(1, &table, &exclude));
        assert!(same_exe("Discord.exe", " DISCORD.EXE "));
        assert!(!same_exe("Discord.exe", "DiscordPTB.exe"));
        assert_eq!(lineage(12, &table).collect::<Vec<_>>(), [12, 11, 10, 1]);
    }

    /// Writes a 30 s stereo 16-bit WAV of a sine at `hz`.
    fn write_tone(path: &std::path::Path, hz: f64) {
        let frames = SAMPLE_RATE as usize * 30;
        let mut data = Vec::with_capacity(frames * 4);
        for i in 0..frames {
            let s = ((2.0 * std::f64::consts::PI * hz * i as f64 / SAMPLE_RATE as f64).sin() * 0.3 * 32767.0) as i16;
            data.extend_from_slice(&s.to_le_bytes());
            data.extend_from_slice(&s.to_le_bytes());
        }
        let mut wav = Vec::new();
        for part in [&b"RIFF"[..], &(36 + data.len() as u32).to_le_bytes(), b"WAVEfmt ", &16u32.to_le_bytes(), &1u16.to_le_bytes(), &2u16.to_le_bytes()] {
            wav.extend_from_slice(part);
        }
        for part in [SAMPLE_RATE.to_le_bytes(), (SAMPLE_RATE * 4).to_le_bytes()] {
            wav.extend_from_slice(&part);
        }
        for part in [&4u16.to_le_bytes()[..], &16u16.to_le_bytes(), b"data", &(data.len() as u32).to_le_bytes(), &data] {
            wav.extend_from_slice(part);
        }
        std::fs::write(path, wav).unwrap();
    }

    /// Power of `hz` in the left channel (Goertzel), in dB.
    fn tone_db(samples: &[f32], hz: f64) -> f64 {
        let w = 2.0 * std::f64::consts::PI * hz / SAMPLE_RATE as f64;
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        let left: Vec<f64> = samples.iter().step_by(2).map(|&s| s as f64).collect();
        for &x in &left {
            let s = x + 2.0 * w.cos() * s1 - s2;
            s2 = s1;
            s1 = s;
        }
        let power = (s1 * s1 + s2 * s2 - 2.0 * w.cos() * s1 * s2) / (left.len() as f64).powi(2);
        10.0 * power.max(1e-12).log10()
    }

    fn capture_for(exclude_exes: &[&str], seconds: u64) -> (Vec<f32>, usize) {
        let collected = Arc::new(Mutex::new(Vec::new()));
        let sink = collected.clone();
        let target = CaptureTarget { include: vec![], exclude_self: true, exclude_exes: exclude_exes.iter().map(|s| s.to_string()).collect() };
        let (capture, info) =
            Capture::start(target, move |s: &[f32]| sink.lock().unwrap().extend_from_slice(s), |e| panic!("{e}")).unwrap();
        std::thread::sleep(Duration::from_secs(seconds));
        drop(capture);
        let samples = collected.lock().unwrap().clone();
        (samples, info.streams)
    }

    /// Live check with real audio: two tones from two different executables, one of them excluded.
    /// Plays sound on the default speakers for ~10 s.
    ///   cargo test --lib -- --ignored --nocapture exclusion_live
    #[test]
    #[ignore]
    fn exclusion_live() {
        let dir = std::env::temp_dir().join("jayc-exclusion-test");
        std::fs::create_dir_all(&dir).unwrap();
        let ps = std::path::Path::new(&std::env::var("WINDIR").unwrap()).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let other = dir.join("jayc-tone-b.exe");
        std::fs::copy(&ps, &other).unwrap();
        let (wav_a, wav_b) = (dir.join("a.wav"), dir.join("b.wav"));
        write_tone(&wav_a, 500.0);
        write_tone(&wav_b, 1500.0);
        // Started via `cmd /c start` so they're not our children: our own tree is never captured.
        let play = |exe: &std::path::Path, wav: &std::path::Path| {
            let script = format!("(New-Object Media.SoundPlayer '{}').PlaySync()", wav.display());
            let exe = exe.to_str().unwrap();
            std::process::Command::new("cmd").args(["/c", "start", "", "/min", exe, "-NoProfile", "-c", &script]).status().unwrap();
        };
        play(&ps, &wav_a);
        play(&other, &wav_b);
        std::thread::sleep(Duration::from_secs(3)); // let both audio sessions start
        for app in std::thread::spawn(list_audio_apps).join().unwrap().unwrap() {
            println!("app: {} {} active={}", app.pid, app.exe, app.active);
        }

        let (all, all_streams) = capture_for(&["jayc-nothing.exe"], 3);
        let (excluded, excluded_streams) = capture_for(&["jayc-tone-b"], 3);
        // Stop the players (the tones would play for 30 s); matched by their WAV path.
        let stop = format!(
            "Get-CimInstance Win32_Process | ? {{ $_.CommandLine -like '*{}*' }} | % {{ Stop-Process -Id $_.ProcessId }}",
            dir.display()
        );
        std::process::Command::new(&ps).args(["-NoProfile", "-c", &stop]).status().unwrap();

        let report = |name: &str, s: &[f32], streams: usize| {
            let (a, b) = (tone_db(s, 500.0), tone_db(s, 1500.0));
            println!("{name}: {streams} streams, {:.2} s, 500 Hz {a:.1} dB, 1500 Hz {b:.1} dB", s.len() as f64 / 2.0 / SAMPLE_RATE as f64);
            (a, b)
        };
        let (all_a, all_b) = report("no exclusions", &all, all_streams);
        let (ex_a, ex_b) = report("jayc-tone-b excluded", &excluded, excluded_streams);
        assert!(all_a > -40.0 && all_b > -40.0, "both tones must be audible without exclusions");
        assert!(ex_a > -40.0, "the other app must still be captured");
        assert!(ex_b < all_b - 40.0, "the excluded app must be gone");
    }
}
