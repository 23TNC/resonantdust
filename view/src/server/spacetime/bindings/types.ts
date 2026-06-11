//! Stub for the view rebuild. The card/zone row shapes will come from the wasm
//! `client` core (snake_case rows, mirroring the Rust `client/src/rows.rs`), not
//! the old SpacetimeDB SDK bindings (which are being removed). Minimal here so the
//! card-render pipeline's type references compile; replace with the wasm row types
//! when the client event stream is wired.

/** A card row as the wasm client surfaces it. */
export interface Card {
  card_id: number;
  owner_id: number;
  macro_zone: bigint;
  micro_location: number;
  flags: number;
  flags_bk: number;
  stock: number;
  packed_definition: number;
  valid_at: bigint;
}
