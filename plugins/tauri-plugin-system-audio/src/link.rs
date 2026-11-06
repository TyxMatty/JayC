//! Jay Link client: Jay-C's end of the named pipe to Jay-A, the Jay line's audio app, which
//! captures and filters the microphone and sends the result here. The protocol is in Jay-A's
//! docs/ARQUITETURA.md (section 6); Jay-C's side is docs/JAY-A.md.
//!
//! Frames: opcode (u32 LE) + length (u32 LE) + payload. HELLO and CONTROL carry JSON objects,
//! AUDIO 960 mono f32 LE samples (20 ms at 48 kHz), PING/PONG nothing.
//!
//! The pipe uses overlapped I/O: on a synchronous handle, a pending read blocks every write.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING, ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE, HANDLE,
    WAIT_OBJECT_0,
};
use windows::Win32::Security::{EqualSid, GetTokenInformation, PSID, TOKEN_QUERY, TOKEN_USER, TokenUser};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, FILE_SHARE_MODE, OPEN_EXISTING, ReadFile, SECURITY_IDENTIFICATION,
    SECURITY_SQOS_PRESENT, WriteFile,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    WaitForSingleObject,
};
use windows::core::PCWSTR;

#[cfg(any(test, feature = "fake-jay-a"))]
pub mod fake;

/// The pipe Jay-A listens on: `\\.\pipe\jay-a-link`.
pub const PIPE: &str = "jay-a-link";
pub const PROTOCOL: u64 = 1;
/// Samples in one AUDIO frame.
pub const CHUNK: usize = 960;

const HELLO: u32 = 0;
const CONTROL: u32 = 1;
const AUDIO: u32 = 2;
const PING: u32 = 3;
const PONG: u32 = 4;
const MAX_MESSAGE: usize = 64 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(2);
const PING_EVERY: Duration = Duration::from_secs(5);
/// Jay-A pings every 5 s, so this long without any frame means it's gone.
const SILENCE_LIMIT: Duration = Duration::from_secs(10);
/// How long the link thread waits for data before looking at what it has to send.
const POLL: Duration = Duration::from_millis(50);
const WRITE_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug)]
pub enum LinkEvent {
    /// 20 ms of mono f32 at 48 kHz.
    Audio(Vec<f32>),
    /// A CONTROL message from Jay-A (`state`, `soundboard`, `error`).
    Control(Value),
    /// The link is over. Not sent when the `Link` is dropped.
    Closed(LinkEnd),
}

#[derive(Debug, Clone, PartialEq)]
pub enum LinkEnd {
    /// Nothing to talk to: Jay-A isn't running, is busy with another client, or the pipe isn't
    /// Jay-A's (another Windows user's).
    Unavailable(String),
    /// Jay-A speaks another protocol version (or refused ours).
    Incompatible(String),
    /// Jay-A quit, crashed, stopped answering or sent something invalid.
    Broken(String),
}

/// A connected Jay Link. Dropping it asks Jay-A to stop the microphone and closes the pipe.
pub struct Link {
    version: String,
    stop: Arc<AtomicBool>,
    outgoing: mpsc::Sender<Vec<u8>>,
    thread: Option<JoinHandle<()>>,
}

impl Link {
    /// Connects to `\\.\pipe\<pipe>`, sends `hello` and checks Jay-A's answer. Then a thread of its
    /// own hands what Jay-A sends to `on_event`, until the link ends or is dropped.
    pub fn connect(pipe: &str, hello: &Value, mut on_event: impl FnMut(LinkEvent) + Send + 'static) -> Result<Link, LinkEnd> {
        let mut pipe = open(pipe)?;
        pipe.write(&json_frame(HELLO, hello)).map_err(LinkEnd::Broken)?;
        let mut frames = Frames::default();
        let deadline = Instant::now() + HELLO_TIMEOUT;
        let reply = loop {
            match frames.next().map_err(LinkEnd::Broken)? {
                Some(Frame::Hello(reply)) => break reply,
                Some(_) => return Err(LinkEnd::Broken("Jay-A didn't start with HELLO".into())),
                None => {}
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(LinkEnd::Broken("no HELLO from Jay-A".into()));
            }
            if let Some(bytes) = pipe.read(left).map_err(LinkEnd::Broken)? {
                frames.push(bytes);
            }
        };
        let version = check_hello(&reply)?;

        let stop = Arc::new(AtomicBool::new(false));
        let (outgoing, queued) = mpsc::channel();
        let thread_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("system-audio-jay-a-link".into())
            .spawn(move || {
                if let Some(end) = run(pipe, frames, &thread_stop, &queued, &mut on_event) {
                    on_event(LinkEvent::Closed(end));
                }
            })
            .map_err(|e| LinkEnd::Broken(e.to_string()))?;
        Ok(Link { version, stop, outgoing, thread: Some(thread) })
    }

