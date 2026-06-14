//! resonantdust-protocol — the client↔gate wire types.
//!
//! Was the `protocol` feature of `resonantdust-data`; now its own crate so the
//! SpacetimeDB modules (which want the codec but not the wire types) simply don't
//! depend on it. Both message types derive `Serialize` + `Deserialize` so the
//! gateway and the client share one contract.
//!
//! The wire is migrating JSON → postcard (binary), per-direction. [`rows`] holds
//! the typed row payloads (the rx win); [`protocol`] the message envelopes.

pub mod protocol;
pub mod rows;
