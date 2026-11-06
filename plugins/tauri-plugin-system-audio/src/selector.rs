//! Picks, chunk by chunk, what the call hears: Jay-A's audio over the link while it keeps coming,
//! or Jay-C's own microphone (the "hot reserve", always running alongside) when it doesn't.
//! Pure logic over arrival times, so it is tested without a microphone. See docs/JAY-A.md, section 3.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Jay-A counts as stalled after this long without a chunk (3 chunks of 20 ms).
pub const GAP: Duration = Duration::from_millis(60);
/// Jay-A takes over again only after this long without a gap, so a flaky link doesn't flip-flop.
pub const RECOVER: Duration = Duration::from_secs(1);
/// Fade-in of the first chunk after a switch, so the seam doesn't click (2.5 ms at 48 kHz).
const FADE: usize = 120;
/// Reserve chunks kept while Jay-A plays, to fill the wait before a stall is noticed (more than GAP).
const BACKLOG: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    JayA,
    Reserve,
}

pub struct Selector {
    active: Source,
    /// Arrival of Jay-A's latest chunk.
    last_link: Option<Instant>,
    /// Start of the current run of Jay-A chunks with no gap longer than GAP.
    run_start: Option<Instant>,
    /// The pipe closed: the next reserve chunk takes over without waiting for GAP.
    link_down: bool,
    /// Reserve chunks (with their arrival) not sent while Jay-A played.
    backlog: VecDeque<(Instant, Vec<f32>)>,
}

impl Default for Selector {
    fn default() -> Self {
        Selector { active: Source::Reserve, last_link: None, run_start: None, link_down: false, backlog: VecDeque::new() }
    }
}

impl Selector {
    pub fn active(&self) -> Source {
        self.active
    }

    /// A chunk from Jay-A arrived. Returns what to send now (nothing while the reserve plays).
    pub fn on_link(&mut self, now: Instant, chunk: Vec<f32>) -> Vec<Vec<f32>> {
        if self.link_down || self.last_link.is_none_or(|last| now.duration_since(last) > GAP) {
            self.run_start = Some(now);
        }
        self.last_link = Some(now);
        self.link_down = false;
        match self.active {
            Source::JayA => vec![chunk],
            Source::Reserve if self.run_start.is_some_and(|start| now.duration_since(start) >= RECOVER) => {
                self.active = Source::JayA;
                self.backlog.clear();
                vec![faded(chunk)]
            }
            Source::Reserve => Vec::new(),
        }
    }

    /// A chunk from the reserve arrived. While Jay-A plays it is kept aside; once Jay-A stalls or its
    /// pipe closed, the reserve takes over and also sends what it captured since Jay-A's last chunk,
    /// so the wait for the stall isn't lost audio.
    pub fn on_reserve(&mut self, now: Instant, chunk: Vec<f32>) -> Vec<Vec<f32>> {
        if self.active == Source::Reserve {
            return vec![chunk];
        }
        let stalled = self.link_down || self.last_link.is_none_or(|last| now.duration_since(last) > GAP);
        if !stalled {
            if self.backlog.len() == BACKLOG {
                self.backlog.pop_front();
            }
            self.backlog.push_back((now, chunk));
            return Vec::new();
        }
        self.active = Source::Reserve;
        let since = self.last_link;
        let mut out: Vec<Vec<f32>> =
            self.backlog.drain(..).filter(|(at, _)| since.is_none_or(|last| *at > last)).map(|(_, c)| c).collect();
        out.push(chunk);
        out[0] = faded(std::mem::take(&mut out[0]));
        out
    }

    /// Jay-A's pipe closed (it quit or crashed): don't wait for GAP, and require a fresh run of
    /// RECOVER before trusting a new connection.
    pub fn link_down(&mut self) {
        self.link_down = true;
    }
}

