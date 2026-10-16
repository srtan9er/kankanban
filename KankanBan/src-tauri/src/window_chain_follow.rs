//! Fractional, predecessor-by-predecessor native window following.
//! The caller owns the clock and keeps these positions between ticks; rounded
//! native window coordinates must not overwrite a follower's fractional state.

use crate::window_chain::WindowChains;
use std::collections::{BTreeMap, BTreeSet};

pub const FOLLOW_EASE_RATE: f64 = 64.0;
pub const FOLLOW_MAX_SPEED: f64 = 12800.0;
pub const FOLLOW_EPSILON: f64 = 0.5;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn position(self) -> Point {
        Point { x: self.x, y: self.y }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FollowTick {
    pub positions: BTreeMap<String, Point>,
    pub pending: bool,
}

/// Coordinates are physical pixels; the speed limit is expressed in logical
/// pixels per second. The final correction is at most half a physical pixel.
pub fn chase_point(current: Point, target: Point, dt: f64, scale: f64) -> Point {
    if !dt.is_finite() || dt <= 0.0 || !finite_point(current) || !finite_point(target) {
        return current;
    }
    let dx = target.x - current.x;
    let dy = target.y - current.y;
    let distance = dx.hypot(dy);
    if !distance.is_finite() {
        return current;
    }
    if distance <= FOLLOW_EPSILON {
        return target;
    }
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let eased_f = -(-FOLLOW_EASE_RATE * dt).exp_m1();
    let cap = FOLLOW_MAX_SPEED * scale * dt;
    let step = (distance * eased_f).min(cap);
    if step >= distance {
        return target;
    }
    let fraction = step / distance;
    Point { x: current.x + dx * fraction, y: current.y + dy * fraction }
}

/// Advances each follower towards its predecessor's newly advanced position.
/// Heads stay fixed. An unusable delta performs no motion but keeps `pending`
/// true when the chain still needs to settle, so a clock hiccup cannot end it.
pub fn chase_tick(
    chains: &WindowChains,
    rects: &BTreeMap<String, Rect>,
    dt: f64,
    scale: f64,
) -> FollowTick {
    let mut chains = chains.clone();
    chains.retain(|label| {
        label.starts_with("card-") && label.len() > 5 && rects.get(label).is_some_and(valid_rect)
    });
    let followers: BTreeSet<_> = chains.next.values().collect();
    let mut result = FollowTick::default();
    for head in chains.next.keys().filter(|label| !followers.contains(label)) {
        let mut previous = rects[head];
        for label in chains.suffix(head).into_iter().skip(1) {
            let current = rects[&label];
            let target = Point { x: previous.x, y: previous.y + previous.height };
            let point = chase_point(current.position(), target, dt, scale);
            if point != current.position() {
                result.positions.insert(label, point);
            }
            result.pending |= point != target;
            previous = Rect { x: point.x, y: point.y, ..current };
        }
    }
    result
}

fn finite_point(point: Point) -> bool {
    point.x.is_finite() && point.y.is_finite()
}

fn valid_rect(rect: &Rect) -> bool {
    finite_point(rect.position()) && rect.width.is_finite() && rect.width >= 0.0
        && rect.height.is_finite() && rect.height >= 0.0 && (rect.y + rect.height).is_finite()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, height: f64) -> Rect {
        Rect { x, y, width: 400.0, height }
    }

    fn chain(labels: &[&str]) -> WindowChains {
        WindowChains::from_links(labels.windows(2).map(|pair| (pair[0].into(), pair[1].into())).collect())
    }

    fn near(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-9, "actual={actual}, expected={expected}");
    }

    fn apply(rects: &mut BTreeMap<String, Rect>, tick: &FollowTick) {
        for (label, point) in &tick.positions {
            let rect = rects.get_mut(label).unwrap();
            rect.x = point.x;
            rect.y = point.y;
        }
    }

    #[test]
    fn follows_one_predecessor_with_the_exact_exponential_step() {
        let chains = chain(&["card-head", "card-tail"]);
        let rects = BTreeMap::from([
            ("card-head".into(), rect(90.0, 20.0, 80.0)),
            ("card-tail".into(), rect(-30.0, 90.0, 100.0)),
        ]);
        let before = rects.clone();
        let tick = chase_tick(&chains, &rects, 0.01, 1.0);
        let f = 1.0 - (-64.0_f64 * 0.01).exp();
        let point = tick.positions.get("card-tail").expect("the follower must advance");
        near(point.x, -30.0 + 120.0 * f);
        near(point.y, 90.0 + 10.0 * f);
        assert!(tick.pending);
        assert!(!tick.positions.contains_key("card-head"));
        assert_eq!(rects, before, "the input frame remains owned by the caller");
    }

    #[test]
    fn point_chasing_is_the_same_primitive_for_a_released_head_target() {
        let current = Point { x: 0.0, y: 0.0 };
        let target = Point { x: 100.0, y: 50.0 };
        let f = 1.0 - (-64.0_f64 * 0.01).exp();
        let point = chase_point(current, target, 0.01, 1.0);
        near(point.x, target.x * f);
        near(point.y, target.y * f);
        let capped = chase_point(current, Point { x: 10_000.0, y: 10_000.0 }, 0.01, 2.0);
        near(capped.x.hypot(capped.y), 256.0);
        assert_eq!(chase_point(Point { x: 99.7, y: 49.8 }, target, 0.01, 1.0), target);
        assert_eq!(chase_point(current, target, f64::NAN, 1.0), current);
        assert_eq!(chase_point(current, Point { x: f64::INFINITY, y: 0.0 }, 0.01, 1.0), current);
    }

    #[test]
    fn each_node_chases_the_just_updated_predecessor_on_both_axes() {
        let chains = chain(&["card-a", "card-b", "card-c"]);
        let rects = BTreeMap::from([
            ("card-a".into(), rect(100.0, 50.0, 100.0)),
            ("card-b".into(), rect(0.0, 100.0, 80.0)),
            ("card-c".into(), rect(0.0, 180.0, 60.0)),
        ]);
        let tick = chase_tick(&chains, &rects, 0.01, 1.0);
        let f = 1.0 - (-64.0_f64 * 0.01).exp();
        let b = tick.positions.get("card-b").unwrap();
        let c = tick.positions.get("card-c").unwrap();
        near(b.x, 100.0 * f);
        near(b.y, 100.0 + 50.0 * f);
        near(c.x, 100.0 * f * f);
        near(c.y, 180.0 + 50.0 * f * f);
        assert!(c.x < b.x, "the chain must ripple, rather than move as one lerped body");
        assert!(tick.pending);
    }

    #[test]
    fn speed_limit_caps_the_two_dimensional_vector_and_scales_with_dpi() {
        let chains = chain(&["card-a", "card-b"]);
        let rects = BTreeMap::from([
            ("card-a".into(), rect(10_000.0, 9_900.0, 100.0)),
            ("card-b".into(), rect(0.0, 0.0, 100.0)),
        ]);
        for scale in [1.0, 1.5, 2.0] {
            let tick = chase_tick(&chains, &rects, 0.01, scale);
            let point = tick.positions.get("card-b").unwrap();
            near(point.x.hypot(point.y), 12800.0 * scale * 0.01);
            near(point.x, point.y);
            assert!(tick.pending);
        }
    }

    #[test]
    fn horizontal_and_vertical_following_are_symmetric() {
        let chains = chain(&["card-a", "card-b"]);
        let horizontal = BTreeMap::from([
            ("card-a".into(), rect(300.0, -100.0, 100.0)),
            ("card-b".into(), rect(0.0, 0.0, 100.0)),
        ]);
        let vertical = BTreeMap::from([
            ("card-a".into(), rect(0.0, 200.0, 100.0)),
            ("card-b".into(), rect(0.0, 0.0, 100.0)),
        ]);
        let a = chase_tick(&chains, &horizontal, 0.01, 1.0).positions["card-b"];
        let b = chase_tick(&chains, &vertical, 0.01, 1.0).positions["card-b"];
        near(a.x, b.y);
        near(a.y, b.x);
    }

    #[test]
    fn an_uncapped_single_follower_has_the_same_result_for_split_delta() {
        let chains = chain(&["card-a", "card-b"]);
        let rects = BTreeMap::from([
            ("card-a".into(), rect(100.0, -100.0, 100.0)),
            ("card-b".into(), rect(0.0, 0.0, 100.0)),
        ]);
        let once = chase_tick(&chains, &rects, 0.04, 1.0).positions["card-b"];
        let mut split = rects.clone();
        for _ in 0..2 {
            let tick = chase_tick(&chains, &split, 0.02, 1.0);
            apply(&mut split, &tick);
        }
        near(once.x, split["card-b"].x);
        near(once.y, split["card-b"].y);
    }

    #[test]
    fn subpixel_state_keeps_advancing_when_the_os_pixel_has_not_changed() {
        let chains = chain(&["card-a", "card-b"]);
        let mut rects = BTreeMap::from([
            ("card-a".into(), rect(0.0, 0.0, 100.0)),
            ("card-b".into(), rect(1.05, 100.0, 100.0)),
        ]);
        let tick = chase_tick(&chains, &rects, 1.0 / 240.0, 1.0);
        let point = tick.positions["card-b"];
        assert_eq!(point.x.round(), rects["card-b"].x.round());
        assert!(point.x < rects["card-b"].x);
        assert!(tick.pending);
        apply(&mut rects, &tick);
        for _ in 0..100 {
            let tick = chase_tick(&chains, &rects, 1.0 / 240.0, 1.0);
            apply(&mut rects, &tick);
            if !tick.pending { break; }
        }
        assert_eq!(rects["card-b"].position(), Point { x: 0.0, y: 100.0 });
        assert_eq!(chase_tick(&chains, &rects, 1.0 / 240.0, 1.0), FollowTick::default());
    }

    #[test]
    fn a_half_physical_pixel_final_correction_lands_exactly_and_stops() {
        let chains = chain(&["card-a", "card-b"]);
        for scale in [1.0, 2.0] {
            let mut rects = BTreeMap::from([
                ("card-a".into(), rect(-100.0, -100.0, 100.0)),
                ("card-b".into(), rect(-99.7, 0.2, 100.0)),
            ]);
            let tick = chase_tick(&chains, &rects, 1.0 / 60.0, scale);
            assert_eq!(tick.positions["card-b"], Point { x: -100.0, y: 0.0 });
            assert!(!tick.pending);
            apply(&mut rects, &tick);
            assert_eq!(chase_tick(&chains, &rects, 1.0 / 60.0, scale), FollowTick::default());
        }
    }

    #[test]
    fn a_stopped_head_keeps_settling_the_whole_chain_until_every_node_is_exact() {
        let chains = chain(&["card-a", "card-b", "card-c", "card-d"]);
        let mut rects = BTreeMap::from([
            ("card-a".into(), rect(300.0, 200.0, 80.0)),
            ("card-b".into(), rect(0.0, 80.0, 100.0)),
            ("card-c".into(), rect(0.0, 180.0, 120.0)),
            ("card-d".into(), rect(0.0, 300.0, 60.0)),
        ]);
        let mut stopped = false;
        for _ in 0..1000 {
            let tick = chase_tick(&chains, &rects, 1.0 / 60.0, 1.0);
            assert!(!tick.positions.contains_key("card-a"));
            apply(&mut rects, &tick);
            if !tick.pending { stopped = true; break; }
        }
        assert!(stopped, "fractional chasing must have a finite stopping condition");
        assert_eq!(rects["card-b"].position(), Point { x: 300.0, y: 280.0 });
        assert_eq!(rects["card-c"].position(), Point { x: 300.0, y: 380.0 });
        assert_eq!(rects["card-d"].position(), Point { x: 300.0, y: 500.0 });
        assert_eq!(chase_tick(&chains, &rects, 1.0 / 60.0, 1.0), FollowTick::default());
    }

    #[test]
    fn independent_chains_follow_their_own_heads_and_leave_main_and_isolated_nodes_alone() {
        let chains = WindowChains::from_links(BTreeMap::from([
            ("card-a".into(), "card-b".into()),
            ("card-c".into(), "card-d".into()),
            ("main".into(), "card-isolated".into()),
        ]));
        let rects = BTreeMap::from([
            ("card-a".into(), rect(100.0, 0.0, 100.0)),
            ("card-b".into(), rect(0.0, 100.0, 100.0)),
            ("card-c".into(), rect(-100.0, 0.0, 100.0)),
            ("card-d".into(), rect(0.0, 100.0, 100.0)),
            ("main".into(), rect(500.0, 500.0, 100.0)),
            ("card-isolated".into(), rect(0.0, 0.0, 100.0)),
        ]);
        let tick = chase_tick(&chains, &rects, 0.01, 1.0);
        assert_eq!(tick.positions.keys().map(String::as_str).collect::<Vec<_>>(), ["card-b", "card-d"]);
        assert!(tick.positions["card-b"].x > 0.0);
        assert!(tick.positions["card-d"].x < 0.0);
    }

    #[test]
    fn a_missing_or_nonfinite_rect_breaks_that_path_without_poisoning_other_chains() {
        let chains = WindowChains::from_links(BTreeMap::from([
            ("card-a".into(), "card-missing".into()),
            ("card-missing".into(), "card-b".into()),
            ("card-bad".into(), "card-bad-tail".into()),
            ("card-x".into(), "card-y".into()),
        ]));
        let rects = BTreeMap::from([
            ("card-a".into(), rect(100.0, 0.0, 100.0)),
            ("card-b".into(), rect(0.0, 100.0, 100.0)),
            ("card-bad".into(), rect(f64::NAN, 0.0, 100.0)),
            ("card-bad-tail".into(), rect(0.0, 100.0, 100.0)),
            ("card-x".into(), rect(100.0, 0.0, 100.0)),
            ("card-y".into(), rect(0.0, 100.0, 100.0)),
        ]);
        let tick = chase_tick(&chains, &rects, 0.01, 1.0);
        assert_eq!(tick.positions.keys().map(String::as_str).collect::<Vec<_>>(), ["card-y"]);
        assert!(tick.positions.values().all(|point| point.x.is_finite() && point.y.is_finite()));
    }

    #[test]
    fn invalid_delta_cannot_move_or_terminate_an_unsettled_chain() {
        let chains = chain(&["card-a", "card-b"]);
        let rects = BTreeMap::from([
            ("card-a".into(), rect(100.0, 0.0, 100.0)),
            ("card-b".into(), rect(0.0, 100.0, 100.0)),
        ]);
        for dt in [0.0, -0.1, f64::NAN, f64::INFINITY] {
            let tick = chase_tick(&chains, &rects, dt, 1.0);
            assert!(tick.positions.is_empty());
            assert!(tick.pending, "an unusable clock delta must not silently settle the chain");
        }
    }

    #[test]
    fn invalid_scale_uses_the_default_physical_speed_without_nan() {
        let chains = chain(&["card-a", "card-b"]);
        let rects = BTreeMap::from([
            ("card-a".into(), rect(100_000.0, 0.0, 100.0)),
            ("card-b".into(), rect(0.0, 100.0, 100.0)),
        ]);
        let expected = chase_tick(&chains, &rects, 0.01, 1.0);
        assert!(!expected.positions.is_empty());
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(chase_tick(&chains, &rects, 0.01, scale), expected);
        }
    }
}
