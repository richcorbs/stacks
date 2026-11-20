//! One owner of the split-tree shape and pane classification shared by card
//! environments, Project Workspaces, the top-level terminal and legacy
//! workspaces.
//!
//! Rust only *reads* layouts: the frontend owns mutation and persistence, so a
//! tree is parsed as a view that deliberately drops ratios and `manual` flags.
//! Rust therefore cannot rewrite a layout, but every Rust-side consumer still
//! gets visual order, focus resolution and maximize resolution from one place
//! instead of re-walking `serde_json::Value` itself.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Shared pane classification. `role`/`kind` return the spellings the existing
/// tables already persist, so this enum changes no storage format or wire shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PaneKind {
    Shell,
    Pi,
    Server,
    Console,
}

impl PaneKind {
    /// Parse either persisted vocabulary: a pane `kind` (`terminal`, `pi`) or a
    /// pane `role` (`shell`, `planning`, `work`, `server`, `console`).
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "shell" | "terminal" => Some(Self::Shell),
            "pi" | "planning" | "work" => Some(Self::Pi),
            "server" => Some(Self::Server),
            "console" => Some(Self::Console),
            _ => None,
        }
    }

    pub(crate) fn role(self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Pi => "pi",
            Self::Server => "server",
            Self::Console => "console",
        }
    }

    pub(crate) fn kind(self) -> &'static str {
        match self {
            Self::Pi => "pi",
            _ => "terminal",
        }
    }

    pub(crate) fn is_pi(self) -> bool {
        self == Self::Pi
    }

    pub(crate) fn is_terminal(self) -> bool {
        !self.is_pi()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SplitDirection {
    Row,
    Column,
}

/// Read-only view of a stored layout: leaves in visual order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SplitTree {
    Empty,
    Leaf { pane_id: String },
    Split { direction: SplitDirection, first: Box<SplitTree>, second: Box<SplitTree> },
}

impl SplitTree {
    pub(crate) fn parse(value: &Value) -> Result<Self, &'static str> {
        match value.get("kind").and_then(Value::as_str) {
            Some("empty") => Ok(Self::Empty),
            Some("leaf") => value
                .get("terminalId")
                .and_then(Value::as_str)
                .map(|pane_id| Self::Leaf { pane_id: pane_id.to_string() })
                .ok_or("A split-tree leaf is missing its terminalId"),
            Some("split") => {
                let direction = match value.get("direction").and_then(Value::as_str) {
                    Some("row") => SplitDirection::Row,
                    Some("column") => SplitDirection::Column,
                    _ => return Err("A split-tree split has an unknown direction"),
                };
                Ok(Self::Split {
                    direction,
                    first: Box::new(Self::parse(value.get("first").ok_or("A split-tree split is missing its first child")?)?),
                    second: Box::new(Self::parse(value.get("second").ok_or("A split-tree split is missing its second child")?)?),
                })
            }
            _ => Err("A split-tree node has an unknown kind"),
        }
    }

    /// Leaf pane ids in visual order (left/top before right/bottom).
    pub(crate) fn leaf_ids(&self) -> Vec<&str> {
        match self {
            Self::Empty => Vec::new(),
            Self::Leaf { pane_id } => vec![pane_id.as_str()],
            Self::Split { first, second, .. } => {
                let mut ids = first.leaf_ids();
                ids.extend(second.leaf_ids());
                ids
            }
        }
    }

    /// Leaf pane ids in visual order, or `None` when an id repeats.
    pub(crate) fn unique_leaf_ids(&self) -> Option<Vec<&str>> {
        let ids = self.leaf_ids();
        let mut unique = std::collections::HashSet::with_capacity(ids.len());
        ids.iter().all(|id| unique.insert(*id)).then_some(ids)
    }

    pub(crate) fn contains(&self, pane_id: &str) -> bool {
        self.leaf_ids().contains(&pane_id)
    }

    /// The requested pane when it is still a leaf, otherwise the first leaf.
    pub(crate) fn focused(&self, requested: Option<&str>) -> Option<&str> {
        let ids = self.leaf_ids();
        let index = requested.and_then(|pane_id| ids.iter().position(|id| *id == pane_id));
        index.map_or_else(|| ids.first().copied(), |index| Some(ids[index]))
    }

    /// Maximize only resolves to a leaf that is still in the tree.
    pub(crate) fn maximized(&self, requested: Option<&str>) -> Option<&str> {
        let ids = self.leaf_ids();
        requested
            .filter(|pane_id| self.contains(pane_id))
            .and_then(|pane_id| ids.iter().copied().find(|id| *id == pane_id))
    }
}

/// A layout with no panes. Stored layouts use exactly this JSON.
pub(crate) fn empty_layout() -> Value {
    json!({"kind":"empty"})
}