fn faded(mut chunk: Vec<f32>) -> Vec<f32> {
    let n = FADE.min(chunk.len());
    for (i, s) in chunk[..n].iter_mut().enumerate() {
        *s *= i as f32 / n as f32;
    }
    chunk
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINK: f32 = 1.0;
    const RESERVE: f32 = 0.5;

    /// What was sent: (time in ms, which source by its marker value, chunk).
    type Sent = Vec<(u64, f32, Vec<f32>)>;

    /// Runs a timeline: reserve chunks every 20 ms (offset 10 ms), Jay-A chunks at `link_at` (ms).
    fn run(link_at: &[u64], end_ms: u64, down_at: Option<u64>) -> (Sent, Selector) {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut events: Vec<(u64, u8)> = link_at.iter().map(|&t| (t, 0)).collect();
        events.extend((0..end_ms / 20).map(|k| (k * 20 + 10, 1)));
        if let Some(t) = down_at {
            events.push((t, 2));
        }
        events.sort();
        let mut selector = Selector::default();
        let mut sent = Vec::new();
        for (t, kind) in events {
            let out = match kind {
                0 => selector.on_link(at(t), vec![LINK; 960]),
                1 => selector.on_reserve(at(t), vec![RESERVE; 960]),
                _ => {
                    selector.link_down();
                    Vec::new()
                }
            };
            sent.extend(out.into_iter().map(|c| (t, c[959], c)));
        }
        (sent, selector)
    }

    /// Times (ms) at which the sent source changed, and to what.
    fn switches(sent: &Sent) -> Vec<(u64, f32)> {
        let mut out: Vec<(u64, f32)> = Vec::new();
        let mut current = RESERVE;
        for (t, source, _) in sent {
            if *source != current {
                current = *source;
                out.push((*t, current));
            }
        }
        out
    }

    fn every_20ms(from: u64, to: u64) -> Vec<u64> {
        (from..to).step_by(20).collect()
    }

    #[test]
    fn t1_jay_a_takes_over_after_a_second_of_steady_chunks() {
        let (sent, selector) = run(&every_20ms(0, 3000), 3000, None);
        assert_eq!(switches(&sent), vec![(1000, LINK)], "one switch, once Jay-A has flowed for 1 s");
        assert_eq!(selector.active(), Source::JayA);
        let first_link = sent.iter().find(|(_, s, _)| *s == LINK).unwrap();
        assert_eq!((first_link.2[0], first_link.2[FADE]), (0.0, LINK), "the first chunk after the switch fades in");
        // While Jay-A plays, only its chunks go out: one per 20 ms, nothing from the reserve.
        let after: Vec<_> = sent.iter().filter(|(t, _, _)| *t >= 1000).collect();
        assert!(after.iter().all(|(_, s, _)| *s == LINK));
        assert_eq!(after.len(), 100);
    }

    #[test]
    fn t2_a_stalled_jay_a_hands_over_within_80_ms_without_losing_audio() {
        // Jay-A sends until 2980 ms and then nothing.
        let (sent, selector) = run(&every_20ms(0, 3000), 4000, None);
        assert_eq!(switches(&sent), vec![(1000, LINK), (3050, RESERVE)], "noticed 70 ms after the last chunk");
        assert_eq!(selector.active(), Source::Reserve);
        // At the switch, the reserve also sends what it captured after Jay-A's last chunk (2990, 3010,
        // 3030 ms) along with the current one, faded in at the seam.
        let burst: Vec<_> = sent.iter().filter(|(t, _, _)| *t == 3050).collect();
        assert_eq!(burst.len(), 4);
        assert_eq!((burst[0].2[0], burst[1].2[0]), (0.0, RESERVE), "only the first chunk of the burst fades");
        // Then one reserve chunk per 20 ms again.
        assert_eq!(sent.iter().filter(|(t, _, _)| *t > 3050).count(), 47);
    }

    #[test]
    fn t2_a_closed_pipe_hands_over_at_the_next_reserve_chunk() {
        // The pipe closes at 1985 and Jay-A is back at once (a quick restart), sending from 2000.
        let (sent, _) = run(&every_20ms(0, 4000), 4000, Some(1985));
        // The last Jay-A chunk came at 1980; the next reserve chunk (1990) takes over at once, and
        // the new connection must flow for a full second before it is trusted.
        assert_eq!(switches(&sent), vec![(1000, LINK), (1990, RESERVE), (3000, LINK)]);
    }

    #[test]
    fn t4_jay_a_takes_over_again_after_a_second_of_steady_chunks() {
        let mut link = every_20ms(0, 2000);
        link.extend(every_20ms(3000, 6000));
        let (sent, _) = run(&link, 6000, None);
        assert_eq!(switches(&sent), vec![(1000, LINK), (2050, RESERVE), (4000, LINK)]);
    }

    #[test]
    fn t6_jitter_of_15_ms_never_switches_back() {
        // Each chunk early or late by up to 15 ms (a pipe keeps the order: an early chunk can't pass
        // the one before it), so gaps of up to 50 ms, under GAP.
        let jitter = [0i64, -15, 15, 0, 7, -9, 15, -15, 3, 0];
        let mut last = 0;
        let link: Vec<u64> = (0..250)
            .map(|k| {
                last = last.max((100 + k * 20 + jitter[k as usize % jitter.len()]) as u64);
                last
            })
            .collect();
        assert_eq!(link.windows(2).map(|w| w[1] - w[0]).max(), Some(50));
        let (sent, selector) = run(&link, 5100, None);
        assert_eq!(switches(&sent).len(), 1, "{:?}", switches(&sent));
        assert_eq!(selector.active(), Source::JayA);
    }
}
