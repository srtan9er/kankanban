//! Native window chains. `next` is the only stored topology; window rectangles,
//! tree parents, focus order, and native window existence belong to the caller.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowChains {
    #[serde(default)]
    pub next: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowChainError {
    SelfAttachment,
    Cycle,
}

impl WindowChains {
    /// Restores topology without retaining stale derived head/previous caches.
    /// The caller must additionally filter labels against its live native windows.
    pub fn from_links(next: BTreeMap<String, String>) -> Self {
        let mut chains = Self { next };
        chains.sanitize(|_| true);
        chains
    }

    /// Keeps a deterministic, acyclic set of live, single-predecessor links.
    /// Earlier source labels win competing links. A link that would close a
    /// cycle is dropped. Disallowed nodes are removed without bridging the gap.
    pub fn sanitize(&mut self, allowed: impl Fn(&str) -> bool) -> bool {
        let mut clean = Self::default();
        let mut predecessors = BTreeSet::new();
        for (from, to) in &self.next {
            if !allowed(from)
                || !allowed(to)
                || from == to
                || predecessors.contains(to)
                || clean.suffix(to).iter().any(|node| node == from)
            {
                continue;
            }
            clean.next.insert(from.clone(), to.clone());
            predecessors.insert(to.clone());
        }
        if self.next == clean.next {
            return false;
        }
        self.next = clean.next;
        true
    }

    pub fn retain(&mut self, allowed: impl Fn(&str) -> bool) -> bool {
        self.sanitize(allowed)
    }

    pub fn prev(&self, node: &str) -> Option<&str> {
        self.next
            .iter()
            .find_map(|(from, to)| (to == node).then_some(from.as_str()))
    }

    pub fn head(&self, node: &str) -> String {
        let mut current = node.to_owned();
        let mut seen = BTreeSet::from([current.clone()]);
        while let Some(previous) = self.prev(&current) {
            if !seen.insert(previous.to_owned()) {
                break;
            }
            current = previous.to_owned();
        }
        current
    }

    pub fn tail(&self, node: &str) -> String {
        self.suffix(node).pop().unwrap_or_else(|| node.to_owned())
    }

    /// Includes `node`, even if the caller's window currently has no links.
    /// Visited guards also make read-only queries safe before sanitizing a save.
    pub fn suffix(&self, node: &str) -> Vec<String> {
        let mut current = node.to_owned();
        let mut result = Vec::new();
        let mut seen = BTreeSet::new();
        while seen.insert(current.clone()) {
            result.push(current.clone());
            match self.next.get(&current) {
                Some(next) => current = next.clone(),
                None => break,
            }
        }
        result
    }

    /// Splits before `node`; all of its followers stay attached to it.
    pub fn detach_suffix(&mut self, node: &str) -> Option<String> {
        let previous = self.prev(node)?.to_owned();
        self.next.remove(&previous);
        Some(previous)
    }

    /// Moves the complete suffix after `target`, preserving target's old suffix.
    /// Rejected operations leave topology unchanged. Mutators expect sanitized
    /// topology, as returned by `from_links` or an explicit live-label sanitize.
    pub fn splice_after(&mut self, target: &str, suffix: &str) -> Result<bool, WindowChainError> {
        if target == suffix {
            return Err(WindowChainError::SelfAttachment);
        }
        let moved = self.suffix(suffix);
        if moved.iter().any(|node| node == target) {
            return Err(WindowChainError::Cycle);
        }
        if self.next.get(target).map(String::as_str) == Some(suffix) {
            return Ok(false);
        }
        let tail = moved.last().expect("suffix always includes its first node").clone();
        self.detach_suffix(suffix);
        let old_next = self.next.remove(target);
        self.next.insert(target.to_owned(), suffix.to_owned());
        if let Some(old_next) = old_next {
            self.next.insert(tail, old_next);
        }
        Ok(true)
    }

