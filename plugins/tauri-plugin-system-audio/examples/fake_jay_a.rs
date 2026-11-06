//! A stand-in Jay-A, to test Jay-C without it: serves the Jay Link and, once asked for the
//! microphone, sends a 440 Hz tone every 20 ms.
//!
//!   cargo run --example fake_jay_a --features fake-jay-a -- [--pipe NAME] [--stall-after S]
//!       [--stall-for S] [--exit-after S] [--protocol N] [--jitter MS] [--device-id ID]
//!
//! --stall-after: stop sending anything S seconds after the microphone was asked for (a hung Jay-A),
//! for --stall-for seconds or forever. --exit-after: quit S seconds after a client connected.
//! --device-id: the microphone it says it uses (default "fake"), e.g. an id from list_mics.

use std::time::Duration;

use tauri_plugin_system_audio::link::{
    PIPE,
    fake::{FakeJayA, Options},
};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    let seconds = |flag: &str| value(flag).map(|s| Duration::from_secs_f64(s.parse().expect("seconds")));
    let pipe = value("--pipe").unwrap_or_else(|| PIPE.to_string());
    let options = Options {
        protocol: value("--protocol").map_or(1, |p| p.parse().expect("protocol")),
        stall_after: seconds("--stall-after"),
        stall_for: seconds("--stall-for"),
        exit_after: seconds("--exit-after"),
        jitter: Duration::from_millis(value("--jitter").map_or(0, |ms| ms.parse().expect("milliseconds"))),
        device_id: value("--device-id").unwrap_or_else(|| "fake".into()),
    };
    let fake = FakeJayA::start(&pipe, options.clone()).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1);
    });
    println!(r"fake Jay-A on \\.\pipe\{pipe}: {options:?}");
    fake.wait();
}
