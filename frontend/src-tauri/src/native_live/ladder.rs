//! Quality ladder: the resolution and frame rate that fit the bandwidth budget.
//!
//! The steps come from the quality picked in Settings (the top step) and what it's optimized for:
//! "detail" (text, the default) keeps the resolution and gives up frame rate first; "motion" keeps
//! the frame rate and gives up resolution first. A step needs MIN_BPP bits per pixel per frame
//! (frames above 30/s count half, as in core/media.js): below that it looks worse than the next one
//! down. Measured on a 4 Mbps link: 1080p60 at 3.5 Mbps left the HUD text unreadable, worse than
//! 720p30 at 2.5 Mbps.
//!
//! Each step's bitrate cap reaches 30% above the minimum of the step above, so before climbing the
//! live already sends what the next step needs: the climb changes the picture size, not the
//! bitrate (a climb that jumped from 2.5 to 3.5+ Mbps flooded the link and came back down).
//!
//! Down: when the budget stays under the step's minimum for 2 s, or at once under 80% of it, or
//! when the send queue says the step doesn't fit (mod.rs). Up: one step at a time, after the budget
//! has covered the next step with 30% headroom for a while. That wait doubles on each step down
//! (x4 when the climb before it didn't last 20 s), up to 2 min, and halves after a minute without
//! steps down: in the field a 30 s cap still meant a hitch every 30 s.

use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Step {
    pub height: u32,
    pub fps: u32,
    /// Below this the step looks worse than the next one down (0 for the last step).
    pub min_kbps: u32,
    /// The encoder never gets more than this here.
    pub max_kbps: u32,
}

const MIN_BPP: f64 = 0.04;
/// Bits per pixel per frame above which more bitrate barely shows (core/media.js `streamBitrate`).
const MAX_BPP: f64 = 0.08;
const UP_HEADROOM: f64 = 1.3;
const UP_AFTER: Duration = Duration::from_secs(3);
const UP_AFTER_MAX: Duration = Duration::from_secs(120);
/// A climb followed by a step down sooner than this didn't hold.
const HELD: Duration = Duration::from_secs(20);
/// This long without a step down halves the wait to climb again.
const CALM: Duration = Duration::from_secs(60);
const DOWN_AFTER: Duration = Duration::from_secs(2);
const DOWN_AT_ONCE: f64 = 0.8;

/// Output size for a height: same aspect as the capture, never above it, even.
pub fn step_size(capture: (u32, u32), height: u32) -> (u32, u32) {
    let h = height.min(capture.1);
    let w = (capture.0 as u64 * h as u64 / capture.1 as u64) as u32;
    (w & !1, h & !1)
}

/// kbps for `bpp` bits per pixel per frame at this size and frame rate.
fn kbps(size: (u32, u32), fps: u32, bpp: f64) -> u32 {
    let effective_fps = fps.min(30) as f64 + fps.saturating_sub(30) as f64 / 2.0;
    (size.0 as f64 * size.1 as f64 * effective_fps * bpp / 1000.0).round() as u32
}

/// The steps for a picked top (`height`, `fps`, `max_kbps`), best first.
pub fn steps(height: u32, fps: u32, max_kbps: u32, capture: (u32, u32), detail: bool) -> Vec<Step> {
    let shapes: &[(u32, u32)] = if detail {
        &[(height, fps), (height, 30), (height, 15), (1080, 15), (720, 15), (540, 10), (360, 10)]
    } else {
        &[(height, fps), (1080, fps), (720, fps), (720, 30), (540, 30), (360, 30), (360, 15)]
    };
    let mut out: Vec<Step> = Vec::new();
    for &(h, f) in shapes {
        let (h, f) = (step_size(capture, h.min(height)).1, f.min(fps).max(1));
        if out.last().is_some_and(|s| (s.height, s.fps) == (h, f)) || out.iter().any(|s| s.height < h) {
            continue; // same as the step before, or bigger than one already passed
        }
        out.push(Step { height: h, fps: f, min_kbps: kbps(step_size(capture, h), f, MIN_BPP), max_kbps: 0 });
    }
    out.last_mut().unwrap().min_kbps = 0;
    for i in 0..out.len() {
        let own = kbps(step_size(capture, out[i].height), out[i].fps, MAX_BPP);
        let reach = if i == 0 { own } else { own.max((out[i - 1].min_kbps as f64 * UP_HEADROOM).round() as u32) };
        out[i].max_kbps = if i == 0 { max_kbps } else { reach.min(max_kbps) };
    }
    out
}

