//! Exercises the production effect gate around real runtime transitions, with
//! physical writes paused at the same boundary as native window operations.
use crate::window_chain::WindowChains;
use crate::window_chain_runtime::{with_effect_gate, Motion, Point, Rect, WindowChainRuntime};
use std::collections::BTreeMap;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(5);
const QUEUED: Duration = Duration::from_millis(50);

struct World {
    runtime: WindowChainRuntime,
    rectangles: BTreeMap<String, Rect>,
    observed_begin: Option<Point>,
    effects: Vec<&'static str>,
}

impl World {
    fn new() -> Self {
        let rectangles = BTreeMap::from([
            (
                "card-a".to_owned(),
                Rect { x: 10.0, y: 20.0, width: 200.0, height: 100.0 },
            ),
            (
                "card-b".to_owned(),
                Rect { x: 10.0, y: 120.0, width: 200.0, height: 80.0 },
            ),
        ]);
        let mut runtime = WindowChainRuntime::default();
        runtime.chains = WindowChains::from_links(BTreeMap::from([(
            "card-a".to_owned(),
            "card-b".to_owned(),
        )]));
        assert!(runtime.begin("card-a", rectangles.clone(), true));
        Self { runtime, rectangles, observed_begin: None, effects: Vec::new() }
    }

    fn apply(&mut self, motion: Motion, name: &'static str) {
        for (label, point) in motion.positions {
            let rectangle = self.rectangles.get_mut(&label).unwrap();
            rectangle.x = point.x;
            rectangle.y = point.y;
        }
        self.effects.push(name);
    }

    fn original_positions(&self) -> BTreeMap<String, Point> {
        self.rectangles.iter().map(|(label, rect)| (label.clone(), rect.position())).collect()
    }
}

#[test]
fn cancel_waits_for_an_older_move_effect_and_no_obsolete_move_follows_the_restore() {
    let gate = Arc::new(tokio::sync::Mutex::new(()));
    let world = Arc::new(Mutex::new(World::new()));
    let original = world.lock().unwrap().original_positions();
    let (paused_tx, paused_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let move_gate = Arc::clone(&gate);
    let move_world = Arc::clone(&world);
    let moving = std::thread::spawn(move || {
        tauri::async_runtime::block_on(with_effect_gate(&move_gate, || {
            let motion = move_world.lock().unwrap().runtime.preview(
                "card-a",
                Point { x: 300.0, y: 400.0 },
                Point { x: 300.0, y: 400.0 },
                12.0,
            ).unwrap();
            paused_tx.send(()).map_err(|error| error.to_string())?;
            release_rx.recv_timeout(WAIT).map_err(|error| error.to_string())?;
            move_world.lock().unwrap().apply(motion, "move");
            Ok(())
        }))
    });
    paused_rx.recv_timeout(WAIT).unwrap();
    let (attempt_tx, attempt_rx) = mpsc::sync_channel(1);
    let (applied_tx, applied_rx) = mpsc::sync_channel(1);
    let cancel_world = Arc::clone(&world);
    let cancelling = std::thread::spawn(move || {
        attempt_tx.send(()).unwrap();
        tauri::async_runtime::block_on(with_effect_gate(&gate, || {
            let mut world = cancel_world.lock().unwrap();
            let motion = world.runtime.cancel("card-a").unwrap();
            world.apply(motion, "cancel");
            applied_tx.send(()).map_err(|error| error.to_string())?;
            Ok(())
        }))
    });
    attempt_rx.recv_timeout(WAIT).unwrap();
    let cancelled_before_old_effect = applied_rx.recv_timeout(QUEUED).is_ok();
    release_tx.send(()).unwrap();
    moving.join().unwrap().unwrap();
    cancelling.join().unwrap().unwrap();
    let world = world.lock().unwrap();
    assert_eq!(world.original_positions(), original, "cancel must be the last physical write: {:?}", world.effects);
    assert_eq!(world.effects, ["move", "cancel"]);
    assert!(!cancelled_before_old_effect);
    assert!(world.runtime.active_label().is_none());
}

#[test]
fn a_new_begin_reads_geometry_only_after_the_older_cancel_has_physically_restored_it() {
    let gate = Arc::new(tokio::sync::Mutex::new(()));
    let mut initial = World::new();
    let original = initial.rectangles["card-a"].position();
    let motion = initial.runtime.preview(
        "card-a",
        Point { x: 300.0, y: 400.0 },
        Point { x: 300.0, y: 400.0 },
        12.0,
    ).unwrap();
    initial.apply(motion, "initial-move");
    initial.effects.clear();
    let world = Arc::new(Mutex::new(initial));
    let (paused_tx, paused_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let cancel_gate = Arc::clone(&gate);
    let cancel_world = Arc::clone(&world);
    let cancelling = std::thread::spawn(move || {
        tauri::async_runtime::block_on(with_effect_gate(&cancel_gate, || {
            let motion = cancel_world.lock().unwrap().runtime.cancel("card-a").unwrap();
            paused_tx.send(()).map_err(|error| error.to_string())?;
            release_rx.recv_timeout(WAIT).map_err(|error| error.to_string())?;
            cancel_world.lock().unwrap().apply(motion, "cancel");
            Ok(())
        }))
    });
    paused_rx.recv_timeout(WAIT).unwrap();
    let (attempt_tx, attempt_rx) = mpsc::sync_channel(1);
    let (begun_tx, begun_rx) = mpsc::sync_channel(1);
    let begin_world = Arc::clone(&world);
    let beginning = std::thread::spawn(move || {
        attempt_tx.send(()).unwrap();
        tauri::async_runtime::block_on(with_effect_gate(&gate, || {
            let mut world = begin_world.lock().unwrap();
            let rectangles = world.rectangles.clone();
            world.observed_begin = Some(rectangles["card-a"].position());
            assert!(world.runtime.begin("card-a", rectangles, true));
            world.effects.push("begin");
            begun_tx.send(()).map_err(|error| error.to_string())?;
            Ok(())
        }))
    });
    attempt_rx.recv_timeout(WAIT).unwrap();
    let began_before_restore = begun_rx.recv_timeout(QUEUED).is_ok();
    release_tx.send(()).unwrap();
    cancelling.join().unwrap().unwrap();
    beginning.join().unwrap().unwrap();
    let mut world = world.lock().unwrap();
    assert_eq!(world.observed_begin, Some(original), "new snapshots must not capture cancelled preview geometry: {:?}", world.effects);
    assert_eq!(world.effects, ["cancel", "begin"]);
    assert!(!began_before_restore);
    assert_eq!(world.runtime.cancel("card-a").unwrap().positions["card-a"], original);
}