    /// Jay-A's version, from its HELLO.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// Sends a CONTROL message, e.g. `{ "type": "start-mic" }`. Dropped if the link is over.
    pub fn control(&self, message: &Value) {
        let _ = self.outgoing.send(json_frame(CONTROL, message));
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.control(&json!({ "type": "stop-mic" }));
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The link thread: sends what was queued, pings, and hands on what Jay-A sends. `None` = stopped.
fn run(
    mut pipe: Pipe,
    mut frames: Frames,
    stop: &AtomicBool,
    queued: &mpsc::Receiver<Vec<u8>>,
    on_event: &mut impl FnMut(LinkEvent),
) -> Option<LinkEnd> {
    let (mut heard, mut pinged) = (Instant::now(), Instant::now());
    loop {
        for bytes in queued.try_iter() {
            if let Err(e) = pipe.write(&bytes) {
                return Some(LinkEnd::Broken(e));
            }
        }
        if stop.load(Ordering::SeqCst) {
            return None;
        }
        if pinged.elapsed() >= PING_EVERY {
            if let Err(e) = pipe.write(&frame(PING, &[])) {
                return Some(LinkEnd::Broken(e));
            }
            pinged = Instant::now();
        }
        if heard.elapsed() >= SILENCE_LIMIT {
            return Some(LinkEnd::Broken("Jay-A stopped answering".into()));
        }
        match pipe.read(POLL) {
            Err(e) => return Some(LinkEnd::Broken(e)),
            Ok(None) => continue,
            Ok(Some(bytes)) => {
                frames.push(bytes);
                heard = Instant::now();
            }
        }
        loop {
            match frames.next() {
                Err(e) => return Some(LinkEnd::Broken(e)),
                Ok(None) => break,
                Ok(Some(Frame::Audio(samples))) => on_event(LinkEvent::Audio(samples)),
                Ok(Some(Frame::Control(message))) => on_event(LinkEvent::Control(message)),
                Ok(Some(Frame::Ping)) => {
                    if let Err(e) = pipe.write(&frame(PONG, &[])) {
                        return Some(LinkEnd::Broken(e));
                    }
                }
                Ok(Some(Frame::Pong)) => {}
                Ok(Some(Frame::Hello(_))) => return Some(LinkEnd::Broken("a second HELLO".into())),
            }
        }
    }
}

/// Jay-A's HELLO: its version, or why we can't talk.
fn check_hello(reply: &Value) -> Result<String, LinkEnd> {
    if let Some(error) = reply.get("error") {
        return Err(LinkEnd::Incompatible(error.as_str().unwrap_or("refused").to_string()));
    }
    if reply["protocol"].as_u64() != Some(PROTOCOL) {
        return Err(LinkEnd::Incompatible(format!("Jay-A speaks protocol {}", reply["protocol"])));
    }
    if reply["sampleRate"] != 48_000 || reply["channels"] != 1 || reply["frameMs"] != 20 {
        return Err(LinkEnd::Incompatible(format!("unexpected audio format: {reply}")));
    }
    Ok(reply["version"].as_str().unwrap_or("?").to_string())
}

// ---------- Frames ----------

#[derive(Debug, PartialEq)]
enum Frame {
    Hello(Value),
    Control(Value),
    Audio(Vec<f32>),
    Ping,
    Pong,
}

fn frame(op: u32, payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(8 + payload.len());
    bytes.extend_from_slice(&op.to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn json_frame(op: u32, value: &Value) -> Vec<u8> {
    frame(op, value.to_string().as_bytes())
}

/// Splits the byte stream from the pipe into frames. Errors (Jay-A is closed on any): an unknown
/// opcode, AUDIO of another size, a message over 64 KB (refused before it arrives), JSON that isn't
/// an object.
#[derive(Default)]
struct Frames {
    buf: Vec<u8>,
}

impl Frames {
    fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    fn next(&mut self) -> Result<Option<Frame>, String> {
        if self.buf.len() < 8 {
            return Ok(None);
        }
        let op = u32::from_le_bytes(self.buf[0..4].try_into().unwrap());
        let len = u32::from_le_bytes(self.buf[4..8].try_into().unwrap()) as usize;
        match op {
            AUDIO if len != CHUNK * 4 => return Err(format!("AUDIO of {len} bytes")),
            HELLO | CONTROL | PING | PONG if len > MAX_MESSAGE => return Err(format!("a message of {len} bytes")),
            HELLO | CONTROL | PING | PONG | AUDIO => {}
            _ => return Err(format!("unknown opcode {op}")),
        }
        if self.buf.len() < 8 + len {
            return Ok(None);
        }
        let payload: Vec<u8> = self.buf.drain(..8 + len).skip(8).collect();
        Ok(Some(match op {
            AUDIO => Frame::Audio(
                payload
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|&b| f32::from_le_bytes(b))
                    .map(|s| if s.is_finite() { s } else { 0.0 })
                    .collect(),
            ),
            PING => Frame::Ping,
            PONG => Frame::Pong,
            _ => {
                let value: Value = serde_json::from_slice(&payload).map_err(|e| format!("invalid JSON: {e}"))?;
                if !value.is_object() {
                    return Err("a message that isn't a JSON object".into());
                }
                if op == HELLO { Frame::Hello(value) } else { Frame::Control(value) }
            }
        }))
    }
}

// ---------- Pipe ----------

/// An overlapped pipe handle with one read that may stay pending between calls. The buffer and the
/// OVERLAPPED structs are boxed: Windows writes to them until the operation completes.
struct Pipe {
    handle: HANDLE,
    read_ov: Box<OVERLAPPED>,
    write_ov: Box<OVERLAPPED>,
    buf: Vec<u8>,
    reading: bool,
}

// The handle and its buffers move to the link thread together and are only used there.
unsafe impl Send for Pipe {}

impl Pipe {
    fn new(handle: HANDLE) -> Result<Pipe, String> {
        let mut pipe =
            Pipe { handle, read_ov: Box::default(), write_ov: Box::default(), buf: vec![0; MAX_MESSAGE], reading: false };
        let event = || unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.map_err(|e| e.message());
        pipe.read_ov.hEvent = event()?;
        pipe.write_ov.hEvent = event()?;
        Ok(pipe)
    }

    /// Waits up to `timeout` for bytes. `None` = nothing yet (the read stays pending).
    fn read(&mut self, timeout: Duration) -> Result<Option<&[u8]>, String> {
        unsafe {
            if !self.reading {
                match ReadFile(self.handle, Some(&mut self.buf), None, Some(&mut *self.read_ov)) {
                    Ok(()) => {}
                    Err(e) if e.code() == ERROR_IO_PENDING.to_hresult() => {}
                    Err(e) => return Err(e.message()),
                }
                self.reading = true;
            }
            if WaitForSingleObject(self.read_ov.hEvent, millis(timeout)) != WAIT_OBJECT_0 {
                return Ok(None);
            }
            self.reading = false;
            let mut n = 0;
            GetOverlappedResult(self.handle, &*self.read_ov, &mut n, false).map_err(|e| e.message())?;
            Ok(Some(&self.buf[..n as usize]))
        }
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        unsafe {
            match WriteFile(self.handle, Some(bytes), None, Some(&mut *self.write_ov)) {
                Ok(()) => {}
                Err(e) if e.code() == ERROR_IO_PENDING.to_hresult() => {}
                Err(e) => return Err(e.message()),
            }
            let mut n = 0;
            if WaitForSingleObject(self.write_ov.hEvent, millis(WRITE_TIMEOUT)) != WAIT_OBJECT_0 {
                // Wait for the cancel to land before `bytes` can be freed.
                let _ = CancelIoEx(self.handle, Some(&*self.write_ov));
                let _ = GetOverlappedResult(self.handle, &*self.write_ov, &mut n, true);
                return Err("Jay-A isn't reading".into());
            }
            GetOverlappedResult(self.handle, &*self.write_ov, &mut n, false).map_err(|e| e.message())?;
            if n as usize != bytes.len() {
                return Err(format!("wrote {n} of {} bytes", bytes.len()));
            }
            Ok(())
        }
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        unsafe {
            if self.reading {
                // Windows may still write into `buf`: cancel and wait before freeing it.
                let _ = CancelIoEx(self.handle, Some(&*self.read_ov));
                let mut n = 0;
                let _ = GetOverlappedResult(self.handle, &*self.read_ov, &mut n, true);
            }
            for handle in [self.handle, self.read_ov.hEvent, self.write_ov.hEvent] {
                if !handle.is_invalid() {
                    let _ = CloseHandle(handle);
                }
            }
        }
    }
}

fn millis(duration: Duration) -> u32 {
    duration.as_millis().min(u32::MAX as u128 - 1) as u32
}

fn pipe_path(name: &str) -> Vec<u16> {
    format!(r"\\.\pipe\{name}").encode_utf16().chain([0]).collect()
}

fn open(name: &str) -> Result<Pipe, LinkEnd> {
    let path = pipe_path(name);
    // SECURITY_IDENTIFICATION: whoever owns the pipe can identify us but not act as us.
    let handle = unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            (GENERIC_READ | GENERIC_WRITE).0,
            FILE_SHARE_MODE(0),
            None,
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            None,
        )
    }
    .map_err(|e| {
        LinkEnd::Unavailable(if e.code() == ERROR_FILE_NOT_FOUND.to_hresult() {
            "Jay-A isn't running".into()
        } else if e.code() == ERROR_PIPE_BUSY.to_hresult() {
            "Jay-A is busy with another client".into()
        } else {
            e.message()
        })
    })?;
    let pipe = Pipe::new(handle).map_err(LinkEnd::Unavailable)?;
    // Pipe names are global to the PC: another Windows user could create this one before Jay-A
    // starts and feed audio into our call.
    if !server_is_same_user(handle) {
        return Err(LinkEnd::Unavailable("the pipe belongs to another Windows user".into()));
    }
    Ok(pipe)
}

/// Whether the process serving `pipe` runs as the same Windows user as us. Unknown = no.
fn server_is_same_user(pipe: HANDLE) -> bool {
    unsafe {
        let mut pid = 0;
        if GetNamedPipeServerProcessId(pipe, &mut pid).is_err() {
            return false;
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let theirs = token_user(process);
        let _ = CloseHandle(process);
        match (theirs, token_user(GetCurrentProcess())) {
            (Some(theirs), Some(ours)) => EqualSid(sid(&theirs), sid(&ours)).is_ok(),
            _ => false,
        }
    }
}

/// A process's TOKEN_USER, in a buffer aligned for it.
unsafe fn token_user(process: HANDLE) -> Option<Vec<u64>> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        let read = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), len, &mut len);
        let _ = CloseHandle(token);
        read.ok().map(|_| buf)
    }
}

