//! The canonical workflow engine now lives in `stacks-core` so the Tauri app
//! and `stacks-tui` cannot drift. Re-export keeps existing `kanban::workflow`
//! paths working while the shell stays a presentation/command adapter.
pub use stacks_core::workflow::*;
