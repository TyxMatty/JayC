//! Windows implementation: WASAPI process loopback (one stream per process tree; several are
//! mixed on a 20 ms clock of their own), delivered in 20 ms stereo f32 chunks.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
    let table = process_table();
    let sessions: Vec<u32> = audio_sessions(&table)?.into_iter().map(|(pid, _, _)| pid).collect();
    Ok(capture_roots(&sessions, &table, exclude_exes, std::process::id()))
}

/// Picks the trees to capture for the processes playing sound (`sessions`), leaving out `me` and
/// `exclude_exes`. An INCLUDE capture takes a process's whole tree, so a tree that holds `me` or an
/// excluded app is off-limits: a session there is captured from a lower root, or not at all (e.g.
/// explorer.exe, or a launcher whose child is excluded) rather than leak what must stay out.
fn capture_roots(sessions: &[u32], table: &ProcessTable, exclude_exes: &[String], me: u32) -> Vec<u32> {
    let off_limits: HashSet<u32> = table
        .iter()
        .filter(|(pid, (_, exe))| **pid == me || exclude_exes.iter().any(|name| same_exe(exe, name)))
        .flat_map(|(&pid, _)| lineage(pid, table))
        .collect();
    let mut roots: Vec<u32> = Vec::new();
    for &pid in sessions {
        let Some((_, exe)) = table.get(&pid) else { continue };
        if is_excluded(pid, table, exclude_exes) {
            continue;
        }
        // Like `root_of`: up through parents running the same executable, while still allowed.
        let root = lineage(pid, table)
            .take_while(|p| !off_limits.contains(p) && table.get(p).is_some_and(|(_, e)| e.eq_ignore_ascii_case(exe)))
            .last();
        match root {
            Some(root) if !roots.contains(&root) => roots.push(root),
            Some(_) => {}
            None => log::debug!("system-audio: not capturing {exe} ({pid}): its tree holds an excluded app or Jay-C"),
        }
    }
    // A root inside another root's tree is already captured with it; capturing both doubles it.
    roots.iter().copied().filter(|&pid| !lineage(pid, table).skip(1).any(|p| roots.contains(&p))).collect()
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

/// Processes with an audio session on the default playback device, other than ours and system
/// ones: (pid, playing right now, session display name). Must run on an MTA thread.
fn audio_sessions(table: &ProcessTable) -> Result<Vec<(u32, bool, Option<String>)>, String> {
    initialize_mta().ok().map_err(|e| e.to_string())?;
    let device = DeviceEnumerator::new()
        .and_then(|e| e.get_default_device(&Direction::Render))
        .map_err(|e| e.to_string())?;
    let sessions = device
        .get_iaudiosessionmanager()
        .and_then(|m| m.get_audiosessionenumerator())
        .map_err(|e| e.to_string())?;
    let mut found = Vec::new();
    for i in 0..sessions.get_count().map_err(|e| e.to_string())? {
        let Ok(control) = sessions.get_session(i) else { continue };
        let active = match control.get_state() {
            Ok(SessionState::Active) => true,
            Ok(SessionState::Inactive) => false,
            _ => continue,
        };
        let Ok(pid) = control.get_process_id() else { continue };
        let Some((_, exe)) = table.get(&pid) else { continue };
        if pid == 0 || in_own_tree(pid, table) || IGNORED_EXES.contains(&exe.to_ascii_lowercase().as_str()) {
            continue;
        }
        let display_name = control.get_display_name().ok().filter(|n| !n.is_empty() && !n.starts_with('@'));
        found.push((pid, active, display_name));
    }
    Ok(found)
}

/// Apps with an audio session on the default playback device, one entry per root process.
pub fn list_audio_apps() -> Result<Vec<AudioApp>, String> {
    let table = process_table();
    let mut apps: Vec<AudioApp> = Vec::new();
    let mut by_root: HashMap<u32, usize> = HashMap::new();
    for (pid, active, display_name) in audio_sessions(&table)? {
        let exe = &table[&pid].1;
        let root = root_of(pid, &table);
        match by_root.get(&root) {
            Some(&index) => apps[index].active |= active,
            None => {
                by_root.insert(root, apps.len());
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

/// A source of the mixer. `primed`: it had enough queued to start being read (see `run_mixer`).
struct MixInput {
    queue: SharedQueue,
    primed: bool,
}

/// The mixer's sources; the per-app capture adds and removes them while it runs.
type MixInputs = Arc<Mutex<Vec<MixInput>>>;

/// How often the per-app capture re-checks which apps have audio sessions.
const APPS_RECHECK: Duration = Duration::from_secs(2);

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
    /// Per-app capture: how many app streams are open right now.
    apps: Arc<AtomicUsize>,
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
        let stop = Arc::new(AtomicBool::new(false));
        let mut capture = Capture { stop: stop.clone(), threads: Vec::new(), apps: Arc::default() };
        let info = |streams| CaptureInfo { sample_rate: SAMPLE_RATE, channels: CHANNELS, chunk_frames: CHUNK_FRAMES, streams };

        if target.exclude_self && !target.exclude_exes.is_empty() {
            let inputs = MixInputs::default();
            capture.threads.push(spawn_mixer(inputs.clone(), Box::new(sink), stop.clone())?);
            let (ready_tx, ready_rx) = mpsc::channel();
            let (stop, apps, exclude_exes) = (stop.clone(), capture.apps.clone(), target.exclude_exes);
            capture.threads.push(
                std::thread::Builder::new()
                    .name("system-audio-apps".into())
                    .spawn(move || run_apps(exclude_exes, inputs, &stop, ready_tx, &apps))
                    .map_err(|e| e.to_string())?,
            );
            let opened = ready_rx.recv().map_err(|_| "capture thread exited during start".to_string())??;
            return Ok((capture, info(opened)));
        }

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

        let on_error: ErrorSink = Arc::new(on_error);
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

        let roles: Vec<Role> = if streams.len() == 1 {
            vec![Role::Emit(Box::new(sink))]
        } else {
            let queues: Vec<SharedQueue> = streams.iter().map(|_| SharedQueue::default()).collect();
            let inputs = queues.iter().map(|queue| MixInput { queue: queue.clone(), primed: false }).collect();
            capture.threads.push(spawn_mixer(Arc::new(Mutex::new(inputs)), Box::new(sink), stop.clone())?);
            queues.into_iter().map(Role::Feed).collect()
        };

        for ((pid, include), role) in streams.iter().copied().zip(roles) {
            capture.threads.push(spawn_stream(pid, include, role, stop.clone(), ready_tx.clone(), on_error.clone())?);
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
        Ok((capture, info(streams.len())))
    }

    #[cfg(test)]
    fn app_streams(&self) -> usize {
        self.apps.load(Ordering::SeqCst)
    }
}

fn spawn_stream(
    pid: u32,
    include_tree: bool,
    role: Role,
    stop: Arc<AtomicBool>,
    ready: mpsc::Sender<Result<(), String>>,
    on_error: ErrorSink,
) -> Result<JoinHandle<()>, String> {
    std::thread::Builder::new()
        .name(format!("system-audio-{pid}"))
        .spawn(move || run_stream(pid, include_tree, role, &stop, ready, on_error))
        .map_err(|e| e.to_string())
}

fn spawn_mixer(inputs: MixInputs, sink: Sink, stop: Arc<AtomicBool>) -> Result<JoinHandle<()>, String> {
    std::thread::Builder::new()
        .name("system-audio-mixer".into())
        .spawn(move || run_mixer(inputs, sink, &stop))
        .map_err(|e| e.to_string())
}

/// "Everything except us and `exclude_exes`": keeps one INCLUDE stream per app with an audio
/// session, re-checking every `APPS_RECHECK` so apps that start or quit during the share are
/// added or dropped. Reports the first round's stream count (or listing error) on `ready`.
fn run_apps(
    exclude_exes: Vec<String>,
    inputs: MixInputs,
    stop: &AtomicBool,
    ready: mpsc::Sender<Result<usize, String>>,
    apps: &AtomicUsize,
) {
    struct AppStream {
        stop: Arc<AtomicBool>,
        thread: JoinHandle<()>,
        queue: SharedQueue,
    }
    if let Err(e) = initialize_mta().ok() {
        let _ = ready.send(Err(e.to_string()));
        return;
    }
    // One app's stream failing (e.g. it quit) must not stop the share's sound: only log it.
    let log_error: ErrorSink = Arc::new(|error| log::warn!("system-audio: {error}"));
    let mut running: HashMap<u32, AppStream> = HashMap::new();
    let mut failed: HashSet<u32> = HashSet::new(); // don't retry (and re-log) these every round
    let mut ready = Some(ready);

    while !stop.load(Ordering::SeqCst) {
        let roots = match included_roots(&exclude_exes) {
            Ok(roots) => roots,
            Err(error) => match ready.take() {
                Some(ready) => {
                    let _ = ready.send(Err(error));
                    return;
                }
                None => {
                    log::warn!("system-audio: can't list audio apps: {error}");
                    Vec::from_iter(running.keys().copied()) // keep what's running
                }
            },
        };

        let gone: Vec<u32> = running.keys().copied().filter(|pid| !roots.contains(pid)).collect();
        for pid in gone {
            let app = running.remove(&pid).unwrap();
            app.stop.store(true, Ordering::SeqCst);
            let _ = app.thread.join();
            inputs.lock().unwrap().retain(|input| !Arc::ptr_eq(&input.queue, &app.queue));
        }
        failed.retain(|pid| roots.contains(pid));
        for pid in roots {
            if running.contains_key(&pid) || failed.contains(&pid) {
                continue;
            }
            let (queue, app_stop) = (SharedQueue::default(), Arc::new(AtomicBool::new(false)));
            let (opened_tx, opened_rx) = mpsc::channel();
            let Ok(thread) = spawn_stream(pid, true, Role::Feed(queue.clone()), app_stop.clone(), opened_tx, log_error.clone()) else {
                continue;
            };
            match opened_rx.recv() {
                Ok(Ok(())) => {
                    inputs.lock().unwrap().push(MixInput { queue: queue.clone(), primed: false });
                    running.insert(pid, AppStream { stop: app_stop, thread, queue });
                }
                result => {
                    log::warn!("system-audio: skipping process {pid}: {:?}", result.map_err(|_| "thread exited"));
                    failed.insert(pid);
                    let _ = thread.join();
                }
            }
        }
        apps.store(running.len(), Ordering::SeqCst);
        if let Some(ready) = ready.take() {
            let _ = ready.send(Ok(running.len()));
        }

        let next = Instant::now() + APPS_RECHECK;
        while !stop.load(Ordering::SeqCst) && Instant::now() < next {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    for app in running.into_values() {
        app.stop.store(true, Ordering::SeqCst);
        let _ = app.thread.join();
    }
}

/// Mixes several sources on a steady 20 ms clock of its own, so it keeps going when any source
/// goes quiet (a silent process may deliver no packets) or its process quits.
fn run_mixer(inputs: MixInputs, mut sink: Sink, stop: &AtomicBool) {
    let period = Duration::from_secs_f64(CHUNK_FRAMES as f64 / SAMPLE_RATE as f64);
    let start = Instant::now();
    for tick in 1u32.. {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        // Deadlines from a fixed start, so sleep overshoot doesn't accumulate.
        if let Some(wait) = (start + period * tick).checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
        let mut chunk = vec![0f32; CHUNK_SAMPLES];
        for input in inputs.lock().unwrap().iter_mut() {
            let mut queue = input.queue.lock().unwrap();
            // Read a source only once 40 ms are queued, so packet jitter doesn't cut its sound.
            if !input.primed && queue.len() < CHUNK_SAMPLES * 2 {
                continue;
            }
            let take = queue.len().min(CHUNK_SAMPLES);
            input.primed = take == CHUNK_SAMPLES;
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

    #[test]
    fn capture_roots_never_hold_us_or_an_excluded_app() {
        // 1 explorer (plays sound) -> 2 powershell -> 3 powershell (plays) and 4 jayc-tone-b (plays)
        // 1 -> 5 jay-c (us) -> 6 msedgewebview2;  1 -> 10 Discord -> 11 Discord (plays);  1 -> 20 brave (plays)
        let table: ProcessTable = [
            (1, (0, "explorer.exe")),
            (2, (1, "powershell.exe")),
            (3, (2, "powershell.exe")),
            (4, (2, "jayc-tone-b.exe")),
            (5, (1, "jay-c.exe")),
            (6, (5, "msedgewebview2.exe")),
            (10, (1, "Discord.exe")),
            (11, (10, "Discord.exe")),
            (20, (1, "brave.exe")),
        ]
        .into_iter()
        .map(|(pid, (parent, exe))| (pid, (parent, exe.to_string())))
        .collect();
        let sessions = [1, 3, 4, 11, 20];
        let excluding = |names: &[&str]| names.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        // explorer's tree holds us: never captured. powershell 3 is captured from its same-exe
        // parent 2, whose tree also holds tone-b (captured once, with it).
        assert_eq!(capture_roots(&sessions, &table, &excluding(&["nothing"]), 5), [2, 10, 20]);
        // tone-b excluded: 2's tree holds it, so powershell 3 is captured on its own.
        assert_eq!(capture_roots(&sessions, &table, &excluding(&["jayc-tone-b", "discord"]), 5), [3, 20]);
        // excluding powershell: tone-b (a child of an excluded app) is excluded too.
        assert_eq!(capture_roots(&sessions, &table, &excluding(&["powershell"]), 5), [10, 20]);
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

    /// A running per-app capture (`exclude_exes`) that collects everything it emits.
    fn start_capture(exclude_exes: &[&str]) -> (Capture, Arc<Mutex<Vec<f32>>>) {
        let collected = Arc::new(Mutex::new(Vec::new()));
        let sink = collected.clone();
        let target = CaptureTarget { include: vec![], exclude_self: true, exclude_exes: exclude_exes.iter().map(|s| s.to_string()).collect() };
        let (capture, _) = Capture::start(target, move |s: &[f32]| sink.lock().unwrap().extend_from_slice(s), |e| panic!("{e}")).unwrap();
        (capture, collected)
    }

    /// The last `seconds` of what a capture emitted.
    fn last(collected: &Mutex<Vec<f32>>, seconds: f64) -> Vec<f32> {
        let samples = collected.lock().unwrap();
        let n = ((seconds * SAMPLE_RATE as f64) as usize * 2).min(samples.len());
        samples[samples.len() - n..].to_vec()
    }

    fn powershell() -> std::path::PathBuf {
        std::path::Path::new(&std::env::var("WINDIR").unwrap()).join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
    }

    /// (dir, powershell.exe, its copy jayc-tone-b.exe, 500 Hz WAV, 1500 Hz WAV)
    fn tone_files() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join("jayc-exclusion-test");
        std::fs::create_dir_all(&dir).unwrap();
        let other = dir.join("jayc-tone-b.exe");
        std::fs::copy(powershell(), &other).unwrap();
        let (wav_a, wav_b) = (dir.join("a.wav"), dir.join("b.wav"));
        write_tone(&wav_a, 500.0);
        write_tone(&wav_b, 1500.0);
        (dir, powershell(), other, wav_a, wav_b)
    }

    fn play_script(wav: &std::path::Path) -> String {
        format!("(New-Object Media.SoundPlayer '{}').PlaySync()", wav.display())
    }

    /// Plays `wav` in `exe` (powershell or a copy). Started via `cmd /c start` so it's not our
    /// child: our own tree is never captured.
    fn play(exe: &std::path::Path, wav: &std::path::Path) {
        play_command(exe, &play_script(wav));
    }

    fn play_command(exe: &std::path::Path, script: &str) {
        std::process::Command::new("cmd").args(["/c", "start", "", "/min", exe.to_str().unwrap(), "-NoProfile", "-c", script]).status().unwrap();
    }

    /// Stops the players whose command line contains `pattern` (the tones would play for 30 s).
    fn stop_players(pattern: &std::path::Path) {
        let script = format!(
            "Get-CimInstance Win32_Process | ? {{ $_.CommandLine -like '*{}*' }} | % {{ Stop-Process -Id $_.ProcessId }}",
            pattern.display()
        );
        std::process::Command::new(powershell()).args(["-NoProfile", "-c", &script]).status().unwrap();
    }

    fn report(name: &str, s: &[f32]) -> (f64, f64) {
        let (a, b) = (tone_db(s, 500.0), tone_db(s, 1500.0));
        println!("{name}: 500 Hz {a:.1} dB, 1500 Hz {b:.1} dB");
        (a, b)
    }

    /// Live check with real audio, two tones from two different executables:
    /// - both start *after* the captures, so they're heard only if the re-check picks them up;
    /// - the capture excluding one of them must not contain it;
    /// - when a player quits, its stream is dropped and the mix goes on in real time.
    /// Plays sound on the default speakers for ~10 s.
    ///   cargo test --lib -- --ignored --nocapture exclusion_live
    #[test]
    #[ignore]
    fn exclusion_live() {
        let (dir, ps, other, wav_a, wav_b) = tone_files();

        let (all, all_samples) = start_capture(&["jayc-nothing.exe"]);
        let (excluded, excluded_samples) = start_capture(&["jayc-tone-b"]);
        let before = excluded.app_streams();
        println!("app streams before the players: {before}");

        play(&ps, &wav_a);
        play(&other, &wav_b);
        std::thread::sleep(APPS_RECHECK * 2 + Duration::from_secs(1));
        println!("app streams with the players: all {}, excluded {}", all.app_streams(), excluded.app_streams());
        let (all_a, all_b) = report("no exclusions, last 1 s", &last(&all_samples, 1.0));
        let (ex_a, ex_b) = report("jayc-tone-b excluded, last 1 s", &last(&excluded_samples, 1.0));
        let with_players = excluded.app_streams();

        stop_players(&wav_a);
        let (emitted, since) = (excluded_samples.lock().unwrap().len(), Instant::now());
        std::thread::sleep(APPS_RECHECK + Duration::from_secs(1));
        let rate = (excluded_samples.lock().unwrap().len() - emitted) as f64 / 2.0 / since.elapsed().as_secs_f64();
        let after_quit = excluded.app_streams();
        println!("after powershell quit: excluded {after_quit} app streams, mixer at {rate:.0} frames/s");
        stop_players(&dir);
        drop((all, excluded));

        assert!(all_a > -40.0 && all_b > -40.0, "both tones must be picked up without exclusions");
        assert!(ex_a > -40.0, "the other app must be picked up");
        assert!(ex_b < all_b - 40.0, "the excluded app must be left out");
        assert_eq!(with_players, before + 1, "one new app stream (the excluded one isn't opened)");
        assert_eq!(after_quit, before, "the quitting app's stream is dropped");
        assert!((rate - SAMPLE_RATE as f64).abs() < SAMPLE_RATE as f64 * 0.02, "the mix keeps real time");
    }

    /// Live check of an excluded app started by an app that plays sound: powershell (500 Hz)
    /// launches jayc-tone-b.exe (1500 Hz) as its child. Capturing powershell's tree would leak the
    /// excluded child, so with the exclusion neither is captured; without it, both are, once.
    ///   cargo test --lib -- --ignored --nocapture exclusion_live_nested
    #[test]
    #[ignore]
    fn exclusion_live_nested() {
        let (dir, ps, other, wav_a, wav_b) = tone_files();
        // The child's script goes in a file: nesting it in the parent's command line breaks the quoting.
        let child_script = dir.join("b.ps1");
        std::fs::write(&child_script, play_script(&wav_b)).unwrap();
        let child = format!(
            "Start-Process '{}' -WindowStyle Minimized -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}'; {}",
            other.display(),
            child_script.display(),
            play_script(&wav_a)
        );
        let (all, all_samples) = start_capture(&["jayc-nothing.exe"]);
        let (excluded, excluded_samples) = start_capture(&["jayc-tone-b"]);
        play_command(&ps, &child);
        std::thread::sleep(APPS_RECHECK * 2 + Duration::from_secs(1));
        let (all_a, all_b) = report("no exclusions, last 1 s", &last(&all_samples, 1.0));
        let (_, ex_b) = report("jayc-tone-b excluded, last 1 s", &last(&excluded_samples, 1.0));
        stop_players(&dir);
        drop((all, excluded));

        assert!(all_a > -20.0 && all_b > -20.0 && all_b < -13.0, "both tones, each once (doubled would be +6 dB)");
        assert!(ex_b < all_b - 40.0, "the excluded child must not leak through its parent's tree");
    }

    /// CPU cost of the per-app capture with many streams (10 players + whatever else plays),
    /// against the single EXCLUDE stream, both over 10 s with the players running. Run in release
    /// (JAYC_PLAYERS sets the number of players):
    ///   cargo test --release --lib -- --ignored --nocapture cpu_many_streams
    #[test]
    #[ignore]
    fn cpu_many_streams() {
        let (dir, ps, _, wav_a, _) = tone_files();
        // Our own CPU time, read from outside so the reading doesn't count.
        let cpu = || -> Duration {
            let script = format!("(Get-Process -Id {}).TotalProcessorTime.TotalMilliseconds", std::process::id());
            let out = std::process::Command::new(&ps).args(["-NoProfile", "-c", &script]).output().unwrap();
            Duration::from_secs_f64(String::from_utf8_lossy(&out.stdout).trim().replace(',', ".").parse::<f64>().unwrap() / 1000.0)
        };
        let cores = std::thread::available_parallelism().unwrap().get() as f64;
        let measure = |name: &str, exclude_exes: &[&str]| {
            let (capture, samples) = start_capture(exclude_exes);
            std::thread::sleep(APPS_RECHECK + Duration::from_secs(1)); // streams open and primed
            let (cpu0, t0, n0) = (cpu(), Instant::now(), samples.lock().unwrap().len());
            std::thread::sleep(Duration::from_secs(10));
            let (used, wall) = (cpu() - cpu0, t0.elapsed());
            let frames = (samples.lock().unwrap().len() - n0) as f64 / 2.0 / wall.as_secs_f64();
            let one_core = 100.0 * used.as_secs_f64() / wall.as_secs_f64();
            println!(
                "{name}: {} app streams, {one_core:.2}% of one core ({:.2}% of {cores} cores), {frames:.0} frames/s",
                capture.app_streams(),
                one_core / cores
            );
            drop(capture);
            one_core
        };

        let players: usize = std::env::var("JAYC_PLAYERS").ok().and_then(|n| n.parse().ok()).unwrap_or(10);
        for _ in 0..players {
            play(&ps, &wav_a);
        }
        std::thread::sleep(Duration::from_secs(3));
        let single = measure("single EXCLUDE stream", &[]);
        let per_app = measure("per app", &["jayc-nothing.exe"]);
        stop_players(&dir);
        println!("per app costs {:.2} points of one core more", per_app - single);
    }
}
