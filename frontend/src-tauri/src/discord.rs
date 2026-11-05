//! Discord Rich Presence: the call shows on the user's Discord profile. Talks to the Discord app on
//! this PC over its local IPC pipe (`\\.\pipe\discord-ipc-N`), in frames of opcode (u32 LE) +
//! length (u32 LE) + JSON. Nothing happens while Discord isn't running; it gets the status once it
//! starts. The page decides what the status says (core/discord-presence.js).

use std::fs::File;
use std::io::{self, Read, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The "Jay-C" application on the Discord Developer Portal: names the status and holds its images.
/// Public (every client sends it). Empty: Rich Presence stays off.
const CLIENT_ID: &str = "";
/// Discord is documented to take about 5 status changes per 20 s (not measured): changes in between
/// wait, and only the latest goes.
const MIN_GAP: Duration = Duration::from_secs(4);
/// While a status is set it is sent again this often, so a restarted Discord gets it back.
const REFRESH: Duration = Duration::from_secs(15);
/// Discord not running (or refusing): try again this often while a status is wanted.
const RETRY: Duration = Duration::from_secs(10);

const HANDSHAKE: u32 = 0;
const FRAME: u32 = 1;
const CLOSE: u32 = 2;
const PING: u32 = 3;
const PONG: u32 = 4;

static WORKER: OnceLock<Sender<Value>> = OnceLock::new();

/// Sets Jay-C's Discord status (`activity`: Discord's activity object; null clears it). Returns at
/// once: a thread talks to Discord.
#[tauri::command]
pub fn discord_presence(activity: Value) {
    if CLIENT_ID.is_empty() {
        return;
    }
    let worker = WORKER.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        let _ = std::thread::Builder::new().name("discord".into()).spawn(move || worker(CLIENT_ID, rx));
        tx
    });
    let _ = worker.send(activity);
}

