//! Pure pin state derived from each native window chain's head.
use crate::window_chain::WindowChains;
use std::collections::BTreeMap;

/// Returns all known windows with each chain member inheriting its head's pin.
pub fn inherited_pins(chains: &WindowChains, pins: &BTreeMap<String, bool>) -> BTreeMap<String, bool> {
    let chains = without_main(chains);
    pins.iter().map(|(member, own)| {
        let head = chains.head(member);
        (member.clone(), pins.get(&head).copied().unwrap_or(*own))
    }).collect()
}

/// Returns changed pin values for the requested member's entire native chain.
pub fn pin_chain(chains: &WindowChains, pins: &BTreeMap<String, bool>, member: &str, pinned: bool) -> BTreeMap<String, bool> {
    let chains = without_main(chains);
    chains.suffix(&chains.head(member)).into_iter()
        .filter(|label| pins.get(label).copied() != Some(pinned))
        .map(|label| (label, pinned)).collect()
}

fn without_main(chains: &WindowChains) -> WindowChains {
    let mut chains = chains.clone();
    chains.retain(|label| label != "main");
    chains
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain(edges: &[(&str, &str)]) -> WindowChains {
        WindowChains::from_links(edges.iter().map(|(a, b)| ((*a).into(), (*b).into())).collect())
    }

    fn pins(values: &[(&str, bool)]) -> BTreeMap<String, bool> {
        values.iter().map(|(label, pinned)| ((*label).into(), *pinned)).collect()
    }

    #[test]
    fn joining_chains_inherits_the_target_head_including_its_original_followers() {
        let mut chains = chain(&[("card-a", "card-b"), ("card-x", "card-y")]);
        let before = pins(&[("card-a", true), ("card-b", true), ("card-x", false), ("card-y", false), ("card-other", false)]);
        chains.splice_after("card-a", "card-x").unwrap();
        assert_eq!(inherited_pins(&chains, &before), pins(&[("card-a", true), ("card-b", true), ("card-x", true), ("card-y", true), ("card-other", false)]));
    }

    #[test]
    fn detaching_a_suffix_preserves_its_last_inherited_pin_state() {
        let mut chains = chain(&[("card-a", "card-b"), ("card-b", "card-c")]);
        let inherited = inherited_pins(&chains, &pins(&[("card-a", true), ("card-b", false), ("card-c", false)]));
        chains.detach_suffix("card-b");
        assert_eq!(inherited_pins(&chains, &inherited), pins(&[("card-a", true), ("card-b", true), ("card-c", true)]));
    }

    #[test]
    fn closing_the_head_preserves_its_pin_on_the_remaining_chain() {
        let mut chains = chain(&[("card-a", "card-b"), ("card-b", "card-c")]);
        let mut inherited = inherited_pins(&chains, &pins(&[("card-a", true), ("card-b", false), ("card-c", false)]));
        chains.remove("card-a");
        inherited.remove("card-a");
        assert_eq!(inherited_pins(&chains, &inherited), pins(&[("card-b", true), ("card-c", true)]));
    }

    #[test]
    fn requesting_pin_from_a_middle_member_delegates_to_the_head_and_whole_chain() {
        let chains = chain(&[("card-a", "card-b"), ("card-b", "card-c")]);
        let before = pins(&[("card-a", false), ("card-b", false), ("card-c", false), ("card-other", false)]);
        assert_eq!(pin_chain(&chains, &before, "card-b", true), pins(&[("card-a", true), ("card-b", true), ("card-c", true)]));
    }

    #[test]
    fn pin_updates_only_include_members_whose_value_needs_to_change() {
        let chains = chain(&[("card-a", "card-b"), ("card-b", "card-c")]);
        let before = pins(&[("card-a", true), ("card-b", false), ("card-c", true)]);
        assert_eq!(pin_chain(&chains, &before, "card-c", true), pins(&[("card-b", true)]));
        assert!(pin_chain(&chains, &pins(&[("card-a", true), ("card-b", true), ("card-c", true)]), "card-a", true).is_empty());
    }

    #[test]
    fn full_expansion_labels_do_not_merge_separate_windows_of_the_same_card() {
        let chains = chain(&[("card-same__one", "card-child__one")]);
        let before = pins(&[("card-same__one", true), ("card-child__one", false), ("card-same__two", false)]);
        assert_eq!(inherited_pins(&chains, &before), pins(&[("card-same__one", true), ("card-child__one", true), ("card-same__two", false)]));
        assert_eq!(pin_chain(&chains, &before, "card-same__two", true), pins(&[("card-same__two", true)]));
    }

    #[test]
    fn main_is_an_independent_singleton_even_if_untrusted_links_contain_it() {
        let chains = chain(&[("main", "card-a"), ("card-a", "card-b")]);
        let before = pins(&[("main", true), ("card-a", false), ("card-b", true)]);
        assert_eq!(inherited_pins(&chains, &before), pins(&[("main", true), ("card-a", false), ("card-b", false)]));
        assert_eq!(pin_chain(&chains, &before, "main", false), pins(&[("main", false)]));
        assert_eq!(pin_chain(&chains, &before, "card-b", true), pins(&[("card-a", true)]));
    }

    #[test]
    fn missing_head_preferences_preserve_each_known_members_own_value() {
        let chains = chain(&[("card-a", "card-b"), ("card-b", "card-c")]);
        let before = pins(&[("card-b", true), ("card-c", false), ("card-alone", true)]);
        assert_eq!(inherited_pins(&chains, &before), before);
        assert_eq!(pin_chain(&chains, &before, "card-b", true), pins(&[("card-a", true), ("card-c", true)]));
    }
}