pub struct Ladder {
    pub steps: Vec<Step>,
    pub tier: usize,
    up_since: Option<Instant>,
    up_after: Duration,
    below_since: Option<Instant>,
    climbed_at: Option<Instant>,
    calm_since: Instant,
}

impl Ladder {
    /// Starts on the best step `budget_kbps` covers.
    pub fn new(steps: Vec<Step>, budget_kbps: u32, now: Instant) -> Self {
        let tier = fit(&steps, 0, budget_kbps);
        Self { steps, tier, up_since: None, up_after: UP_AFTER, below_since: None, climbed_at: None, calm_since: now }
    }

    pub fn step(&self) -> Step {
        self.steps[self.tier]
    }

    /// New steps (the picked quality or the capture size changed): the same height and fps if
    /// still there, else the nearest step that isn't better than the current one.
    pub fn set_steps(&mut self, steps: Vec<Step>) {
        let now = self.step();
        self.tier = steps.iter().position(|s| s.height <= now.height && s.fps <= now.fps).unwrap_or(steps.len() - 1);
        self.steps = steps;
        self.up_since = None;
    }

    /// `budget_kbps`: what the encoder may spend now. Returns the new step when it changes.
    pub fn update(&mut self, budget_kbps: u32, now: Instant) -> Option<usize> {
        if now - self.calm_since >= CALM {
            self.up_after = (self.up_after / 2).max(UP_AFTER);
            self.calm_since = now;
        }
        let min = self.steps[self.tier].min_kbps;
        if budget_kbps < min {
            let since = *self.below_since.get_or_insert(now);
            if (budget_kbps as f64) < min as f64 * DOWN_AT_ONCE || now - since >= DOWN_AFTER {
                return Some(self.down(fit(&self.steps, self.tier, budget_kbps), now));
            }
        } else {
            self.below_since = None;
        }
        if self.tier == 0 || (budget_kbps as f64) < self.steps[self.tier - 1].min_kbps as f64 * UP_HEADROOM {
            self.up_since = None;
            return None;
        }
        let since = *self.up_since.get_or_insert(now);
        if now - since < self.up_after {
            return None;
        }
        self.tier -= 1;
        self.up_since = None;
        self.climbed_at = Some(now);
        Some(self.tier)
    }

    /// The current step doesn't fit whatever the budget says (the send queue keeps growing): one
    /// step down, if there is one.
    pub fn too_big(&mut self, now: Instant) -> Option<usize> {
        (self.tier + 1 < self.steps.len()).then(|| self.down(self.tier + 1, now))
    }

    fn down(&mut self, tier: usize, now: Instant) -> usize {
        let failed_climb = self.climbed_at.is_some_and(|t| now - t < HELD);
        self.up_after = (self.up_after * if failed_climb { 4 } else { 2 }).min(UP_AFTER_MAX);
        (self.tier, self.up_since, self.below_since, self.climbed_at, self.calm_since) = (tier, None, None, None, now);
        tier
    }
}

/// The best step from `from` down that `budget_kbps` covers.
fn fit(steps: &[Step], from: usize, budget_kbps: u32) -> usize {
    (from..steps.len()).find(|&t| budget_kbps >= steps[t].min_kbps).unwrap_or(steps.len() - 1)
}

/// Loss-based limit, as in Google's congestion control: the delay-based estimate can stay above a
/// lossy link (measured: ~2.7 Mbps on a simulated 1.5 Mbps uplink that dropped 286 packets).
/// Above 10% loss the limit becomes `sending * (1 - loss/2)`; below 2% it grows 8% per report and
/// goes away once it passes `estimate`; in between it holds.
pub fn loss_limit(limit: Option<u32>, sending_kbps: u32, estimate_kbps: u32, loss: f32) -> Option<u32> {
    if loss > 0.10 {
        let cut = (sending_kbps as f64 * (1.0 - 0.5 * loss as f64)).round() as u32;
        return Some(limit.map_or(cut, |l| l.min(cut)));
    }
    if loss < 0.02 {
        return limit.map(|l| (l as f64 * 1.08) as u32 + 1).filter(|&l| l < estimate_kbps);
    }
    limit
}

