//! WebRTC sender (str0m, sans-IO) to a mediasoup WebRtcTransport: ICE (we control; mediasoup is
//! ICE-lite), DTLS client, SRTP, H.264 with RTX resends, TWCC feedback driving str0m's bandwidth
//! estimate and pacer. Same port as the app's WebRTC (the server's WebRtcServer, 40000 by default).

use std::collections::VecDeque;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use str0m::bwe::{Bitrate, BweKind};
use str0m::change::DirectApi;
use str0m::media::{KeyframeRequestKind, MediaKind, MediaTime, Mid, Pt};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, IceCreds, Input, Output, Rtc, RtcConfig};

pub const PT: u8 = 102;
pub const RTX_PT: u8 = 103;
pub const MID: &str = "0";

/// What the server's `createTransport` returned (sha-256 fingerprint as "sha-256 AB:CD:...").
pub struct Remote {
    pub ufrag: String,
    pub pwd: String,
    pub addr: SocketAddr,
    pub fingerprint: String,
}

pub struct Sender {
    rtc: Rtc,
    socket: UdpSocket,
    local: SocketAddr,
    mid: Mid,
    sps_pps: Vec<u8>,
    connected: bool,
    buf: Vec<u8>,
    pub keyframe_requests: u64,
    pub frames_sent: u64,
    /// Test only: a simulated narrow uplink (kbps), applied while `Some`. See `Shaper`.
    pub shape_kbps: Option<u64>,
    shaper: Shaper,
}

/// A router queue in front of a slow uplink: packets leave at `kbps`, wait at most 200 ms, and
/// are dropped beyond that. Lets the spike test the bandwidth estimate without network tools.
#[derive(Default)]
struct Shaper {
    queue: VecDeque<(Instant, Vec<u8>)>,
    last_departure: Option<Instant>,
    pub dropped: u64,
}

/// What the app tells the server in `connectTransport` and `produce`.
pub struct Local {
    pub fingerprint: String,
    pub ssrc: u32,
    pub rtx_ssrc: u32,
}

/// Things the capture loop has to act on.
#[derive(Default)]
pub struct Signals {
    pub keyframe: bool,
    pub estimate: Option<u64>,
    /// Fraction lost, from the SFU's receiver reports (str0m averages them per stats event).
    pub loss: Option<f32>,
}

impl Sender {
    pub fn new(remote: &Remote, start_kbps: u64, max_kbps: u64) -> Result<(Self, Local), Box<dyn std::error::Error>> {
        let socket = UdpSocket::bind("0.0.0.0:0")?;
        socket.connect(remote.addr)?; // one remote: the SFU. Also tells us our local IP for ICE.
        // Non-blocking: a read timeout on Windows waits ~15 ms at least, which held frames back.
        socket.set_nonblocking(true)?;
        let local = socket.local_addr()?;

        let mut config = RtcConfig::new()
            .clear_codecs()
            .enable_bwe(Some(Bitrate::kbps(start_kbps)))
            .set_stats_interval(Some(Duration::from_millis(500)));
        // Must match the producer's rtpParameters (send.mjs).
        config.codec_config().add_h264(PT.into(), Some(RTX_PT.into()), true, 0x640032);
        let mut rtc = config.build(Instant::now());
        rtc.add_local_candidate(Candidate::host(local, "udp")?);
        rtc.add_remote_candidate(Candidate::host(remote.addr, "udp")?);

        let mid: Mid = MID.into();
        let mut api: DirectApi = rtc.direct_api();
        api.set_ice_controlling(true);
        api.set_remote_ice_credentials(IceCreds { ufrag: remote.ufrag.clone(), pass: remote.pwd.clone() });
        api.set_remote_fingerprint(remote.fingerprint.parse()?);
        api.declare_media(mid, MediaKind::Video);
        let ssrc = api.new_ssrc();
        let rtx_ssrc = api.new_ssrc();
        api.declare_stream_tx(ssrc, Some(rtx_ssrc), mid, None);
        let fingerprint = api.local_dtls_fingerprint().to_string();
        api.start_dtls(true)?; // DTLS client: we say role "client" in connectTransport
        rtc.bwe().set_bitrate(Bitrate::kbps(300), Bitrate::kbps(max_kbps));

        Ok((
            Self { rtc, socket, local, mid, sps_pps: Vec::new(), connected: false, buf: vec![0; 2000], keyframe_requests: 0, frames_sent: 0, shape_kbps: None, shaper: Shaper::default() },
            Local { fingerprint, ssrc: *ssrc, rtx_ssrc: *rtx_ssrc },
        ))
    }

    pub fn shaper_dropped(&self) -> u64 {
        self.shaper.dropped
    }

    pub fn connected(&self) -> bool {
        self.connected
    }

