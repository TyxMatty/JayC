//! Diagnostic: opens the default microphone with plain WASAPI (shared mode, default stream
//! category, console role) for N seconds, to see whether merely capturing triggers the
//! system's "call mode" processing on the speakers. Pair with `output_meter`. Also prints the
//! captured level, so a muted or blocked mic (all zeros) shows up.
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
    let (mut frames, mut sum_sq, mut peak) = (0u64, 0f64, 0f32);
    while started.elapsed() < Duration::from_secs(seconds) {
        std::thread::sleep(Duration::from_millis(50));
        while capture.get_next_packet_size().unwrap().unwrap_or(0) > 0 {
            capture.read_from_device_to_deque(&mut queue).unwrap();
        }
        let bytes: Vec<u8> = queue.drain(..).collect();
        for chunk in bytes.chunks_exact(4) {
            let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            sum_sq += f64::from(sample * sample);
            peak = peak.max(sample.abs());
            frames += 1;
        }
    }
    client.stop_stream().unwrap();
    let rms = (sum_sq / frames.max(1) as f64).sqrt();
    let db = |x: f64| if x > 0.0 { format!("{:.1} dBFS", 20.0 * x.log10()) } else { "silence".into() };
    println!("closed after {:.1}s: {frames} frames, rms {}, peak {}", started.elapsed().as_secs_f32(), db(rms), db(f64::from(peak)));
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only");
}
