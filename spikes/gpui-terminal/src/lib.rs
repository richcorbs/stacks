//! Demo host for the reusable `stacks-terminal` crate.
//!
//! This crate is the card #318/#319 spike host: it exercises the terminal
//! surface and provides the adjacent-window helper. It is not the app shell.

pub mod app;
pub mod host_ipc;
#[cfg(target_os = "macos")]
pub mod mac_front;
