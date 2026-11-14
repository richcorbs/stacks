//! Reusable terminal surface for Stacks' native (GPUI) experiments.
//!
//! Extracted from the card #318 spike so both the demo host
//! (`spikes/gpui-terminal`) and the app-shell spike (`apps/stacks-gpui`) consume
//! one implementation. See `HOST_INTEGRATION.md` for the host contract.

pub mod fixtures;
pub mod keymap;
pub mod parity;
pub mod pty;
pub mod split_tree;
pub mod terminal_model;
pub mod terminal_surface;
