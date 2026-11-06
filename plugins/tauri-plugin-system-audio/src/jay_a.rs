//! The call microphone's Jay-A mode (docs/JAY-A.md): Jay-A's audio over the Jay Link while it
//! keeps coming, and Jay-C's own microphone (the hot reserve, captured by `win::Mic` as usual)
//! whenever it doesn't. Both feed one output, so the call's track never changes.
//!
//! The state goes to the webview as JSON, sent when it changes:
//! `{ "link": "searching" | "jay-a" | "fallback" | "incompatible", "version": string | null,
//!    "reason": string | null, "device": string | null, "deviceId": string | null }`
//! (`reason`: why Jay-A is incompatible; `device`/`deviceId`: the microphone Jay-A last said it
//! uses, which the reserve follows).
//!
//! Reopening the microphone (another device, other options) keeps the `JayA`: only the reserve's
//! capture and the output channel change (`rewire`), so the link and the selector carry on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::link::{Link, LinkEnd, LinkEvent};
use crate::selector::{Selector, Source};

/// Between attempts to reach Jay-A while it isn't there (shorter in tests, to keep them quick).
#[cfg(not(test))]
const RETRY: Duration = Duration::from_secs(5);
#[cfg(test)]
const RETRY: Duration = Duration::from_millis(300);
/// Between attempts while Jay-A speaks another protocol (it has to be updated first).
const RETRY_INCOMPATIBLE: Duration = Duration::from_secs(60);

pub type Sink = Box<dyn FnMut(&[f32]) + Send>;
pub type StatusSink = Box<dyn Fn(Value) + Send>;

pub struct JayA {
    output: Arc<Mutex<Output>>,
    link: Arc<Mutex<Option<Link>>>,
    /// The latest `call-state`, sent again on every (re)connection.
    call_state: Arc<Mutex<Option<Value>>>,
    wake: mpsc::Sender<()>,
    stop: Arc<AtomicBool>,
    manager: Option<JoinHandle<()>>,
}

impl JayA {
    /// Starts reaching for Jay-A on `\\.\pipe\<pipe>`, retrying while it isn't there. Until its
    /// audio flows (and whenever it stops), `sink` gets the reserve's chunks, given to `reserve`.
    pub fn start(pipe: &str, hello: Value, sink: Sink, on_status: StatusSink) -> JayA {
        let output = Arc::new(Mutex::new(Output {
            selector: Selector::default(),
            sink,
            on_status,
            version: None,
            incompatible: None,
            was_linked: false,
            state: None,
            sent: None,
        }));
        output.lock().unwrap().report(); // "searching" from the start
        let link = Arc::new(Mutex::new(None));
        let call_state = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let (wake, woken) = mpsc::channel();
        let manager = {
            let manager = Manager {
                pipe: pipe.to_string(),
                hello,
                output: output.clone(),
                link: link.clone(),
                call_state: call_state.clone(),
                stop: stop.clone(),
                wake: wake.clone(),
            };
            std::thread::Builder::new().name("system-audio-jay-a".into()).spawn(move || manager.run(&woken))
        };
        if let Err(e) = &manager {
            log::warn!("system-audio: no Jay-A thread ({e}); using Jay-C's microphone only");
        }
        JayA { output, link, call_state, wake, stop, manager: manager.ok() }
    }

    /// A chunk from the reserve (Jay-C's own microphone).
    pub fn reserve(&self, chunk: &[f32]) {
        let mut output = self.output.lock().unwrap();
        let chunks = output.selector.on_reserve(Instant::now(), chunk.to_vec());
        output.emit(chunks);
    }

    /// Sends a CONTROL message to Jay-A, if it's connected (e.g. `{ "type": "show" }`).
    pub fn control(&self, message: &Value) {
        if let Some(link) = &*self.link.lock().unwrap() {
            link.control(message);
        }
    }

    /// Tells Jay-A whether we're in a call and muted (for its window only), now and on every
    /// reconnection.
    pub fn call_state(&self, in_call: bool, muted: bool) {
        let message = json!({ "type": "call-state", "inCall": in_call, "muted": muted });
        self.control(&message);
        *self.call_state.lock().unwrap() = Some(message);
    }

