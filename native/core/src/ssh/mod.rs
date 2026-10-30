//! Owned SSH transports. Application commands, workspace URLs and renderer ownership stay in TypeScript.

pub mod config;
mod known_hosts;
mod protocol;
mod service;
pub use service::{Action, SshOptions, SshService};

// Only the test executable exposes a loopback server; it is never linked into the production addon.
#[cfg(any(test, feature = "ssh-fixtures"))]
pub mod fixture;
#[cfg(test)]
mod tests;