fn sid(token_user: &[u64]) -> PSID {
    unsafe { (*token_user.as_ptr().cast::<TOKEN_USER>()).User.Sid }
}

#[cfg(test)]
mod tests {
    use super::fake::{FakeJayA, Options};
    use super::*;

    fn audio_bytes(samples: &[f32]) -> Vec<u8> {
        frame(AUDIO, &samples.iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<u8>>())
    }

    #[test]
    fn frames_split_a_stream_cut_anywhere() {
        let mut stream = json_frame(HELLO, &json!({ "protocol": 1 }));
        stream.extend(audio_bytes(&[0.25; CHUNK]));
        stream.extend(frame(PING, &[]));
        stream.extend(json_frame(CONTROL, &json!({ "type": "state" })));
        let mut frames = Frames::default();
        let mut out = Vec::new();
        for piece in stream.chunks(7) {
            frames.push(piece);
            while let Some(frame) = frames.next().unwrap() {
                out.push(frame);
            }
        }
        assert_eq!(
            out,
            vec![
                Frame::Hello(json!({ "protocol": 1 })),
                Frame::Audio(vec![0.25; CHUNK]),
                Frame::Ping,
                Frame::Control(json!({ "type": "state" })),
            ]
        );
    }

    #[test]
    fn frames_refuse_what_jay_a_must_not_send() {
        let error = |bytes: Vec<u8>| {
            let mut frames = Frames::default();
            frames.push(&bytes);
            frames.next().unwrap_err()
        };
        assert_eq!(error(frame(AUDIO, &[0; 100])), "AUDIO of 100 bytes");
        assert_eq!(error(frame(9, &[])), "unknown opcode 9");
        assert!(error(json_frame(CONTROL, &json!([1, 2]))).contains("JSON object"));
        assert!(error(frame(CONTROL, b"{nope")).starts_with("invalid JSON"));
        // A huge length is refused from the header alone, before waiting for its bytes.
        let mut header = CONTROL.to_le_bytes().to_vec();
        header.extend_from_slice(&(MAX_MESSAGE as u32 + 1).to_le_bytes());
        assert_eq!(error(header), "a message of 65537 bytes");
    }

