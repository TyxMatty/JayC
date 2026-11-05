//! Quality ladder: resolution and frame rate that fit the bandwidth budget. Steps down at once when
//! the budget no longer covers the current step; steps up one at a time, only after the budget has
//! covered the next step with headroom for a while (so a noisy estimate doesn't flip-flop).

use std::time::{Duration, Instant};

pub struct Tier {
    pub height: u32,
    pub fps: u32,
    /// Below this the step looks worse than the next one down.
    pub min_kbps: u32,
    /// More than this barely shows at this size.
    pub max_kbps: u32,
}

pub const TIERS: [Tier; 4] = [
    Tier { height: 1080, fps: 60, min_kbps: 2500, max_kbps: u32::MAX },
    Tier { height: 720, fps: 30, min_kbps: 1000, max_kbps: 2500 },
    Tier { height: 540, fps: 30, min_kbps: 500, max_kbps: 1200 },
    Tier { height: 360, fps: 15, min_kbps: 0, max_kbps: 600 },
];

const UP_HEADROOM: f64 = 1.3;
const UP_AFTER: Duration = Duration::from_secs(3);

pub struct Ladder {
    pub tier: usize,
    up_since: Option<Instant>,
}

impl Ladder {
    /// Starts on the best step `budget_kbps` covers.
    pub fn new(budget_kbps: u32) -> Self {
        Self { tier: (0..TIERS.len()).find(|&t| budget_kbps >= TIERS[t].min_kbps).unwrap(), up_since: None }
    }

    /// `budget_kbps`: what the encoder may spend now. Returns the new step when it changes.
    pub fn update(&mut self, budget_kbps: u32, now: Instant) -> Option<usize> {
        if budget_kbps < TIERS[self.tier].min_kbps {
            self.tier = (self.tier..TIERS.len()).find(|&t| budget_kbps >= TIERS[t].min_kbps).unwrap();
            self.up_since = None;
            return Some(self.tier);
        }
        if self.tier == 0 || (budget_kbps as f64) < TIERS[self.tier - 1].min_kbps as f64 * UP_HEADROOM {
            self.up_since = None;
            return None;
        }
        let since = *self.up_since.get_or_insert(now);
        if now - since < UP_AFTER {
            return None;
        }
        self.tier -= 1;
        self.up_since = None;
        Some(self.tier)
    }
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

    #[test]
    fn starts_on_the_step_the_budget_covers() {
        assert_eq!(Ladder::new(6000).tier, 0);
        assert_eq!(Ladder::new(1275).tier, 1);
        assert_eq!(Ladder::new(100).tier, 3);
    }

    #[test]
    fn drops_at_once_possibly_several_steps() {
        let t0 = Instant::now();
        let mut l = Ladder::new(6000);
        assert_eq!(l.update(5000, t0), None);
        assert_eq!(l.update(400, t0), Some(3));
    }

    #[test]
    fn climbs_one_step_after_3_s_of_headroom_and_restarts_the_wait_on_a_dip() {
        let t0 = Instant::now();
        let s = |n: u64| t0 + Duration::from_secs(n);
        let mut l = Ladder::new(400); // 360p
        assert_eq!(l.update(5000, s(0)), None);
        assert_eq!(l.update(5000, s(2)), None);
        assert_eq!(l.update(600, s(2)), None); // not enough headroom for 540p: wait restarts
        assert_eq!(l.update(5000, s(3)), None);
        assert_eq!(l.update(5000, s(6)), Some(2)); // one step only
        assert_eq!(l.update(5000, s(7)), None);
        assert_eq!(l.update(5000, s(9)), None); // the wait restarts after each step
        assert_eq!(l.update(5000, s(10)), Some(1));
        assert_eq!(l.update(3000, s(14)), None); // 3000 < 2500 * 1.3: stays at 720p
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
