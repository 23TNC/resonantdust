//! Global stock-aspect registry — the fixed bit layout for the lifecycle /
//! hold aspects that live in the **top reserved region** of the per-card
//! `stock` u64.
//!
//! Two kinds of data share the `stock` word:
//!
//!   - **Per-def aspects** (pine, flora, a progress counter, …) — their slot
//!     positions come from each card definition's stock schema, so they vary by
//!     def and need the content bundle to decode. They grow **up** from bit 4
//!     (the bottom u4 is zone-savable; see [`crate::card_model`]).
//!
//!   - **Global aspects** (the holds + `dead`/`reap`) — declared here, the SAME
//!     offset on every card. Because the layout is global and content-independent
//!     it lives in this crate, so the **content-agnostic shard** can read `dead`/
//!     `reap` and fold hold deltas with no content bundle. They grow **down**
//!     from bit 63, so the two regions never collide as each grows.
//!
//! These supersede the `flags`-word refcount holds (`slot_claim_count`, …) and
//! the `dead` state bit: the temporal op-log generalizes the shard's
//! `propagate_hold_forward` onto these fields. **Append-only** within the region:
//! never reuse or shift a bit, or live rows reinterpret.
//!
//! Layout (high → low):
//! ```text
//!   bits 61-63  reap          (3)   ┐ grow DOWN as aspects are added
//!   bits 58-60  dead          (3)   │
//!   bits 56-57  touch_server  (2)   │
//!   bits 54-55  touch_user    (2)   │
//!   bits 51-53  drop_hold     (3)   │
//!   bits 48-50  pos_hold      (3)   │
//!   bits 45-47  borrow        (3)   │
//!   bits 42-44  claim         (3)   ┘  ← lowest global bit; per-def aspects must
//!                                       stay below bit 42 (they grow up from 4)
//! ```

/// A multi-bit field within the `stock` u64 — lowest bit (`shift`) + width.
/// The u64 analogue of [`crate::flags::FlagField`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StockField {
  pub shift: u8,
  pub width: u8,
}

impl StockField {
  /// Bitmask covering this field's window. `stock & !mask()` clears the field.
  pub fn mask(self) -> u64 {
    self.value_mask() << self.shift
  }
  /// Read this field's value out of a `stock` word.
  pub fn get(self, stock: u64) -> u8 {
    ((stock & self.mask()) >> self.shift) as u8
  }
  /// Write `value` into this field (truncated to width), preserving all other
  /// bits. Values above the field's max are clamped to the max.
  pub fn set(self, stock: u64, value: u8) -> u64 {
    let v = (value as u64).min(self.max());
    (stock & !self.mask()) | (v << self.shift)
  }
  /// Largest value the field can hold (`2^width − 1`).
  pub fn max(self) -> u64 {
    (1u64 << self.width) - 1
  }
  fn value_mask(self) -> u64 {
    (1u64 << self.width) - 1
  }
}

/// The global lifecycle / hold aspects, in stable `aspect_id` order. The
/// discriminant IS the wire `aspect_id` (a `u4`); never renumber — ids key
/// historical op rows and the cross-crate registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum StockAspect {
  /// Exclusive (claim / use) hold refcount. Was `slot_claim_count` in `flags`.
  Claim = 0,
  /// Shared (borrow / share) hold refcount. Was `slot_borrow_count`.
  Borrow = 1,
  /// Position-pin hold refcount. Was `position_hold_count`.
  PosHold = 2,
  /// Stacking-block hold refcount. Was `drop_hold_count`.
  DropHold = 3,
  /// User touch refcount. Was `touch_count`.
  TouchUser = 4,
  /// Server touch refcount. Was `server_count`.
  TouchServer = 5,
  /// Lifecycle "marked dead" refcount (`> 0` ⇒ reapable). Was the `dead` flag
  /// bit — now a count so multiple recipes can mark/unmark independently.
  Dead = 6,
  /// Reaper refcount — how many sweeps have claimed the card for removal.
  Reap = 7,
}

/// Highest `aspect_id` in use; ids `0..=MAX_ASPECT_ID` are defined. Bounds the
/// `u4` aspect-id space (≤ 15).
pub const MAX_ASPECT_ID: u8 = StockAspect::Reap as u8;

impl StockAspect {
  /// The wire `aspect_id` (`u4`) — the enum discriminant.
  pub fn id(self) -> u8 {
    self as u8
  }

  /// The DSL aspect path for this aspect — the inverse of [`from_name`], used to
  /// overlay the materialized global value into the matcher's `data.*` store.
  pub fn name(self) -> &'static str {
    use StockAspect::*;
    match self {
      Claim => "claim",
      Borrow => "borrow",
      PosHold => "pos_hold",
      DropHold => "drop_hold",
      TouchUser => "touch.user",
      TouchServer => "touch.server",
      Dead => "dead",
      Reap => "reap",
    }
  }

  /// Resolve a DSL aspect path to its global `StockAspect`, or `None` if the
  /// path is a per-def / non-global aspect (regular schema stock, or `visual.*`).
  /// The dotted paths (`touch.user` / `touch.server`) are the touch refcounts;
  /// `pstatus` / `stack_hosts` / `stack_joins` are deliberately NOT global.
  /// This is the single switch translate/bridge use to route a write/read to the
  /// op-log global region vs a schema slot.
  pub fn from_name(name: &str) -> Option<Self> {
    use StockAspect::*;
    Some(match name {
      "claim" => Claim,
      "borrow" => Borrow,
      "pos_hold" => PosHold,
      "drop_hold" => DropHold,
      "touch.user" => TouchUser,
      "touch.server" => TouchServer,
      "dead" => Dead,
      "reap" => Reap,
      _ => return None,
    })
  }

  /// Resolve an `aspect_id` back to its aspect, or `None` if undefined.
  pub fn from_id(id: u8) -> Option<Self> {
    use StockAspect::*;
    Some(match id {
      0 => Claim,
      1 => Borrow,
      2 => PosHold,
      3 => DropHold,
      4 => TouchUser,
      5 => TouchServer,
      6 => Dead,
      7 => Reap,
      _ => return None,
    })
  }

  /// This aspect's fixed field in the `stock` u64.
  pub fn field(self) -> StockField {
    use StockAspect::*;
    // Stated as (shift, width); see the module-level layout diagram. Shifts are
    // hand-pinned (not computed) so the layout is auditable and append-stable.
    let (shift, width) = match self {
      Claim => (42, 3),
      Borrow => (45, 3),
      PosHold => (48, 3),
      DropHold => (51, 3),
      TouchUser => (54, 2),
      TouchServer => (56, 2),
      Dead => (58, 3),
      Reap => (61, 3),
    };
    StockField { shift, width }
  }
}