    #[test]
    fn audio_that_isnt_a_number_becomes_silence() {
        let mut samples = vec![0.5; CHUNK];
        samples[1] = f32::NAN;
        samples[2] = f32::INFINITY;
        let mut frames = Frames::default();
        frames.push(&audio_bytes(&samples));
        let Some(Frame::Audio(out)) = frames.next().unwrap() else { panic!() };
        assert_eq!(&out[..4], &[0.5, 0.0, 0.0, 0.5]);
    }

    #[test]
    fn hello_answers() {
        let good = json!({ "app": "jay-a", "version": "0.1.0", "protocol": 1, "sampleRate": 48000, "channels": 1, "frameMs": 20 });
        assert_eq!(check_hello(&good), Ok("0.1.0".into()));
        let mut other = good.clone();
        other["protocol"] = json!(2);
        assert!(matches!(check_hello(&other), Err(LinkEnd::Incompatible(_))));
        let mut stereo = good.clone();
        stereo["channels"] = json!(2);
        assert!(matches!(check_hello(&stereo), Err(LinkEnd::Incompatible(_))));
        assert_eq!(check_hello(&json!({ "error": "protocol 1 not supported" })), Err(LinkEnd::Incompatible("protocol 1 not supported".into())));
    }

    fn test_pipe(name: &str) -> String {
        format!("jay-a-link-test-{}-{name}", std::process::id())
    }