#[cfg(test)]
mod tests {
    use super::*;

    const FHD: (u32, u32) = (1920, 1080);
    fn shape(steps: &[Step]) -> Vec<(u32, u32)> {
        steps.iter().map(|s| (s.height, s.fps)).collect()
    }
    fn at(t0: Instant, ms: u64) -> Instant {
        t0 + Duration::from_millis(ms)
    }

    #[test]
    fn detail_keeps_the_resolution_and_motion_keeps_the_frame_rate() {
        assert_eq!(shape(&steps(1080, 60, 7500, FHD, true)), [(1080, 60), (1080, 30), (1080, 15), (720, 15), (540, 10), (360, 10)]);
        assert_eq!(shape(&steps(1080, 60, 7500, FHD, false)), [(1080, 60), (720, 60), (720, 30), (540, 30), (360, 30), (360, 15)]);
        // Never above the pick, no repeats.
        assert_eq!(shape(&steps(720, 30, 2000, FHD, true)), [(720, 30), (720, 15), (540, 10), (360, 10)]);
        assert_eq!(shape(&steps(1440, 60, 12000, (2560, 1440), true)), [(1440, 60), (1440, 30), (1440, 15), (1080, 15), (720, 15), (540, 10), (360, 10)]);
    }

    #[test]
    fn minimums_follow_the_pixels_and_each_cap_reaches_past_the_step_above() {
        let s = steps(1080, 60, 7500, FHD, true);
        assert_eq!(s[0].min_kbps, 3732); // 1920x1080, 45 effective fps, 0.04 bpp
        assert_eq!(s[1].min_kbps, 2488);
        assert_eq!(s.last().unwrap().min_kbps, 0);
        assert_eq!(s[0].max_kbps, 7500); // the pick
        for i in 1..s.len() {
            assert!(s[i].max_kbps as f64 >= s[i - 1].min_kbps as f64 * UP_HEADROOM - 1.0, "step {i}");
            assert!(s[i].max_kbps <= 7500);
        }
    }

    #[test]
    fn starts_on_the_step_the_budget_covers() {
        let t0 = Instant::now();
        assert_eq!(Ladder::new(steps(1080, 60, 7500, FHD, true), 6000, t0).tier, 0);
        assert_eq!(Ladder::new(steps(1080, 60, 7500, FHD, true), 3000, t0).tier, 1);
        assert_eq!(Ladder::new(steps(1080, 60, 7500, FHD, true), 10, t0).tier, 5);
    }

    #[test]
    fn steps_down_after_2_s_under_the_minimum_or_at_once_far_under_it() {
        let t0 = Instant::now();
        let mut l = Ladder::new(steps(1080, 60, 7500, FHD, true), 6000, t0);
        assert_eq!(l.update(3600, at(t0, 0)), None); // just under 3732: wait
        assert_eq!(l.update(3600, at(t0, 1500)), None);
        assert_eq!(l.update(3600, at(t0, 2000)), Some(1));
        let mut l = Ladder::new(steps(1080, 60, 7500, FHD, true), 6000, t0);
        assert_eq!(l.update(2000, at(t0, 0)), Some(2)); // under 80%: at once, as far as needed
        let mut l = Ladder::new(steps(1080, 60, 7500, FHD, true), 6000, t0);
        assert_eq!(l.update(3600, at(t0, 0)), None);
        assert_eq!(l.update(5000, at(t0, 1000)), None); // back up: the 2 s start over
        assert_eq!(l.update(3600, at(t0, 2500)), None);
    }