fn worker(client_id: &str, wanted_rx: Receiver<Value>) {
    let mut wanted = Value::Null;
    let mut connection: Option<Connection> = None;
    let mut last_send: Option<Instant> = None;
    // When to send `wanted` (again); None = nothing to do until the page changes it.
    let mut due: Option<Instant> = None;
    loop {
        let timeout = due.map_or(Duration::from_secs(3600), |at| at.saturating_duration_since(Instant::now()));
        match wanted_rx.recv_timeout(timeout) {
            Ok(next) => {
                wanted = next;
                let now = Instant::now();
                due = Some(last_send.map_or(now, |at| (at + MIN_GAP).max(now)));
                continue;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if due.is_none_or(|at| at > Instant::now()) {
            continue;
        }
        due = None;
        let Some(conn) = connection.as_mut() else {
            if wanted.is_null() {
                continue; // no pipe, no status to clear
            }
            match Connection::open(client_id) {
                Ok(conn) => {
                    log::info!("discord: connected");
                    connection = Some(conn);
                    due = Some(Instant::now());
                }
                Err(error) => {
                    log::debug!("discord: {error}");
                    due = Some(Instant::now() + RETRY);
                }
            }
            continue;
        };
        last_send = Some(Instant::now());
        match conn.set_activity(&wanted) {
            Ok(_) if wanted.is_null() => {}
            Ok(_) => due = Some(Instant::now() + REFRESH),
            Err(error) => {
                // Discord closed or restarted: reconnect right away (or retry later if it's gone).
                log::info!("discord: {error}");
                connection = None;
                due = Some(Instant::now());
            }
        }
    }
}

struct Connection {
    pipe: File,
    nonce: u64,
}

impl Connection {
    /// Opens Discord's pipe and identifies as the `client_id` application.
    fn open(client_id: &str) -> Result<Self, String> {
        let pipe = (0..10)
            .find_map(|i| File::options().read(true).write(true).open(format!(r"\\.\pipe\discord-ipc-{i}")).ok())
            .ok_or("Discord isn't running")?;
        let mut conn = Connection { pipe, nonce: 0 };
        conn.send(HANDSHAKE, &json!({ "v": 1, "client_id": client_id }))?;
        match conn.receive()? {
            (FRAME, message) if message["evt"] == "READY" => Ok(conn),
            (_, message) => Err(format!("unexpected handshake answer: {message}")),
        }
    }

    fn send(&mut self, op: u32, payload: &Value) -> Result<(), String> {
        self.pipe.write_all(&encode(op, payload)).map_err(|e| format!("pipe: {e}"))
    }

    /// The next message from Discord, answering its pings on the way.
    fn receive(&mut self) -> Result<(u32, Value), String> {
        loop {
            let (op, message) = read_frame(&mut self.pipe).map_err(|e| format!("pipe: {e}"))?;
            match op {
                PING => self.send(PONG, &message)?,
                CLOSE => return Err(format!("Discord closed the connection: {}", message["message"].as_str().unwrap_or("no reason"))),
                _ => return Ok((op, message)),
            }
        }
    }

    /// Sets (or clears, with null) the status; resolves with what Discord accepted.
    fn set_activity(&mut self, activity: &Value) -> Result<Value, String> {
        self.nonce += 1;
        let nonce = self.nonce.to_string();
        let command = json!({ "cmd": "SET_ACTIVITY", "args": { "pid": std::process::id(), "activity": activity }, "nonce": nonce });
        self.send(FRAME, &command)?;
        loop {
            let (_, message) = self.receive()?;
            if message["nonce"] != nonce.as_str() {
                continue;
            }
            if message["evt"] == "ERROR" {
                return Err(format!("Discord refused the status: {}", message["data"]["message"].as_str().unwrap_or("no reason")));
            }
            return Ok(message["data"].clone());
        }
    }
}

fn encode(op: u32, payload: &Value) -> Vec<u8> {
    let body = payload.to_string();
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&op.to_le_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(body.as_bytes());
    frame
}

fn read_frame(reader: &mut impl Read) -> io::Result<(u32, Value)> {
    let mut header = [0u8; 8];
    reader.read_exact(&mut header)?;
    let op = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
    if len > 1 << 20 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too big"));
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body)?;
    Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let payload = json!({ "cmd": "SET_ACTIVITY", "nonce": "1", "args": { "activity": null } });
        let frame = encode(FRAME, &payload);
        assert_eq!(&frame[..4], &[1, 0, 0, 0]);
        assert_eq!(u32::from_le_bytes(frame[4..8].try_into().unwrap()) as usize, frame.len() - 8);
        assert_eq!(read_frame(&mut frame.as_slice()).unwrap(), (FRAME, payload));
        let mut too_big = encode(FRAME, &json!(1));
        too_big[4..8].copy_from_slice(&(2u32 << 20).to_le_bytes());
        assert!(read_frame(&mut too_big.as_slice()).is_err());
    }

    /// Needs Discord running. An application id Discord doesn't know: the handshake must come back
    /// refused, which proves the pipe and the framing. With `JAYC_DISCORD_ID` set to the real id, it
    /// shows a status for 10 s instead (look at your Discord profile), then clears it.
    /// `cargo test --lib discord -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_discord() {
        let Ok(id) = std::env::var("JAYC_DISCORD_ID") else {
            let error = Connection::open("1").err().expect("Discord accepted a made-up application id");
            println!("refused as expected: {error}");
            return;
        };
        let mut conn = Connection::open(&id).expect("handshake");
        let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let shown = conn
            .set_activity(&json!({ "details": "Test from cargo", "state": "1 of 16", "timestamps": { "start": started } }))
            .expect("set");
        println!("Discord accepted: {shown}");
        std::thread::sleep(Duration::from_secs(10));
        println!("cleared: {}", conn.set_activity(&Value::Null).expect("clear"));
    }
}
