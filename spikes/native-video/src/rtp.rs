//! Minimal RTP sender for H.264 (RFC 6184: single NAL units and FU-A) over one UDP socket, and the
//! RTCP the SFU sends back on it: PLI/FIR ask for a keyframe. No NACK/retransmission and no
//! bandwidth estimation: enough for the spike on a LAN, not for the internet.

use std::collections::VecDeque;
use std::net::UdpSocket;

const MAX_PAYLOAD: usize = 1200;

pub struct RtpSender {
    socket: UdpSocket,
    ssrc: u32,
    pt: u8,
    seq: u16,
    sps_pps: Vec<Vec<u8>>,
    /// Recent packets by sequence number, resent when the SFU reports them lost (NACK).
    history: VecDeque<(u16, Vec<u8>)>,
    pub packets: u64,
    pub keyframe_requests: u64,
    pub send_errors: u64,
    pub retransmitted: u64,
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

impl RtpSender {
    pub fn new(addr: &str, ssrc: u32, pt: u8) -> std::io::Result<Self> {
        let socket = UdpSocket::bind("0.0.0.0:0")?;
        socket.connect(addr)?;
        socket.set_nonblocking(true)?;
        Ok(Self { socket, ssrc, pt, seq: (ssrc & 0xffff) as u16, sps_pps: Vec::new(), history: VecDeque::new(), packets: 0, keyframe_requests: 0, send_errors: 0, retransmitted: 0 })
    }

    /// Sends one encoded frame (Annex B) with its 90 kHz timestamp. Keyframes without SPS/PPS get
    /// the last ones seen, so a viewer that joins later can start decoding.
    pub fn send_frame(&mut self, annexb: &[u8], ts: u32) {
        let mut nals: Vec<&[u8]> = split_annexb(annexb).into_iter().filter(|n| n[0] & 0x1f != 9).collect(); // no AUDs
        let has = |t: u8| nals.iter().any(|n| n[0] & 0x1f == t);
        if has(7) {
            self.sps_pps = nals.iter().filter(|n| matches!(n[0] & 0x1f, 7 | 8)).map(|n| n.to_vec()).collect();
        }
        let cached = self.sps_pps.clone();
        if has(5) && !has(7) {
            nals.splice(0..0, cached.iter().map(|v| v.as_slice()));
        }
        let count = nals.len();
        for (i, nal) in nals.into_iter().enumerate() {
            let last = i + 1 == count;
            if nal.len() <= MAX_PAYLOAD {
                self.packet(ts, last, &[nal]);
                continue;
            }
            let indicator = (nal[0] & 0xe0) | 28;
            let chunks: Vec<&[u8]> = nal[1..].chunks(MAX_PAYLOAD - 2).collect();
            for (k, chunk) in chunks.iter().enumerate() {
                let start = if k == 0 { 0x80 } else { 0 };
                let end = if k + 1 == chunks.len() { 0x40 } else { 0 };
                let header = start | end | (nal[0] & 0x1f);
                self.packet(ts, last && end != 0, &[&[indicator, header], chunk]);
            }
        }
    }

    fn packet(&mut self, ts: u32, marker: bool, parts: &[&[u8]]) {
        let mut buf = Vec::with_capacity(12 + MAX_PAYLOAD);
        buf.extend_from_slice(&[0x80, (if marker { 0x80 } else { 0 }) | self.pt]);
        buf.extend_from_slice(&self.seq.to_be_bytes());
        buf.extend_from_slice(&ts.to_be_bytes());
        buf.extend_from_slice(&self.ssrc.to_be_bytes());
        for p in parts {
            buf.extend_from_slice(p);
        }
        if self.socket.send(&buf).is_err() {
            self.send_errors += 1; // full socket buffer: the packet is lost, like on a lossy link
        }
        if self.history.len() == 2048 {
            self.history.pop_front();
        }
        self.history.push_back((self.seq, buf));
        self.seq = self.seq.wrapping_add(1);
        self.packets += 1;
    }

    /// True if the SFU asked for a keyframe (RTCP PLI or FIR) since the last call.
    pub fn keyframe_requested(&mut self) -> bool {
        let mut buf = [0u8; 1500];
        let mut wanted = false;
        while let Ok(n) = self.socket.recv(&mut buf) {
            let mut off = 0;
            while off + 4 <= n {
                let fmt = buf[off] & 0x1f;
                let pt = buf[off + 1];
                let len = (u16::from_be_bytes([buf[off + 2], buf[off + 3]]) as usize + 1) * 4;
                if pt == 206 && (fmt == 1 || fmt == 4) {
                    wanted = true;
                }
                if pt == 205 && fmt == 1 {
                    // Generic NACK: after the 12-byte header, (PID, BLP) pairs.
                    let mut fci = off + 12;
                    while fci + 4 <= (off + len).min(n) {
                        let pid = u16::from_be_bytes([buf[fci], buf[fci + 1]]);
                        let blp = u16::from_be_bytes([buf[fci + 2], buf[fci + 3]]);
                        let lost = (0..17).filter(|&b| b == 0 || blp & (1 << (b - 1)) != 0).map(|b| pid.wrapping_add(b));
                        for seq in lost {
                            if let Some((_, packet)) = self.history.iter().find(|(s, _)| *s == seq) {
                                let _ = self.socket.send(packet);
                                self.retransmitted += 1;
                            }
                        }
                        fci += 4;
                    }
                }
                off += (u16::from_be_bytes([buf[off + 2], buf[off + 3]]) as usize + 1) * 4;
            }
        }
        if wanted {
            self.keyframe_requests += 1;
        }
        wanted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_annexb_with_3_and_4_byte_start_codes() {
        let data = [0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5];
        assert_eq!(split_annexb(&data), vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 4, 5][..]]);
    }

    #[test]
    fn fragments_big_nals_with_fu_a_and_marks_the_frame_end() {
        let rx = UdpSocket::bind("127.0.0.1:0").unwrap();
        let mut tx = RtpSender::new(&rx.local_addr().unwrap().to_string(), 7, 102).unwrap();
        let mut frame = vec![0, 0, 0, 1, 0x65];
        frame.extend(std::iter::repeat(0xab).take(3000));
        tx.send_frame(&frame, 90_000);
        let mut got = Vec::new();
        let mut buf = [0u8; 1500];
        rx.set_read_timeout(Some(std::time::Duration::from_millis(200))).unwrap();
        while let Ok(n) = rx.recv(&mut buf) {
            got.push(buf[..n].to_vec());
        }
        assert_eq!(got.len(), 3); // 3000 bytes in 1198-byte pieces
        assert_eq!(got[0][12] & 0x1f, 28); // FU-A
        assert_eq!(got[0][13], 0x80 | 5); // start bit + IDR type
        assert_eq!(got[2][13], 0x40 | 5); // end bit
        assert_eq!(got.iter().filter(|p| p[1] & 0x80 != 0).count(), 1); // marker only on the last
        let payload: usize = got.iter().map(|p| p.len() - 14).sum();
        assert_eq!(payload, 3000);
    }
}