    /// The microphone was reopened: from now on, the output and the states go to these. The current
    /// state is sent again, since the new channel hasn't had it.
    pub fn rewire(&self, sink: Sink, on_status: StatusSink) {
        let mut output = self.output.lock().unwrap();
        output.sink = sink;
        output.on_status = on_status;
        output.sent = None;
        output.report();
    }
}

impl Drop for JayA {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.wake.send(());
        if let Some(manager) = self.manager.take() {
            let _ = manager.join();
        }
    }
}

struct Output {
    selector: Selector,
    sink: Sink,
    on_status: StatusSink,
    /// Jay-A's version while connected.
    version: Option<String>,
    /// Why Jay-A can't be used (another protocol), until it connects again.
    incompatible: Option<String>,
    /// Jay-A has been the source at least once: losing it now is "fallback", not "searching".
    was_linked: bool,
    /// Jay-A's last `state` message (its microphone and preset).
    state: Option<Value>,
    /// The last state sent.
    sent: Option<Value>,
}

impl Output {
    /// The state goes first: the webview applies Jay-C's volume and gate only to the reserve's
    /// chunks, so it must know whose chunks follow.
    fn emit(&mut self, chunks: Vec<Vec<f32>>) {
        self.report();
        for chunk in &chunks {
            (self.sink)(chunk);
        }
    }

    /// Sends the state if it changed.
    fn report(&mut self) {
        let active = self.selector.active() == Source::JayA;
        self.was_linked |= active;
        let link = match (active, &self.incompatible) {
            (true, _) => "jay-a",
            (false, Some(_)) => "incompatible",
            (false, None) if self.was_linked => "fallback",
            (false, None) => "searching",
        };
        let state = self.state.as_ref();
        let status = json!({
            "link": link,
            "version": self.version,
            "reason": self.incompatible,
            "device": state.and_then(|s| s.get("device")),
            "deviceId": state.and_then(|s| s.get("deviceId")),
        });
        if self.sent.as_ref() != Some(&status) {
            (self.on_status)(status.clone());
            self.sent = Some(status);
        }
    }
}

/// The thread that connects to Jay-A and reconnects when the link ends.
struct Manager {
    pipe: String,
    hello: Value,
    output: Arc<Mutex<Output>>,
    link: Arc<Mutex<Option<Link>>>,
    call_state: Arc<Mutex<Option<Value>>>,
    stop: Arc<AtomicBool>,
    wake: mpsc::Sender<()>,
}

impl Manager {
    /// `woken`: a message when the link closed or when stopping.
    fn run(self, woken: &mpsc::Receiver<()>) {
        let mut delay = Duration::ZERO;
        while !self.stop.load(Ordering::SeqCst) {
            if !delay.is_zero() {
                let _ = woken.recv_timeout(delay);
                if self.stop.load(Ordering::SeqCst) {
                    break;
                }
            }
            while woken.try_recv().is_ok() {} // left over from an earlier link
            delay = match self.connect() {
                Ok(link) => {
                    let since = Instant::now();
                    *self.link.lock().unwrap() = Some(link);
                    let _ = woken.recv(); // the link closed, or we're stopping
                    let closed = self.link.lock().unwrap().take();
                    drop(closed); // asks Jay-A to stop the microphone, if it's still there
                    // Jay-A may have only dropped the link: try again at once, unless it keeps
                    // accepting and closing.
                    if since.elapsed() < RETRY { RETRY } else { Duration::ZERO }
                }
                Err(LinkEnd::Incompatible(reason)) => {
                    log::warn!("system-audio: Jay-A is incompatible: {reason}");
                    let mut output = self.output.lock().unwrap();
                    output.incompatible = Some(reason);
                    output.report();
                    RETRY_INCOMPATIBLE
                }
                Err(end) => {
                    log::debug!("system-audio: no Jay-A: {end:?}");
                    RETRY
                }
            };
        }
        let closed = self.link.lock().unwrap().take();
        drop(closed);
    }

