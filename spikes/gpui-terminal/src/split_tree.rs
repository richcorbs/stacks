//! Split-tree model extracted from Stacks' terminal layout semantics.
//!
//! Pure data + operations; no GPUI dependency. The future app-shell card should
//! use this directly instead of reimplementing pane math.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    /// Children side by side.
    Row,
    /// Children stacked.
    Column,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SplitNode {
    Leaf {
        pane_id: String,
    },
    Split {
        direction: SplitDirection,
        ratio: f32,
        #[serde(default)]
        manual: bool,
        first: Box<SplitNode>,
        second: Box<SplitNode>,
    },
}

impl SplitNode {
    pub fn leaf(pane_id: impl Into<String>) -> Self {
        Self::Leaf {
            pane_id: pane_id.into(),
        }
    }

    pub fn leaves(&self) -> Vec<String> {
        match self {
            Self::Leaf { pane_id } => vec![pane_id.clone()],
            Self::Split { first, second, .. } => {
                let mut leaves = first.leaves();
                leaves.extend(second.leaves());
                leaves
            }
        }
    }

    pub fn contains(&self, pane_id: &str) -> bool {
        match self {
            Self::Leaf { pane_id: leaf } => leaf == pane_id,
            Self::Split { first, second, .. } => {
                first.contains(pane_id) || second.contains(pane_id)
            }
        }
    }

    pub fn split(
        &self,
        target: &str,
        new_pane_id: impl Into<String>,
        direction: SplitDirection,
    ) -> Self {
        let new_pane_id = new_pane_id.into();
        match self {
            Self::Leaf { pane_id } if pane_id == target => Self::Split {
                direction,
                ratio: 0.5,
                manual: false,
                first: Box::new(self.clone()),
                second: Box::new(Self::leaf(new_pane_id.clone())),
            },
            Self::Leaf { .. } => self.clone(),
            Self::Split {
                direction: existing,
                ratio,
                manual,
                first,
                second,
            } => Self::Split {
                direction: *existing,
                ratio: *ratio,
                manual: *manual,
                first: Box::new(first.split(target, new_pane_id.clone(), direction)),
                second: Box::new(second.split(target, new_pane_id, direction)),
            },
        }
    }

    pub fn remove(&self, pane_id: &str) -> Option<Self> {
        match self {
            Self::Leaf { pane_id: leaf } => (leaf != pane_id).then(|| self.clone()),
            Self::Split {
                direction,
                ratio,
                manual,
                first,
                second,
            } => match (first.remove(pane_id), second.remove(pane_id)) {
                (Some(first), Some(second)) => Some(Self::Split {
                    direction: *direction,
                    ratio: *ratio,
                    manual: *manual,
                    first: Box::new(first),
                    second: Box::new(second),
                }),
                (Some(only), None) | (None, Some(only)) => Some(only),
                (None, None) => None,
            },
        }
    }

    pub fn set_ratio(&self, path: &str, ratio: f32) -> Self {
        let Self::Split {
            direction,
            ratio: current,
            manual,
            first,
            second,
        } = self
        else {
            return self.clone();
        };
        let ratio = ratio.clamp(0.1, 0.9);
        if path.is_empty() {
            return Self::Split {
                direction: *direction,
                ratio,
                manual: true,
                first: first.clone(),
                second: second.clone(),
            };
        }
        let (head, rest) = path.split_once('.').unwrap_or((path, ""));
        Self::Split {
            direction: *direction,
            ratio: *current,
            manual: *manual,
            first: if head == "first" {
                Box::new(first.set_ratio(rest, ratio))
            } else {
                first.clone()
            },
            second: if head == "second" {
                Box::new(second.set_ratio(rest, ratio))
            } else {
                second.clone()
            },
        }
    }

    pub fn relative_pane(&self, focused: &str, direction: i8) -> Option<String> {
        let leaves = self.leaves();
        let index = leaves.iter().position(|pane| pane == focused)?;
        if leaves.len() < 2 {
            return None;
        }
        let next = (index as i8 + direction).rem_euclid(leaves.len() as i8) as usize;
        Some(leaves[next].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_and_collect_in_visual_order() {
        let tree = SplitNode::leaf("a")
            .split("a", "b", SplitDirection::Row)
            .split("b", "c", SplitDirection::Column);
        assert_eq!(tree.leaves(), ["a", "b", "c"]);
        assert!(tree.contains("a"));
        assert!(!tree.contains("z"));
    }

    #[test]
    fn remove_collapses_the_tree() {
        let tree = SplitNode::leaf("a").split("a", "b", SplitDirection::Row);
        assert_eq!(tree.remove("b"), Some(SplitNode::leaf("a")));
        assert_eq!(tree.remove("a"), Some(SplitNode::leaf("b")));
        assert_eq!(SplitNode::leaf("a").remove("a"), None);
    }

    #[test]
    fn ratio_is_clamped_and_manual() {
        let tree = SplitNode::leaf("a").split("a", "b", SplitDirection::Row);
        let resized = tree.set_ratio("", 2.0);
        let SplitNode::Split { ratio, manual, .. } = resized else {
            panic!("expected split");
        };
        assert_eq!(ratio, 0.9);
        assert!(manual);
        assert_eq!(tree.set_ratio("first", 0.25), tree);
    }

    #[test]
    fn relative_pane_wraps() {
        let tree = SplitNode::leaf("a")
            .split("a", "b", SplitDirection::Row)
            .split("b", "c", SplitDirection::Row);
        assert_eq!(tree.relative_pane("a", 1), Some("b".into()));
        assert_eq!(tree.relative_pane("c", 1), Some("a".into()));
        assert_eq!(tree.relative_pane("a", -1), Some("c".into()));
        assert_eq!(SplitNode::leaf("a").relative_pane("a", 1), None);
    }
}
