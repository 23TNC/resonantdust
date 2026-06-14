//! Canonical stacking eligibility — the bundle-free core, shared by the client
//! (drag/feasibility), the gate, and the placement model (`state::stack`). The
//! `bundle → StackBits` lookup lives in the bundle-aware layer
//! (`dsl::defs::stack_bits`); everything here is pure bit math over `StackBits`,
//! so the lowest crate can host it (no circular `state → dsl`).
//!
//! **Bit-fields are indexed by `stack_id`** (the value stored in a card's
//! `stack_state` nibble): bit `i` = stack `i`, where
//!   - `0` = loose (the root sentinel — never hosted or joined),
//!   - `1` = hex / under-root (where a tile mounts),
//!   - `2` = top, `3` = bottom.
//!
//!   - `hosts` — stacks this card SOURCES as a root (slots others attach to)
//!   - `joins` — stacks this card can OCCUPY as a member
//!
//! [`match_stack`] is the single primitive here: the `stack_id` a joiner takes on
//! a host (`host.hosts & joiner.joins`, lowest stack wins, hex 1 preferred, drop
//! direction breaks a top/bottom tie). The *leaf-aware, bidirectional* drop
//! resolution (forward + invert re-root, capping on non-hosting leaves) is built
//! on top of this in `state::stack::resolve_stack`, which needs the store and so
//! can't live in this bundle-free layer.

use crate::packed::STACK_DIR_DOWN;

/// Stack ids (== the `stack_state` nibble value; 0 = loose).
pub const STACK_HEX: u8 = 1;
pub const STACK_TOP: u8 = 2;
pub const STACK_BOTTOM: u8 = 3;

/// A card's stacking bit-fields, indexed by `stack_id` (bit `i` = stack `i`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StackBits {
    pub hosts: u8,
    pub joins: u8,
}

/// Regular card: hosts hex+top+bottom (`0b1110`), joins top+bottom (`0b1100`).
/// Bit 0 (loose) is never set — a card neither hosts nor joins the loose stack.
pub const DEFAULT_BITS: StackBits = StackBits { hosts: 0b1110, joins: 0b1100 };

/// Tile/event: hosts nothing, joins only the hex stack (`0b0010`).
pub const TILE_BITS: StackBits = StackBits { hosts: 0b0000, joins: 0b0010 };

#[inline]
fn bit(stack: u8) -> u8 {
    1 << stack
}

/// The `stack_id` a `joiner` occupies on a `host`, or `None` if none. Lowest
/// stack wins (hex first); `drop_dir` (`STACK_DIR_UP`/`DOWN`) breaks a top+bottom
/// tie. Returns a `stack_id` (`STACK_HEX`/`TOP`/`BOTTOM`).
pub fn match_stack(host: StackBits, joiner: StackBits, drop_dir: u8) -> Option<u8> {
    let m = host.hosts & joiner.joins;
    if m == 0 {
        return None;
    }
    if m & bit(STACK_HEX) != 0 {
        return Some(STACK_HEX);
    }
    let top = m & bit(STACK_TOP) != 0;
    let bottom = m & bit(STACK_BOTTOM) != 0;
    if top && bottom {
        return Some(if drop_dir == STACK_DIR_DOWN { STACK_BOTTOM } else { STACK_TOP });
    }
    if top {
        return Some(STACK_TOP);
    }
    if bottom {
        return Some(STACK_BOTTOM);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packed::STACK_DIR_UP;

    #[test]
    fn regular_onto_regular_uses_drop_dir_for_top_bottom() {
        assert_eq!(match_stack(DEFAULT_BITS, DEFAULT_BITS, STACK_DIR_UP), Some(STACK_TOP));
        assert_eq!(match_stack(DEFAULT_BITS, DEFAULT_BITS, STACK_DIR_DOWN), Some(STACK_BOTTOM));
    }

    #[test]
    fn tile_hosts_nothing_but_joins_a_card_hex() {
        // A tile hosts nothing, so a card never joins it...
        assert_eq!(match_stack(TILE_BITS, DEFAULT_BITS, STACK_DIR_UP), None);
        // ...but a tile joins a card's hex stack (the card is the host/root).
        assert_eq!(match_stack(DEFAULT_BITS, TILE_BITS, STACK_DIR_UP), Some(STACK_HEX));
    }

    #[test]
    fn two_tiles_cannot_stack() {
        assert_eq!(match_stack(TILE_BITS, TILE_BITS, STACK_DIR_UP), None);
    }
}