    fn connect(&self) -> Result<Link, LinkEnd> {
        let (output, wake) = (self.output.clone(), self.wake.clone());
        let link = Link::connect(&self.pipe, &self.hello, move |event| match event {
            LinkEvent::Audio(chunk) => {
                let mut output = output.lock().unwrap();
                let chunks = output.selector.on_link(Instant::now(), chunk);
                output.emit(chunks);
            }
            // Jay-A's microphone: the webview reopens the reserve on it (docs/JAY-A.md, section 3).
            LinkEvent::Control(message) if message["type"] == "state" => {
                let mut output = output.lock().unwrap();
                output.state = Some(message);
                output.report();
            }
            LinkEvent::Control(message) => log::debug!("system-audio: Jay-A says {message}"),
            LinkEvent::Closed(end) => {
                log::warn!("system-audio: the link to Jay-A closed: {end:?}");
                let mut output = output.lock().unwrap();
                output.selector.link_down();
                output.version = None;
                output.report();
                drop(output);
                let _ = wake.send(());
            }
        })?;
        link.control(&json!({ "type": "start-mic" }));
        if let Some(call_state) = &*self.call_state.lock().unwrap() {
            link.control(call_state);
        }
        let mut output = self.output.lock().unwrap();
        output.version = Some(link.version().to_string());
        output.incompatible = None;
        output.report();
        Ok(link)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::fake::{FakeJayA, Options};

    /// What came out: (time, source by value: the fake's tone or the reserve's 0.5), and the states.
    type Log = Arc<Mutex<(Vec<(Instant, bool)>, Vec<(Instant, String)>)>>;

    fn start(pipe: &str) -> (Arc<JayA>, Log) {
        let log: Log = Arc::default();
        let (audio, states) = (log.clone(), log.clone());
        let jay_a = JayA::start(
            pipe,
            json!({ "app": "jay-c", "version": "test", "protocol": 1 }),
            Box::new(move |chunk: &[f32]| audio.lock().unwrap().0.push((Instant::now(), chunk[959] != 0.5))),
            Box::new(move |status: Value| states.lock().unwrap().1.push((Instant::now(), status["link"].as_str().unwrap().to_string()))),
        );
        (Arc::new(jay_a), log)
    }

    /// Feeds the reserve a 0.5 chunk every 20 ms, like the microphone thread, until dropped.
    struct Reserve(Arc<AtomicBool>, Option<JoinHandle<usize>>);
    impl Reserve {
        fn start(jay_a: Arc<JayA>) -> Reserve {
            let stop = Arc::new(AtomicBool::new(false));
            let thread_stop = stop.clone();
            Reserve(
                stop,
                Some(std::thread::spawn(move || {
                    let (start, mut fed) = (Instant::now(), 0usize);
                    while !thread_stop.load(Ordering::SeqCst) {
                        jay_a.reserve(&[0.5; 960]);
                        fed += 1;
                        let next = start + Duration::from_millis(20 * fed as u64);
                        std::thread::sleep(next.saturating_duration_since(Instant::now()));
                    }
                    fed
                })),
            )
        }
        fn stop(mut self) -> usize {
            self.0.store(true, Ordering::SeqCst);
            self.1.take().unwrap().join().unwrap()
        }
    }

    /// When `state` was reported after `after`, waiting up to `within` for it.
    fn wait_for(log: &Log, state: &str, after: Instant, within: Duration) -> Instant {
        let end = Instant::now() + within;
        loop {
            if let Some((at, _)) = log.lock().unwrap().1.iter().find(|(at, s)| s == state && *at > after) {
                return *at;
            }
            assert!(Instant::now() < end, "no '{state}' within {within:?}: {:?}", log.lock().unwrap().1);
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn follows_jay_a_falls_back_when_it_quits_and_returns_when_it_is_back() {
        let pipe = format!("jay-a-link-test-{}-mode", std::process::id());
        let fake = FakeJayA::start(&pipe, Options::default()).unwrap();
        let began = Instant::now();
        let (jay_a, log) = start(&pipe);
        let reserve = Reserve::start(jay_a.clone());

        let linked = wait_for(&log, "jay-a", began, Duration::from_secs(3));
        std::thread::sleep(Duration::from_millis(500));
        drop(fake); // Jay-A quits: its pipe closes
        let quit = Instant::now();
        let fallback = wait_for(&log, "fallback", linked, Duration::from_secs(1));
        println!("fallback {} ms after Jay-A quit", (fallback - quit).as_millis());
        assert!(fallback - quit < Duration::from_millis(40), "the next reserve chunk takes over");

        let _back = FakeJayA::start(&pipe, Options::default()).unwrap(); // Jay-A is back
        let relinked = wait_for(&log, "jay-a", fallback, Duration::from_secs(3));
        std::thread::sleep(Duration::from_millis(300));
        let fed = reserve.stop();

        let (audio, states) = log.lock().unwrap().clone();
        // A state is sent again when only the version changes (Jay-A connected or left): count the
        // changes of `link`.
        let mut states: Vec<&str> = states.iter().map(|(_, s)| s.as_str()).collect();
        states.dedup();
        assert_eq!(states, ["searching", "jay-a", "fallback", "jay-a"]);
        // While linked, the tone; in between, the reserve.
        let source_at = |from: Instant, to: Instant| audio.iter().filter(|(t, _)| *t > from && *t < to).map(|(_, tone)| *tone).collect::<Vec<_>>();
        assert!(source_at(linked + Duration::from_millis(30), quit).iter().all(|&tone| tone));
        assert!(source_at(fallback + Duration::from_millis(30), relinked).iter().all(|&tone| !tone));
        // One chunk out per 20 ms of time, whoever sent it: nothing lost, nothing doubled.
        println!("{} chunks out, {fed} reserve chunks fed", audio.len());
        assert!(audio.len().abs_diff(fed) <= 6, "{} out vs {fed} fed", audio.len());
        let gap = audio.windows(2).map(|w| w[1].0 - w[0].0).max().unwrap();
        println!("longest wait between chunks out: {} ms", gap.as_millis());
    }

    #[test]
    fn reopening_the_microphone_keeps_the_link() {
        let pipe = format!("jay-a-link-test-{}-rewire", std::process::id());
        let _fake = FakeJayA::start(&pipe, Options::default()).unwrap();
        let began = Instant::now();
        let (jay_a, log) = start(&pipe);
        let reserve = Reserve::start(jay_a.clone());
        wait_for(&log, "jay-a", began, Duration::from_secs(3));
        reserve.stop();

        // The microphone is reopened: a new channel, a new reserve.
        let after: Log = Arc::default();
        let (audio, states) = (after.clone(), after.clone());
        let mut statuses = Vec::new();
        jay_a.rewire(
            Box::new(move |chunk: &[f32]| audio.lock().unwrap().0.push((Instant::now(), chunk[959] != 0.5))),
            Box::new(move |status: Value| states.lock().unwrap().1.push((Instant::now(), status.to_string()))),
        );
        let reserve = Reserve::start(jay_a.clone());
        std::thread::sleep(Duration::from_millis(400));
        reserve.stop();

        let (audio, states) = after.lock().unwrap().clone();
        statuses.extend(states.iter().map(|(_, s)| serde_json::from_str::<Value>(s).unwrap()));
        assert_eq!(statuses.len(), 1, "only the current state, sent again: {statuses:?}");
        assert_eq!(statuses[0]["link"], "jay-a", "no new connection, no second of reserve");
        assert_eq!((&statuses[0]["device"], &statuses[0]["deviceId"]), (&json!("Fake mic"), &json!("fake")), "Jay-A's microphone");
        assert!(audio.len() >= 15 && audio.iter().all(|(_, tone)| *tone), "Jay-A's audio goes on: {} chunks", audio.len());
    }

    #[test]
    fn an_old_jay_a_is_incompatible_and_the_reserve_carries_on() {
        let pipe = format!("jay-a-link-test-{}-old", std::process::id());
        let _fake = FakeJayA::start(&pipe, Options { protocol: 2, ..Options::default() }).unwrap();
        let began = Instant::now();
        let (jay_a, log) = start(&pipe);
        let reserve = Reserve::start(jay_a.clone());
        wait_for(&log, "incompatible", began, Duration::from_secs(2));
        std::thread::sleep(Duration::from_millis(200));
        reserve.stop();
        assert!(log.lock().unwrap().0.iter().all(|(_, tone)| !tone));
    }
}