    /// Runs the network side without waiting: sends what str0m has queued, reads what has arrived,
    /// handles due timers. Returns what the encoder should react to. Call it every ~1 ms.
    pub fn drive(&mut self) -> Result<Signals, Box<dyn std::error::Error>> {
        let mut signals = Signals::default();
        while self.shaper.queue.front().is_some_and(|(d, _)| *d <= Instant::now()) {
            let (_, packet) = self.shaper.queue.pop_front().unwrap();
            let _ = self.socket.send(&packet);
        }
        loop {
            let timeout = loop {
                match self.rtc.poll_output()? {
                    Output::Timeout(t) => break t,
                    Output::Transmit(t) => match self.shape_kbps {
                        None => {
                            let _ = self.socket.send(&t.contents);
                        }
                        Some(kbps) => {
                            let now = Instant::now();
                            let start = self.shaper.last_departure.map_or(now, |d| d.max(now));
                            let departure = start + Duration::from_secs_f64(t.contents.len() as f64 * 8.0 / (kbps as f64 * 1000.0));
                            if departure - now > Duration::from_millis(200) {
                                self.shaper.dropped += 1;
                            } else {
                                self.shaper.last_departure = Some(departure);
                                self.shaper.queue.push_back((departure, t.contents.to_vec()));
                            }
                        }
                    },
                    Output::Event(e) => match e {
                        Event::Connected => {
                            self.connected = true;
                            signals.keyframe = true; // the first frame anyone gets must be a keyframe
                            eprintln!("webrtc: connected");
                        }
                        Event::IceConnectionStateChange(s) => {
                            eprintln!("webrtc: ice {s:?}");
                            if s == IceConnectionState::Disconnected {
                                self.connected = false;
                            }
                        }
                        Event::KeyframeRequest(r) if matches!(r.kind, KeyframeRequestKind::Pli | KeyframeRequestKind::Fir) => {
                            self.keyframe_requests += 1;
                            signals.keyframe = true;
                        }
                        Event::EgressBitrateEstimate(BweKind::Twcc { estimate, .. }) => {
                            signals.estimate = Some(estimate.as_u64());
                        }
                        Event::MediaEgressStats(stats) => {
                            if let Some(loss) = stats.loss {
                                signals.loss = Some(loss);
                            }
                        }
                        _ => {}
                    },
                }
            };
            let input = match self.socket.recv_from(&mut self.buf) {
                Ok((n, source)) => Input::Receive(Instant::now(), Receive::new(Protocol::Udp, source, self.local, &self.buf[..n])?),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    let now = Instant::now();
                    if timeout > now {
                        return Ok(signals); // nothing to read, no timer due
                    }
                    Input::Timeout(now)
                }
                // Windows reports an ICMP "port unreachable" from an earlier send as a recv error.
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => continue,
                Err(e) => return Err(e.into()),
            };
            self.rtc.handle_input(input)?;
        }
    }

    /// Queues one encoded frame (Annex B). Keyframes without SPS/PPS get the last ones seen, so a
    /// viewer that joins later can decode. Dropped until connected.
    pub fn send_frame(&mut self, annexb: &[u8], rtp_time_90k: u64) -> Result<(), Box<dyn std::error::Error>> {
        let nal_types: Vec<u8> = split_annexb(annexb).iter().map(|n| n[0] & 0x1f).collect();
        if nal_types.contains(&7) {
            self.sps_pps = split_annexb(annexb)
                .into_iter()
                .filter(|n| matches!(n[0] & 0x1f, 7 | 8))
                .flat_map(|n| [&[0u8, 0, 0, 1][..], n].concat())
                .collect();
        }
        if !self.connected {
            return Ok(());
        }
        let data: Vec<u8> = if nal_types.contains(&5) && !nal_types.contains(&7) { [&self.sps_pps[..], annexb].concat() } else { annexb.to_vec() };
        let writer = self.rtc.writer(self.mid).ok_or("no writer")?;
        writer.write(Pt::from(PT), Instant::now(), MediaTime::from_90khz(rtp_time_90k), data)?;
        self.frames_sent += 1;
        Ok(())
    }
}

/// NAL units of an Annex B byte stream (start codes removed).
pub fn split_annexb(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    starts
        .iter()
        .enumerate()
        .map(|(k, &s)| {
            let mut end = starts.get(k + 1).map_or(data.len(), |&n| n - 3);
            while end > s && data[end - 1] == 0 {
                end -= 1; // the extra zero of a 4-byte start code (or trailing zeros)
            }
            &data[s..end]
        })
        .filter(|nal| !nal.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_annexb_with_3_and_4_byte_start_codes() {
        let data = [0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5];
        assert_eq!(split_annexb(&data), vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 4, 5][..]]);
    }
}