    fn hello() -> Value {
        json!({ "app": "jay-c", "version": "test", "protocol": 1 })
    }

    fn connect(pipe: &str) -> (Link, mpsc::Receiver<(Instant, LinkEvent)>) {
        let (tx, rx) = mpsc::channel();
        let link = Link::connect(pipe, &hello(), move |event| {
            let _ = tx.send((Instant::now(), event));
        })
        .expect("connect");
        (link, rx)
    }

    #[test]
    fn nothing_listening_is_unavailable() {
        let result = Link::connect(&test_pipe("nobody"), &hello(), |_| {});
        assert!(matches!(result, Err(LinkEnd::Unavailable(ref m)) if m == "Jay-A isn't running"), "{:?}", result.err());
    }

    #[test]
    fn streams_the_fake_tone_and_its_state() {
        let pipe = test_pipe("tone");
        let _fake = FakeJayA::start(&pipe, Options::default()).unwrap();
        let (link, events) = connect(&pipe);
        assert_eq!(link.version(), "fake");
        link.control(&json!({ "type": "start-mic" }));
        let mut chunks = Vec::new();
        let mut state = None;
        let end = Instant::now() + Duration::from_millis(700);
        while let Ok((_, event)) = events.recv_timeout(end.saturating_duration_since(Instant::now())) {
            match event {
                LinkEvent::Audio(samples) => chunks.push(samples),
                LinkEvent::Control(message) => state = Some(message),
                LinkEvent::Closed(end) => panic!("closed: {end:?}"),
            }
        }
        assert_eq!(state.unwrap()["deviceId"], "fake");
        assert!(chunks.len() >= 25, "{} chunks in 700 ms", chunks.len());
        let samples: Vec<f32> = chunks.concat();
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
        assert!((rms - 0.3 / 2f32.sqrt()).abs() < 0.01, "the fake's tone, rms {rms}");
    }

    #[test]
    fn t3_a_jay_a_that_quits_is_noticed_at_once() {
        let pipe = test_pipe("quits");
        let _fake = FakeJayA::start(&pipe, Options { exit_after: Some(Duration::from_millis(500)), ..Options::default() }).unwrap();
        let (link, events) = connect(&pipe);
        link.control(&json!({ "type": "start-mic" }));
        let mut last_audio = None;
        let closed = loop {
            match events.recv_timeout(Duration::from_secs(3)).expect("an event") {
                (at, LinkEvent::Audio(_)) => last_audio = Some(at),
                (at, LinkEvent::Closed(end)) => break (at, end),
                _ => {}
            }
        };
        assert!(matches!(closed.1, LinkEnd::Broken(_)), "{:?}", closed.1);
        let after = closed.0 - last_audio.expect("audio before the end");
        println!("the link noticed {} ms after the last chunk", after.as_millis());
        assert!(after < Duration::from_millis(20), "before the next chunk was due ({after:?})");
    }

    #[test]
    fn the_fake_serves_the_next_client_after_one_leaves() {
        let pipe = test_pipe("again");
        let _fake = FakeJayA::start(&pipe, Options::default()).unwrap();
        for _ in 0..3 {
            let (link, _) = connect(&pipe);
            drop(link);
            std::thread::sleep(Duration::from_millis(100)); // the fake notices and listens again
        }
    }

    #[test]
    fn t5_another_protocol_is_incompatible() {
        let pipe = test_pipe("protocol");
        let _fake = FakeJayA::start(&pipe, Options { protocol: 2, ..Options::default() }).unwrap();
        let result = Link::connect(&pipe, &hello(), |_| {});
        assert!(matches!(result, Err(LinkEnd::Incompatible(ref m)) if m.contains("protocol")), "{:?}", result.err());
    }
}