    /// Removes one closed window and bridges its previous and next windows.
    /// Isolated windows have no stored links, so removing one is a no-op.
    pub fn remove(&mut self, node: &str) -> bool {
        let previous = self.prev(node).map(str::to_owned);
        let next = self.next.remove(node);
        let changed = previous.is_some() || next.is_some();
        if let Some(previous) = previous {
            self.next.remove(&previous);
            if let Some(next) = next {
                if previous != next {
                    self.next.insert(previous, next);
                }
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(edges: &[(&str, &str)]) -> WindowChains {
        WindowChains {
            next: edges.iter().map(|(a, b)| ((*a).into(), (*b).into())).collect(),
        }
    }

    fn assert_valid(chains: &WindowChains) {
        let mut destinations = BTreeSet::new();
        for (from, to) in &chains.next {
            assert_ne!(from, to);
            assert!(destinations.insert(to), "multiple predecessors for {to}");
            let mut seen = BTreeSet::new();
            let mut current = from;
            while let Some(next) = chains.next.get(current) {
                assert!(seen.insert(current), "cycle through {current}");
                current = next;
            }
        }
    }

    #[test]
    fn queries_derive_head_predecessor_tail_and_suffix() {
        let chains = raw(&[("card-a", "card-b"), ("card-b", "card-c"), ("card-c", "card-d")]);
        assert_eq!(chains.prev("card-c"), Some("card-b"));
        assert_eq!(chains.head("card-c"), "card-a");
        assert_eq!(chains.tail("card-b"), "card-d");
        assert_eq!(chains.suffix("card-b"), ["card-b", "card-c", "card-d"]);
        assert_eq!(chains.prev("card-a"), None);
        assert_eq!(chains.head("card-alone"), "card-alone");
        assert_eq!(chains.tail("card-alone"), "card-alone");
        assert_eq!(chains.suffix("card-alone"), ["card-alone"]);
    }

    #[test]
    fn dragging_detaches_whole_suffix_without_bridging() {
        let mut chains = raw(&[("a", "b"), ("b", "c"), ("c", "d"), ("x", "y")]);
        assert_eq!(chains.detach_suffix("b"), Some("a".into()));
        assert_eq!(chains, raw(&[("b", "c"), ("c", "d"), ("x", "y")]));
        assert_eq!(chains.suffix("b"), ["b", "c", "d"]);
        assert_eq!(chains.detach_suffix("b"), None);
    }

    #[test]
    fn splice_inserts_complete_suffix_and_preserves_target_followers() {
        let mut chains = raw(&[("a", "b"), ("b", "c"), ("c", "d"), ("x", "y"), ("y", "z")]);
        assert_eq!(chains.splice_after("x", "b"), Ok(true));
        assert_eq!(chains.suffix("a"), ["a"]);
        assert_eq!(chains.suffix("x"), ["x", "b", "c", "d", "y", "z"]);
        assert_valid(&chains);
    }

    #[test]
    fn splice_can_reorder_a_suffix_before_an_earlier_sibling() {
        let mut chains = raw(&[("a", "b"), ("b", "c"), ("c", "d")]);
        assert_eq!(chains.splice_after("a", "c"), Ok(true));
        assert_eq!(chains.suffix("a"), ["a", "c", "d", "b"]);
        assert_valid(&chains);
    }

    #[test]
    fn splice_handles_standalone_windows_and_target_tail() {
        let mut chains = WindowChains::default();
        assert_eq!(chains.splice_after("a", "b"), Ok(true));
        assert_eq!(chains.splice_after("b", "c"), Ok(true));
        assert_eq!(chains.suffix("a"), ["a", "b", "c"]);
    }

    #[test]
    fn rejected_self_or_descendant_splices_leave_all_links_unchanged() {
        let mut chains = raw(&[("a", "b"), ("b", "c"), ("x", "y")]);
        let original = chains.clone();
        assert_eq!(chains.splice_after("b", "b"), Err(WindowChainError::SelfAttachment));
        assert_eq!(chains, original);
        assert_eq!(chains.splice_after("c", "a"), Err(WindowChainError::Cycle));
        assert_eq!(chains, original);
        assert_eq!(chains.splice_after("b", "a"), Err(WindowChainError::Cycle));
        assert_eq!(chains, original);
    }

    #[test]
    fn splicing_after_current_predecessor_is_an_exact_noop() {
        let mut chains = raw(&[("a", "b"), ("b", "c")]);
        let original = chains.clone();
        assert_eq!(chains.splice_after("a", "b"), Ok(false));
        assert_eq!(chains, original);
    }

    #[test]
    fn closing_middle_window_bridges_its_predecessor_to_successor() {
        let mut chains = raw(&[("a", "b"), ("b", "c"), ("x", "y")]);
        assert!(chains.remove("b"));
        assert_eq!(chains, raw(&[("a", "c"), ("x", "y")]));
        assert!(!chains.remove("b"));
        assert_valid(&chains);
    }

    #[test]
    fn closing_head_or_tail_preserves_remaining_chain() {
        let mut chains = raw(&[("a", "b"), ("b", "c"), ("c", "d")]);
        assert!(chains.remove("a"));
        assert_eq!(chains.head("d"), "b");
        assert!(chains.remove("d"));
        assert_eq!(chains, raw(&[("b", "c")]));
        assert!(!chains.remove("standalone"));
    }

    #[test]
    fn sanitize_filters_nonlive_windows_and_main_without_rejoining_gaps() {
        let mut chains = raw(&[("main", "card-a"), ("card-a", "card-dead"), ("card-dead", "card-b"), ("card-b", "card-c")]);
        let live = BTreeSet::from(["card-a", "card-b", "card-c"]);
        assert!(chains.sanitize(|node| live.contains(node)));
        assert_eq!(chains, raw(&[("card-b", "card-c")]));
        assert!(!chains.sanitize(|node| live.contains(node)));
    }

    #[test]
    fn sanitize_repairs_self_cycles_and_multiple_predecessors_deterministically() {
        let invalid = raw(&[("a", "b"), ("b", "c"), ("c", "a"), ("d", "d"), ("e", "b"), ("x", "y"), ("y", "x")]);
        let mut chains = invalid.clone();
        assert!(chains.sanitize(|_| true));
        assert_eq!(chains, raw(&[("a", "b"), ("b", "c"), ("x", "y")]));
        assert_valid(&chains);
        assert!(!chains.sanitize(|_| true));
        assert_eq!(WindowChains::from_links(invalid.next), chains);
    }

    #[test]
    fn retain_uses_the_same_live_node_filter_as_sanitize() {
        let mut chains = raw(&[("a", "b"), ("b", "c"), ("x", "y")]);
        assert!(chains.retain(|node| node != "b"));
        assert_eq!(chains, raw(&[("x", "y")]));
    }

    #[test]
    fn queries_on_untrusted_unsanitized_cycles_are_finite() {
        let chains = raw(&[("a", "b"), ("b", "c"), ("c", "a")]);
        assert_eq!(chains.suffix("a"), ["a", "b", "c"]);
        assert_eq!(chains.tail("a"), "c");
        assert_eq!(chains.head("a"), "b");
    }

    #[test]
    fn serialized_topology_has_no_derived_head_or_predecessor_cache() {
        let chains = raw(&[("card-1", "card-2")]);
        let json = serde_json::to_value(&chains).unwrap();
        assert_eq!(json, serde_json::json!({ "next": { "card-1": "card-2" } }));
        assert_eq!(serde_json::from_value::<WindowChains>(json).unwrap(), chains);
        assert_eq!(serde_json::from_str::<WindowChains>("{}").unwrap(), WindowChains::default());
    }

    #[test]
    fn every_four_node_graph_repairs_and_mutates_without_breaking_chain_invariants() {
        let nodes = ["a", "b", "c", "d"];
        // Each source has no outgoing link, or points at one of the four nodes.
        for mut encoding in 0..5_usize.pow(4) {
            let mut edges = BTreeMap::new();
            for node in nodes {
                let destination = encoding % 5;
                encoding /= 5;
                if destination > 0 {
                    edges.insert(node.to_owned(), nodes[destination - 1].to_owned());
                }
            }
            let chains = WindowChains::from_links(edges);
            assert_valid(&chains);
            assert!(!chains.clone().sanitize(|_| true));
            for source in nodes {
                let mut detached = chains.clone();
                detached.detach_suffix(source);
                assert_valid(&detached);
                let mut removed = chains.clone();
                removed.remove(source);
                assert_valid(&removed);
                for target in nodes {
                    let mut spliced = chains.clone();
                    if spliced.splice_after(target, source).is_err() {
                        assert_eq!(spliced, chains);
                    }
                    assert_valid(&spliced);
                }
            }
        }
    }
}
