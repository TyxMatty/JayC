//! Diagnostic: opens the default microphone with plain WASAPI (shared mode, default stream
//! category, console role) for N seconds, to see whether merely capturing triggers the
//! system's "call mode" processing on the speakers. Pair with `output_meter`.
//!
//!   cargo run --example mic_open -- [seconds]

#[cfg(windows)]
fn main() {
    use std::collections::VecDeque;
    use std::time::{Duration, Instant};
    use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat, initialize_mta};

    let seconds: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(10);
    initialize_mta().ok().unwrap();
    let device = DeviceEnumerator::new().unwrap().get_default_device(&Direction::Capture).unwrap();
    println!("mic: {}", device.get_friendlyname().unwrap_or_default());
    let mut client = device.get_iaudioclient().unwrap();
    let format = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 1, None);
    client
        .initialize_client(&format, &Direction::Capture, &StreamMode::PollingShared { autoconvert: true, buffer_duration_hns: 2_000_000 })
        .unwrap();
    let capture = client.get_audiocaptureclient().unwrap();
    client.start_stream().unwrap();
    let started = Instant::now();
    let mut queue = VecDeque::new();
    while started.elapsed() < Duration::from_secs(seconds) {
        std::thread::sleep(Duration::from_millis(50));
        while capture.get_next_packet_size().unwrap().unwrap_or(0) > 0 {
            capture.read_from_device_to_deque(&mut queue).unwrap();
        }
        queue.clear();
    }
    client.stop_stream().unwrap();
    println!("closed after {:.1}s", started.elapsed().as_secs_f32());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only");
}
