//! Isolated GPUI + libghostty-vt spike for Stacks' Cmd+T global terminal.
//!
//! Nothing in this crate is a dependency of the shipped Tauri app.

pub mod app;
pub mod fixtures;
pub mod host_ipc;
pub mod keymap;
#[cfg(target_os = "macos")]
pub mod mac_front;
pub mod parity;
pub mod pty;
pub mod split_tree;
pub mod terminal_model;
pub mod terminal_surface;
