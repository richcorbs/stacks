//! Pure split-tree math for terminal panes.

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
                second: Box::new(Self::leaf(new_pane_id)),
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

    /// Remove a leaf, promoting its sibling. Returns `None` when the last pane
    /// is removed (the caller decides whether to keep the workspace alive).
    pub fn close(&self, target: &str) -> Option<Self> {
        match self {
            Self::Leaf { pane_id } => (pane_id != target).then(|| self.clone()),
            Self::Split { first, second, .. } => {
                match (first.close(target), second.close(target)) {
                    (Some(first), Some(second)) => Some(Self::Split {
                        direction: match self {
                            Self::Split { direction, .. } => *direction,
                            Self::Leaf { .. } => SplitDirection::Row,
                        },
                        ratio: match self {
                            Self::Split { ratio, .. } => *ratio,
                            Self::Leaf { .. } => 0.5,
                        },
                        manual: match self {
                            Self::Split { manual, .. } => *manual,
                            Self::Leaf { .. } => false,
                        },
                        first: Box::new(first),
                        second: Box::new(second),
                    }),
                    (Some(node), None) | (None, Some(node)) => Some(node),
                    (None, None) => None,
                }
            }
        }
    }

    pub fn set_ratio(&mut self, target_direction: SplitDirection, ratio: f32) {
        if let Self::Split {
            direction,
            ratio: current,
            manual,
            ..
        } = self
        {
            if *direction == target_direction {
                *current = ratio.clamp(0.15, 0.85);
                *manual = true;
            }
        }
    }

    pub fn next_pane(&self, current: &str, forward: bool) -> String {
        let leaves = self.leaves();
        if leaves.is_empty() {
            return current.to_string();
        }
        let index = leaves.iter().position(|pane| pane == current).unwrap_or(0);
        let next = if forward {
            (index + 1) % leaves.len()
        } else {
            (index + leaves.len() - 1) % leaves.len()
        };
        leaves[next].clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_and_closes_without_losing_siblings() {
        let tree = SplitNode::leaf("a");
        let tree = tree.split("a", "b", SplitDirection::Row);
        let tree = tree.split("a", "c", SplitDirection::Column);
        assert_eq!(tree.leaves(), vec!["a", "c", "b"]);
        let tree = tree.close("a").unwrap();
        assert_eq!(tree.leaves(), vec!["c", "b"]);
        let tree = tree.close("b").unwrap();
        assert_eq!(tree.leaves(), vec!["c"]);
        assert!(tree.close("c").is_none());
    }

    #[test]
    fn cycles_in_visual_order() {
        let tree = SplitNode::leaf("a")
            .split("a", "b", SplitDirection::Row)
            .split("b", "c", SplitDirection::Column);
        assert_eq!(tree.next_pane("a", true), "b");
        assert_eq!(tree.next_pane("c", true), "a");
        assert_eq!(tree.next_pane("a", false), "c");
    }
}