/// A layout with one leaf pane. Stored layouts use exactly this JSON.
pub(crate) fn single_leaf(pane_id: &str) -> Value {
    json!({"kind":"leaf","terminalId":pane_id})
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic PRNG so a failing property is reproducible from its seed.
    fn random(seed: u64) -> impl FnMut() -> u64 {
        let mut state = seed;
        move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            state >> 33
        }
    }

    fn random_layout(next: &mut impl FnMut() -> u64, leaves: usize, seed: u64) -> Value {
        if leaves <= 1 {
            return single_leaf(&format!("pane:{seed}"));
        }
        let first = 1 + (next() as usize % (leaves - 1));
        json!({
            "kind": "split",
            "direction": if next() % 2 == 0 { "row" } else { "column" },
            "ratio": 0.5,
            "first": random_layout(next, first, seed * 2),
            "second": random_layout(next, leaves - first, seed * 2 + 1),
        })
    }

    #[test]
    fn random_trees_parse_with_stable_visual_order_and_resolvable_focus() {
        for seed in 1..=60u64 {
            let mut next = random(seed);
            let layout = random_layout(&mut next, 2 + seed as usize % 7, seed);
            let tree = SplitTree::parse(&layout).expect("generated layouts are valid");
            let ids = tree.leaf_ids();
            assert_eq!(tree.unique_leaf_ids(), Some(ids.clone()), "seed {seed}: leaves are unique");
            assert_eq!(tree.leaf_ids(), ids, "seed {seed}: visual order is stable");
            let missing = "pane:not-in-tree";
            assert_eq!(tree.focused(Some(missing)), ids.first().copied(), "seed {seed}: focus falls back to the first leaf");
            assert_eq!(tree.focused(ids.last().copied()), ids.last().copied(), "seed {seed}: focus keeps a live leaf");
            assert_eq!(tree.maximized(Some(missing)), None, "seed {seed}: stray maximize resolves away");
            assert_eq!(tree.maximized(ids.get(1).copied()), ids.get(1).copied(), "seed {seed}: maximize keeps a live leaf");
            for id in &ids {
                assert!(tree.contains(id), "seed {seed}: {id} is reachable");
            }
        }
    }

    #[test]
    fn a_layout_that_lost_a_leaf_still_parses_with_the_survivors_in_order() {
        let layout = json!({
            "kind": "split", "direction": "row",
            "first": {"kind": "leaf", "terminalId": "pane:a"},
            "second": {"kind": "split", "direction": "column",
                "first": {"kind": "leaf", "terminalId": "pane:b"},
                "second": {"kind": "leaf", "terminalId": "pane:c"}},
        });
        let before = SplitTree::parse(&layout).unwrap();
        assert_eq!(before.leaf_ids(), vec!["pane:a", "pane:b", "pane:c"]);
        let collapsed = json!({
            "kind": "split", "direction": "row",
            "first": {"kind": "leaf", "terminalId": "pane:a"},
            "second": {"kind": "leaf", "terminalId": "pane:c"},
        });
        let after = SplitTree::parse(&collapsed).unwrap();
        assert_eq!(after.leaf_ids(), vec!["pane:a", "pane:c"]);
        assert_eq!(after.focused(Some("pane:b")), Some("pane:a"));
        assert_eq!(after.maximized(Some("pane:b")), None);
    }

    #[test]
    fn malformed_layouts_are_rejected_and_empty_has_no_leaves() {
        for broken in [
            json!({}),
            json!({"kind": "unknown"}),
            json!({"kind": "leaf"}),
            json!({"kind": "split", "direction": "row", "first": {"kind": "leaf", "terminalId": "pane:a"}}),
            json!({"kind": "split", "direction": "diagonal", "first": {"kind": "leaf", "terminalId": "pane:a"}, "second": {"kind": "leaf", "terminalId": "pane:b"}}),
            json!("leaf"),
        ] {
            assert!(SplitTree::parse(&broken).is_err(), "{broken} should not parse");
        }
        let empty = SplitTree::parse(&empty_layout()).unwrap();
        assert_eq!(empty, SplitTree::Empty);
        assert!(empty.leaf_ids().is_empty());
        assert_eq!(empty.focused(Some("pane:a")), None);
        assert_eq!(empty.maximized(Some("pane:a")), None);
        assert_eq!(empty.unique_leaf_ids(), Some(vec![]));
        let duplicate = json!({"kind": "split", "direction": "row",
            "first": {"kind": "leaf", "terminalId": "pane:a"},
            "second": {"kind": "leaf", "terminalId": "pane:a"}});
        assert_eq!(SplitTree::parse(&duplicate).unwrap().unique_leaf_ids(), None);
    }

    #[test]
    fn panes_classify_every_persisted_spelling() {
        assert_eq!(PaneKind::parse("shell"), Some(PaneKind::Shell));
        assert_eq!(PaneKind::parse("terminal"), Some(PaneKind::Shell));
        assert_eq!(PaneKind::parse("pi"), Some(PaneKind::Pi));
        assert_eq!(PaneKind::parse("planning"), Some(PaneKind::Pi));
        assert_eq!(PaneKind::parse("work"), Some(PaneKind::Pi));
        assert_eq!(PaneKind::parse("server"), Some(PaneKind::Server));
        assert_eq!(PaneKind::parse("console"), Some(PaneKind::Console));
        assert_eq!(PaneKind::parse("custom"), None);
        for kind in [PaneKind::Shell, PaneKind::Pi, PaneKind::Server, PaneKind::Console] {
            assert_eq!(PaneKind::parse(kind.role()), Some(kind));
            assert_eq!(kind.is_terminal(), !kind.is_pi());
        }
        assert_eq!(PaneKind::Shell.kind(), "terminal");
        assert_eq!(PaneKind::Server.kind(), "terminal");
        assert_eq!(PaneKind::Pi.kind(), "pi");
    }

    #[test]
    fn stored_layout_json_is_byte_identical() {
        assert_eq!(empty_layout().to_string(), r#"{"kind":"empty"}"#);
        assert_eq!(single_leaf("pane:a").to_string(), r#"{"kind":"leaf","terminalId":"pane:a"}"#);
    }
}
