//! Localkan local bridge.
//!
//! Connects to the Localkan server over WebSocket, receives card commands, and drives the
//! Orca headless runtime (worktrees, agent terminals, orchestration) on this machine.
//! Source code stays on this machine; only what the UI needs to display (logs, diffs,
//! terminal screens) is sent, after secret redaction.

pub mod browser;
pub mod config;
pub mod context;
pub mod engine;
pub mod git;
pub mod github;
pub mod link;
pub mod orca;
pub mod paths;
pub mod preview;
pub mod protocol;
pub mod redact;
pub mod runtime;
pub mod store;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
