//! Jay-C's end of the Jay Link alone, to check a Jay-A (or the fake one): says HELLO, asks for
//! the microphone for a while and reports how regularly the 20 ms chunks arrive.
//!
//!   cargo run --example jay_a_probe -- [PIPE] [SECONDS]      (defaults: jay-a-link, 30)
//!
//! Passes (exit code 0) when audio came, the link stayed up and no gap between chunks went over
//! 60 ms, the point where Jay-C hands the call to its own microphone (docs/JAY-A.md).

use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri_plugin_system_audio::link::{Link, LinkEvent, PIPE};

const GAP_MS: f64 = 60.0;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let pipe = args.first().map_or(PIPE, String::as_str);
    let seconds: u64 = args.get(1).map_or(30, |s| s.parse().expect("seconds"));

    let (tx, rx) = mpsc::channel();
    let hello = json!({ "app": "jay-c", "version": "probe", "protocol": 1 });
    let link = Link::connect(pipe, &hello, move |event| {
        let _ = tx.send((Instant::now(), event));
    })
    .unwrap_or_else(|end| {
        println!("FAIL: {end:?}");
        std::process::exit(1);
    });
    println!("connected to Jay-A {}; asking for the microphone for {seconds} s", link.version());
    let asked = Instant::now();
    link.control(&json!({ "type": "start-mic" }));

    let end = asked + Duration::from_secs(seconds);
    let (mut arrivals, mut energy, mut samples, mut closed) = (Vec::new(), 0f64, 0usize, None);
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok((at, LinkEvent::Audio(chunk))) => {
                arrivals.push(at);
                energy += chunk.iter().map(|&s| (s as f64).powi(2)).sum::<f64>();
                samples += chunk.len();
            }
            Ok((_, LinkEvent::Control(message))) => println!("control: {message}"),
            Ok((_, LinkEvent::Closed(why))) => {
                closed = Some(why);
                break;
            }
            Err(_) => break,
        }
    }
    drop(link);

    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    let mut gaps: Vec<f64> = arrivals.windows(2).map(|w| ms(w[1] - w[0])).collect();
    gaps.sort_by(f64::total_cmp);
    let pick = |q: f64| gaps.get(((gaps.len() as f64 - 1.0) * q).round() as usize).copied().unwrap_or(f64::NAN);
    let long = gaps.iter().filter(|&&g| g > GAP_MS).count();
    println!("chunks: {} in {seconds} s (expected ~{})", arrivals.len(), seconds * 50);
    if let Some(first) = arrivals.first() {
        println!("first chunk {:.1} ms after start-mic", ms(*first - asked));
    }
    println!("gap between chunks: p50 {:.1} ms, p99 {:.1} ms, max {:.1} ms; over {GAP_MS} ms: {long}", pick(0.5), pick(0.99), pick(1.0));
    if samples > 0 {
        println!("level: {:.1} dBFS rms", 10.0 * (energy / samples as f64 + 1e-12).log10());
    }
    let pass = closed.is_none() && !arrivals.is_empty() && long == 0;
    match closed {
        Some(why) => println!("FAIL: the link closed: {why:?}"),
        None if pass => println!("PASS"),
        None => println!("FAIL"),
    }
    std::process::exit(if pass { 0 } else { 1 });
}
