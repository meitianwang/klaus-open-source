//! One protocol resource; account policy, QR presentation and engine ownership remain in TypeScript.
mod events;
mod network;
mod profile;
mod service;
pub use service::{Action, Options, WhatsAppService};

#[cfg(feature = "whatsapp-fixtures")]
pub mod fixture;

#[cfg(all(test, feature = "whatsapp-fixtures"))]
mod pair_tests;

mod runtime;
