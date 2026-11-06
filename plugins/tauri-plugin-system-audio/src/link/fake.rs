//! A stand-in Jay-A for tests and `cargo run --example fake_jay_a --features fake-jay-a`: serves
//! the Jay Link and, once asked for the microphone, sends a 440 Hz tone (amplitude 0.3) every
//! 20 ms. It can stall, quit or speak another protocol, to test Jay-C's reserve.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::json;
use windows::Win32::Foundation::{ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows::Win32::System::Threading::WaitForSingleObject;
use windows::core::PCWSTR;

use super::{AUDIO, CHUNK, CONTROL, Frame, Frames, HELLO, PONG, PROTOCOL, Pipe, frame, json_frame, pipe_path};

#[derive(Clone, Debug)]
pub struct Options {
    /// The protocol it speaks; a client saying another one gets `{ error }`.
    pub protocol: u64,
    /// Stops sending anything this long after the microphone was asked for (a hung Jay-A)...
    pub stall_after: Option<Duration>,
    /// ...for this long (forever if none).
    pub stall_for: Option<Duration>,
    /// Closes the pipe and quits this long after a client connected (a Jay-A that quit or crashed).
    pub exit_after: Option<Duration>,
    /// Each chunk early or late by up to this much.
    pub jitter: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Options { protocol: PROTOCOL, stall_after: None, stall_for: None, exit_after: None, jitter: Duration::ZERO }
    }
}

pub struct FakeJayA {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl FakeJayA {
    /// Listens on `\\.\pipe\<name>` (already when this returns) and serves one client at a time.
    pub fn start(name: &str, options: Options) -> Result<FakeJayA, String> {
        let first = listen(name)?;
        let stop = Arc::new(AtomicBool::new(false));
        let (name, thread_stop) = (name.to_string(), stop.clone());
        let thread = std::thread::spawn(move || serve_all(first, &name, &options, &thread_stop));
        Ok(FakeJayA { stop, thread: Some(thread) })
    }

    /// Blocks until the fake quits (`exit_after`), or forever.
    pub fn wait(mut self) {
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for FakeJayA {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn listen(name: &str) -> Result<Pipe, String> {
    let path = pipe_path(name);
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(path.as_ptr()),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            64 * 1024,
            64 * 1024,
            0,
            None,
        )
    };
    if handle.is_invalid() {
        return Err(format!("can't create the pipe: {}", windows::core::Error::from_thread().message()));
    }
    Pipe::new(handle)
}

fn serve_all(mut pipe: Pipe, name: &str, options: &Options, stop: &AtomicBool) {
    loop {
        if !accept(&mut pipe, stop) || serve(&mut pipe, options, stop) || stop.load(Ordering::SeqCst) {
            return;
        }
        // A fresh instance for the next client (the old one closes as it is replaced).
        pipe = match listen(name) {
            Ok(next) => next,
            Err(_) => return,
        };
    }
}

/// Waits for a client; false = stopped.
fn accept(pipe: &mut Pipe, stop: &AtomicBool) -> bool {
    unsafe {
        match ConnectNamedPipe(pipe.handle, Some(&mut *pipe.read_ov)) {
            Ok(()) => return true,
            Err(e) if e.code() == ERROR_PIPE_CONNECTED.to_hresult() => return true,
            Err(e) if e.code() == ERROR_IO_PENDING.to_hresult() => {}
            Err(_) => return false,
        }
        let mut n = 0;
        loop {
            if WaitForSingleObject(pipe.read_ov.hEvent, 50) == WAIT_OBJECT_0 {
                return GetOverlappedResult(pipe.handle, &*pipe.read_ov, &mut n, false).is_ok();
            }
            if stop.load(Ordering::SeqCst) {
                let _ = CancelIoEx(pipe.handle, Some(&*pipe.read_ov));
                let _ = GetOverlappedResult(pipe.handle, &*pipe.read_ov, &mut n, true);
                return false;
            }
        }
    }
}

/// Serves one client until it leaves; true = the fake quits (`exit_after`).
fn serve(pipe: &mut Pipe, options: &Options, stop: &AtomicBool) -> bool {
    let connected = Instant::now();
    let mut frames = Frames::default();
    let mut mic_since: Option<Instant> = None;
    let (mut base, mut next) = (Instant::now(), Instant::now());
    let mut sample = 0u64;
    let mut seed = connected.elapsed().as_nanos() as u32 | 1;
    loop {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        if options.exit_after.is_some_and(|after| connected.elapsed() >= after) {
            return true;
        }
        let stalled = mic_since.is_some_and(|since| {
            let t = since.elapsed();
            options.stall_after.is_some_and(|after| t >= after && options.stall_for.is_none_or(|d| t < after + d))
        });
        let wait = next.saturating_duration_since(Instant::now()).min(Duration::from_millis(50));
        match pipe.read(wait) {
            Err(_) => return false, // the client left
            Ok(Some(bytes)) => frames.push(bytes),
            Ok(None) => {}
        }
        loop {
            let incoming = match frames.next() {
                Ok(Some(incoming)) => incoming,
                Ok(None) => break,
                Err(_) => return false,
            };
            if stalled {
                continue; // a hung Jay-A answers nothing
            }
            let reply = match incoming {
                Frame::Hello(hello) if hello["protocol"].as_u64() != Some(options.protocol) => {
                    let error = format!("protocol {} not supported (this Jay-A speaks {})", hello["protocol"], options.protocol);
                    let _ = pipe.write(&json_frame(HELLO, &json!({ "error": error })));
                    return false;
                }
                Frame::Hello(_) => {
                    let mut bytes = json_frame(
                        HELLO,
                        &json!({ "app": "jay-a", "version": "fake", "protocol": options.protocol, "sampleRate": 48000, "channels": 1, "frameMs": 20 }),
                    );
                    bytes.extend(json_frame(CONTROL, &json!({ "type": "state", "device": "Fake mic", "deviceId": "fake", "preset": "fake" })));
                    bytes
                }
                Frame::Control(message) => {
                    match message["type"].as_str() {
                        Some("start-mic") if mic_since.is_none() => {
                            mic_since = Some(Instant::now());
                            (base, next) = (Instant::now(), Instant::now());
                        }
                        Some("stop-mic") => mic_since = None,
                        _ => {}
                    }
                    continue;
                }
                Frame::Ping => frame(PONG, &[]),
                _ => continue,
            };
            if pipe.write(&reply).is_err() {
                return false;
            }
        }
        if mic_since.is_none() || Instant::now() < next {
            continue;
        }
        if !stalled {
            let tone: Vec<u8> = (0..CHUNK as u64)
                .map(|i| 0.3 * (std::f32::consts::TAU * 440.0 * ((sample + i) % 48_000) as f32 / 48_000.0).sin())
                .flat_map(|s| s.to_le_bytes())
                .collect();
            sample += CHUNK as u64;
            if pipe.write(&frame(AUDIO, &tone)).is_err() {
                return false;
            }
        }
        // The next chunk: 20 ms after the last one's ideal time, early or late by up to `jitter`,
        // never before now (a pipe keeps the order).
        base += Duration::from_millis(20);
        let jitter = options.jitter.as_micros() as i64;
        let offset = if jitter > 0 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed as i64 % (2 * jitter + 1)) - jitter
        } else {
            0
        };
        let ideal = if offset >= 0 { base + Duration::from_micros(offset as u64) } else { base - Duration::from_micros((-offset) as u64) };
        next = ideal.max(Instant::now());
    }
}