    #[test]
    fn climbs_one_step_after_3_s_of_headroom() {
        let t0 = Instant::now();
        let mut l = Ladder::new(steps(1080, 60, 7500, FHD, true), 1300, t0); // 1080p15
        assert_eq!(l.tier, 2);
        assert_eq!(l.update(9000, at(t0, 0)), None);
        assert_eq!(l.update(9000, at(t0, 2000)), None);
        assert_eq!(l.update(3000, at(t0, 2500)), None); // 3000 < 2488 * 1.3: the wait starts over
        assert_eq!(l.update(9000, at(t0, 3000)), None);
        assert_eq!(l.update(9000, at(t0, 6000)), Some(1)); // one step only
        assert_eq!(l.update(9000, at(t0, 7000)), None); // the wait starts over after each step
        assert_eq!(l.update(9000, at(t0, 10000)), Some(0));
    }

    #[test]
    fn a_climb_that_does_not_hold_waits_4_times_longer() {
        let t0 = Instant::now();
        let mut l = Ladder::new(steps(1080, 60, 7500, FHD, true), 3000, t0); // 1080p30
        assert_eq!(l.update(9000, at(t0, 0)), None);
        assert_eq!(l.update(9000, at(t0, 3000)), Some(0));
        assert_eq!(l.update(2000, at(t0, 5000)), Some(2)); // fell 2 s after climbing: 12 s now
        assert_eq!(l.update(9000, at(t0, 6000)), None);
        assert_eq!(l.update(9000, at(t0, 17000)), None);
        assert_eq!(l.update(9000, at(t0, 18000)), Some(1));
        assert_eq!(l.update(1500, at(t0, 40000)), Some(2)); // held 22 s: only x2, 24 s
        assert_eq!(l.update(9000, at(t0, 40000)), None);
        assert_eq!(l.update(9000, at(t0, 63000)), None);
        assert_eq!(l.update(9000, at(t0, 64000)), Some(1));
    }

    #[test]
    fn the_wait_stops_at_2_min_and_halves_after_a_calm_minute() {
        let t0 = Instant::now();
        let mut l = Ladder::new(steps(1080, 60, 7500, FHD, true), 3000, t0);
        for _ in 0..6 {
            l.climbed_at = Some(t0);
            l.down(1, t0);
        }
        assert_eq!(l.up_after, UP_AFTER_MAX);
        l.update(3000, at(t0, 60_000)); // a calm minute
        assert_eq!(l.up_after, Duration::from_secs(60));
    }

    #[test]
    fn too_big_steps_down_once_and_stops_at_the_bottom() {
        let t0 = Instant::now();
        let mut l = Ladder::new(steps(720, 30, 2000, FHD, true), 9000, t0);
        assert_eq!(l.too_big(t0), Some(1));
        assert_eq!(l.too_big(t0), Some(2));
        assert_eq!(l.too_big(t0), Some(3));
        assert_eq!(l.too_big(t0), None);
    }

    #[test]
    fn new_steps_keep_the_current_size_when_they_can() {
        let t0 = Instant::now();
        let mut l = Ladder::new(steps(1080, 60, 7500, FHD, true), 3000, t0); // 1080p30
        l.set_steps(steps(1080, 30, 5000, FHD, true));
        assert_eq!((l.step().height, l.step().fps), (1080, 30));
        l.set_steps(steps(720, 30, 2000, FHD, true));
        assert_eq!((l.step().height, l.step().fps), (720, 30));
    }

    #[test]
    fn step_sizes_keep_the_aspect_and_never_upscale() {
        assert_eq!(step_size((1920, 1080), 720), (1280, 720));
        assert_eq!(step_size((2560, 1440), 540), (960, 540));
        assert_eq!(step_size((1366, 768), 1080), (1366, 768));
    }

    #[test]
    fn loss_limit_cuts_on_heavy_loss_holds_on_some_and_fades_without() {
        assert_eq!(loss_limit(None, 2000, 3000, 0.01), None);
        assert_eq!(loss_limit(None, 2000, 3000, 0.20), Some(1800));
        assert_eq!(loss_limit(Some(1000), 2000, 3000, 0.20), Some(1000)); // never raised by a cut
        assert_eq!(loss_limit(Some(1800), 1800, 3000, 0.05), Some(1800));
        assert_eq!(loss_limit(Some(1800), 1800, 3000, 0.0), Some(1945));
        assert_eq!(loss_limit(Some(2900), 2900, 3000, 0.0), None); // passed the estimate: gone
    }
}
