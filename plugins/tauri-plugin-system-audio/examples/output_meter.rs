//! Diagnostic: loudness of what the default speakers actually play (after mixing, volume and
//! Windows' communications ducking), every 250 ms. Used to measure whether joining a call
//! attenuates other apps.
//!
//!   cargo run --example output_meter -- [seconds]

#[cfg(windows)]
fn main() {
    use std::collections::VecDeque;
    use std::time::{Duration, Instant};
    use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat, initialize_mta};

    let seconds: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(30);
    initialize_mta().ok().unwrap();
    let device = DeviceEnumerator::new().unwrap().get_default_device(&Direction::Render).unwrap();
    let mut client = device.get_iaudioclient().unwrap();
    let format = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None);
    // Capturing from a render device = loopback of everything it plays.
    client
        .initialize_client(&format, &Direction::Capture, &StreamMode::PollingShared { autoconvert: true, buffer_duration_hns: 2_000_000 })
        .unwrap();
    let capture = client.get_audiocaptureclient().unwrap();
    client.start_stream().unwrap();

    let started = Instant::now();
    let mut queue = VecDeque::new();
    while started.elapsed() < Duration::from_secs(seconds) {
        std::thread::sleep(Duration::from_millis(250));
        while capture.get_next_packet_size().unwrap().unwrap_or(0) > 0 {
            capture.read_from_device_to_deque(&mut queue).unwrap();
        }
        let bytes: Vec<u8> = queue.drain(..queue.len() / 4 * 4).collect();
        let (mut sum, mut n) = (0f64, 0u64);
        for b in bytes.chunks_exact(4) {
            let s = f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64;
            sum += s * s;
            n += 1;
        }
        let db = if n > 0 && sum > 0.0 { 10.0 * (sum / n as f64).log10() } else { -120.0 };
        println!("{:6.2}s {:7.1} dB", started.elapsed().as_secs_f32(), db);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only");
}