/// Lowest bit owned by the global-aspect region. Per-def stock schemas must
/// allocate strictly below this (they grow up from bit 4); cross with a load
/// check once schema-by-execution feeds this crate.
pub const GLOBAL_REGION_FLOOR: u8 = 42;

/// Mask of every bit owned by the global-aspect region (bits 42-63).
pub fn global_region_mask() -> u64 {
  !((1u64 << GLOBAL_REGION_FLOOR) - 1)
}

/// Read an aspect's count from a `stock` word.
pub fn count(stock: u64, aspect: StockAspect) -> u8 {
  aspect.field().get(stock)
}

/// Increment an aspect's count by one (saturating at the field max), returning
/// the new `stock` word. Commutative — the op-log fold relies on this.
pub fn inc(stock: u64, aspect: StockAspect) -> u64 {
  let f = aspect.field();
  let v = f.get(stock).saturating_add(1);
  f.set(stock, v)
}

/// Decrement an aspect's count by one (saturating at 0), returning the new
/// `stock` word.
pub fn dec(stock: u64, aspect: StockAspect) -> u64 {
  let f = aspect.field();
  let v = f.get(stock).saturating_sub(1);
  f.set(stock, v)
}

/// `true` when ANY hold is active on the card (claim/borrow/pos_hold/drop_hold/
/// touch). Excludes `dead`/`reap` (lifecycle, not holds). The stock-region
/// replacement for `card_model::has_active_holds`'s flag read.
pub fn has_active_holds(stock: u64) -> bool {
  use StockAspect::*;
  [Claim, Borrow, PosHold, DropHold, TouchUser, TouchServer]
    .iter()
    .any(|&a| count(stock, a) > 0)
}

/// `true` when the card is marked dead (`Dead` count `> 0`). The content-free
/// reaper predicate over `stock` — the eventual replacement for
/// `card_model::is_dead`'s `flags`-bit read.
pub fn stock_is_dead(stock: u64) -> bool {
  count(stock, StockAspect::Dead) > 0
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn id_roundtrips_and_is_dense() {
    for id in 0..=MAX_ASPECT_ID {
      let a = StockAspect::from_id(id).expect("defined id");
      assert_eq!(a.id(), id);
    }
    assert_eq!(StockAspect::from_id(MAX_ASPECT_ID + 1), None);
    assert!(MAX_ASPECT_ID <= 0xF, "aspect_id must fit in a u4");
  }

  #[test]
  fn fields_are_disjoint_and_in_region() {
    let mut union = 0u64;
    for id in 0..=MAX_ASPECT_ID {
      let f = StockAspect::from_id(id).unwrap().field();
      assert_eq!(union & f.mask(), 0, "aspect {id} overlaps another");
      union |= f.mask();
      assert_eq!(
        f.mask() & global_region_mask(),
        f.mask(),
        "aspect {id} escapes the global region"
      );
      assert!(f.shift + f.width <= 64, "aspect {id} overflows the u64");
    }
  }

  #[test]
  fn inc_dec_count_roundtrip() {
    use StockAspect::*;
    let s = inc(inc(0, Claim), Claim);
    assert_eq!(count(s, Claim), 2);
    assert_eq!(count(s, Borrow), 0, "neighbours untouched");
    let s = dec(s, Claim);
    assert_eq!(count(s, Claim), 1);
  }

  #[test]
  fn from_name_maps_global_aspects_only() {
    assert_eq!(StockAspect::from_name("dead"), Some(StockAspect::Dead));
    assert_eq!(StockAspect::from_name("claim"), Some(StockAspect::Claim));
    assert_eq!(StockAspect::from_name("touch.user"), Some(StockAspect::TouchUser));
    assert_eq!(StockAspect::from_name("touch.server"), Some(StockAspect::TouchServer));
    // per-def / non-global aspects resolve to None → regular schema stock.
    assert_eq!(StockAspect::from_name("pine"), None);
    assert_eq!(StockAspect::from_name("pstatus"), None);
    assert_eq!(StockAspect::from_name("stack_hosts"), None);
  }

  #[test]
  fn dead_predicate_tracks_count() {
    assert!(!stock_is_dead(0));
    let s = inc(0, StockAspect::Dead);
    assert!(stock_is_dead(s));
    assert!(!stock_is_dead(dec(s, StockAspect::Dead)));
  }

  #[test]
  fn inc_saturates_at_field_max() {
    use StockAspect::*;
    // TouchUser is a 2-bit field → max 3; inc past it must not bleed up.
    let mut s = 0u64;
    for _ in 0..10 {
      s = inc(s, TouchUser);
    }
    assert_eq!(count(s, TouchUser), 3);
    assert_eq!(count(s, TouchServer), 0, "no carry into the neighbour");
  }
}
