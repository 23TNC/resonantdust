//! Client-facing introspection over the flag + type registries.
//!
//! These are the model-stable lookups the pixijs client's `DefinitionManager`
//! needs that don't depend on a loaded [`crate::loader::Bundle`] — the flag bit
//! layout ([`resonantdust_codec::flags`]) and the card-type nibble table
//! ([`crate::loader::type_nibble`]).

use resonantdust_codec::flags::{flag_bit, flag_field};
use crate::loader::type_nibble;

/// The flag host columns, searched in this order when a lookup isn't
/// field-qualified (the propagating `flags` word takes precedence over the
/// `flags_bk` bookkeeping word).
const FIELDS: [&str; 2] = ["flags", "flags_bk"];

/// Single-bit flag position by name, searching `flags` then `flags_bk`.
/// `None` for unknown names.
pub fn card_flag_bit(name: &str) -> Option<u8> {
  FIELDS.iter().find_map(|f| flag_bit(f, name))
}

/// Is the named single-bit flag set, routing to whichever host column declares
/// it (`flags` checked against the propagating word, `flags_bk` against the
/// bookkeeping word)? `false` for unknown names.
pub fn has_card_flag(flags: u32, flags_bk: u32, name: &str) -> bool {
  if let Some(bit) = flag_bit("flags", name) {
    return flags & (1 << bit) != 0;
  }
  if let Some(bit) = flag_bit("flags_bk", name) {
    return flags_bk & (1 << bit) != 0;
  }
  false
}

/// `(shift, width)` of a named multi-bit field within `field`, or `None`.
pub fn card_flag_field_shape(field: &str, name: &str) -> Option<(u8, u8)> {
  flag_field(field, name).map(|f| (f.shift, f.width))
}

/// Extract a named multi-bit field's value from `host` (the matching column),
/// within an explicit `field`. `None` if the field isn't declared there.
pub fn card_flag_field_value_in(field: &str, host: u32, name: &str) -> Option<u32> {
  flag_field(field, name).map(|f| (host & f.mask()) >> f.shift)
}

/// Extract a named multi-bit field's value, routing to whichever host declares
/// it (`flags` → `flags`, `stock` → `stock`). `None` if unknown. `stock` is the
/// full u64 per-card word, so a field above bit 31 reads correctly.
pub fn card_flag_field_value_any(flags: u32, stock: u64, name: &str) -> Option<u64> {
  card_flag_field_value_in("flags", flags, name)
    .map(u64::from)
    .or_else(|| card_flag_field_value_in_stock(stock, name))
}

/// u64-safe read of a named field from the `stock` host (its layout can run past
/// bit 31 once lock aspects fold in from `flags`). `None` if `stock` doesn't
/// declare `name`.
fn card_flag_field_value_in_stock(stock: u64, name: &str) -> Option<u64> {
  flag_field("stock", name)
    .map(|f| resonantdust_codec::bits::get_field64(stock, f.shift as u32, f.width as u32))
}

/// The `card_type` nibble for a type name (e.g. `"tile"` → 7), or `None`.
pub fn card_type_id(name: &str) -> Option<u8> {
  type_nibble(name)
}

/// Whether a `card_type` nibble renders on the hex world grid (`tile`,
/// `mini_zone`, `tile_decorator`) vs. a rect card. Drives the client's
/// `shape()` ("hex" | "rect"). The hex set is the world-grid card types.
pub fn is_hex_type(type_id: u8) -> bool {
  matches!(
    type_id,
    7 /* tile */ | 8 /* mini_zone */ | 9 /* tile_decorator */
  )
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn flag_bit_searches_both_fields() {
    // `pos_need` lives in flags (bit 27); `position_dirty` in flags_bk (bit 0).
    assert_eq!(card_flag_bit("pos_need"), Some(27));
    assert_eq!(card_flag_bit("position_dirty"), Some(0));
    assert_eq!(card_flag_bit("nope"), None);
  }

  #[test]
  fn has_flag_routes_to_the_right_host() {
    let pos_need = 1u32 << 27; // flags.pos_need
    let dirty = 1u32 << 0; // flags_bk.position_dirty
    assert!(has_card_flag(pos_need, 0, "pos_need"));
    assert!(!has_card_flag(0, pos_need, "pos_need"));
    assert!(has_card_flag(0, dirty, "position_dirty"));
    assert!(!has_card_flag(0xFFFF_FFFF, 0xFFFF_FFFF, "nope"));
  }

  #[test]
  fn multi_bit_field_value_reads() {
    // `index` is a flags field (shift 4, width 4); pack a 5. (The hold fields
    // that used to test this are retired — holds are op-log stock aspects now.)
    let host = 5u32 << 4;
    assert_eq!(card_flag_field_shape("flags", "index"), Some((4, 4)));
    assert_eq!(card_flag_field_value_in("flags", host, "index"), Some(5));
    assert_eq!(card_flag_field_value_any(host, 0, "index"), Some(5));
    assert_eq!(card_flag_field_value_in("flags", host, "nope"), None);
    // stock fields route to the stock host (the full u64 word).
    let stock = 3u64 << 2; // stock_1
    assert_eq!(card_flag_field_value_any(0, stock, "stock_1"), Some(3));
    // a field high in the u64 reads correctly (no u32 truncation).
    assert_eq!(card_flag_field_value_any(0, 1u64 << 40, "stock_1"), Some(0));
  }

  #[test]
  fn type_id_and_hex() {
    assert_eq!(card_type_id("tile"), Some(7));
    assert_eq!(card_type_id("requisite"), Some(0));
    assert_eq!(card_type_id("nope"), None);
    assert!(is_hex_type(7)); // tile
    assert!(!is_hex_type(0)); // requisite → rect
  }
}
