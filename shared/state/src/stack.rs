//! Stack-movement model — the sans-IO core behind `place_card`.
//!
//! "Put this card at this position" — stacked onto a parent (in a branch
//! direction) or loose at an explicit address — validated and resolved over an
//! abstract [`StackStore`], returning a [`Plan`] of row writes the caller
//! applies. No IO: the server impls [`StackStore`] over its db and applies the
//! plan via `update_with_at`; the client impls it over its world model and
//! applies the plan optimistically (predicting the move) while the gate's
//! authoritative `place_card` round-trips. One implementation, no drift between
//! the shard reducer and the client's mirror.
//!
//! Flat-chain model (mirror of `Micro` in `resonantdust_codec::card_model`): a
//! chain is one loose/snapped **root** plus N **members** whose `micro_location`
//! points at the root, each carrying a `branch` + `index`. Stacking a card makes
//! it (and its own members) members of the target's root.

use resonantdust_codec::aspects;
use resonantdust_codec::card_model::{
    is_dead, stack_branch, stack_index, Micro,
};
use resonantdust_codec::packed::{
    owner_of, surface_of, with_surface, STACK_DIR_DOWN, STACK_DIR_HEX, STACK_DIR_UP,
};
use resonantdust_codec::stacking::{match_stack, StackBits, STACK_BOTTOM, STACK_HEX, STACK_TOP};

use crate::recipe_state::{owning_player, CardStore, CardView, WORLD_PLAYER_ID};

/// The reads stack movement needs beyond [`CardStore`]: the members of a chain
/// root (cards whose `micro_location == root` and that are stack members),
/// current at `now_ms`.
pub trait StackStore: CardStore {
    fn members_of(&self, root_id: u32, now_ms: u64) -> Vec<CardView>;

    /// The tile occupying a cell `(q, r)` of zone `macro_zone`, as a virtual
    /// loose-root [`CardView`] — the would-be hex member when a card is seated
    /// there. Only `packed_definition` (the tile's def, for its stack bits) and
    /// `macro_zone` are meaningful; the rest are best-effort. `None` when the cell
    /// has no tile (empty corner / non-tiled surface). Defaults to `None` for
    /// stores without zone data: they don't enforce loose placement against the
    /// terrain — the bundle-aware client does, predicting the move.
    fn tile_at(&self, _macro_zone: u64, _q: u8, _r: u8, _now_ms: u64) -> Option<CardView> {
        None
    }
}

/// Where a placement puts the source card. The Rust-enum counterpart of the
/// shard's flat wire `Placement` — the client/gate map to/from the wire form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// Stack the source as a member of `parent_id`'s chain in `direction`
    /// (`STACK_DIR_UP`/`DOWN`/`HEX`).
    Stack { parent_id: u32, direction: u8 },
    /// Place the source loose at an explicit address. `q`/`r` are the world cell
    /// (0 for container surfaces); `x`/`y` the within-cell offset.
    Loose {
        surface: u8,
        macro_zone: u64,
        q: u8,
        r: u8,
        x: i16,
        y: i16,
    },
}

/// One row the plan writes: the card's new `(macro_zone, micro)`. `owner_id` is
/// never part of a placement — ownership is independent of position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Write {
    pub card_id: u32,
    pub macro_zone: u64,
    pub micro: Micro,
}

/// The full set of writes a placement produces: the source, then its members
/// (re-rooted on a stack move, or just travelling on a loose move).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub writes: Vec<Write>,
}

/// Validate + resolve a placement of `card_id` by `caller_player_id`, returning
/// the [`Plan`] to apply, or an `Err` describing why it's rejected. Pure over
/// `store`; the caller does the actual row writes.
pub fn plan_place<S: StackStore>(
    store: &S,
    card_id: u32,
    placement: Placement,
    caller_player_id: u32,
    now_ms: u64,
    // Resolve a card's stacking bit-fields from its `packed_definition`. The
    // bit-fields are content-derived, so the bundle-aware caller (client/gate)
    // passes a bundle-backed resolver; the content-agnostic shard passes
    // `|_| DEFAULT_BITS` (a Stack placement only ever stacks non-tile cards).
    bits: &dyn Fn(u16) -> StackBits,
) -> Result<Plan, String> {
    // ── source eligibility ──────────────────────────────────────────────
    let source = store
        .card_at(card_id, now_ms)
        .ok_or_else(|| format!("place: card {card_id} not found"))?;
    if is_dead(source.stock) {
        return Err(format!("place: card {card_id} is dead"));
    }
    let source_owner = owning_player(store, card_id, now_ms).unwrap_or(WORLD_PLAYER_ID);
    if source_owner != caller_player_id {
        return Err(format!(
            "place: card {card_id} is owned by player {source_owner} (not {caller_player_id})"
        ));
    }
    held_check(&source, "card")?;

    // A LOOSE move of a stack MEMBER drag-carries the outward run (the cards above
    // it in its branch, up to the first position-held card — see [`carried_run`]);
    // the run re-roots onto the source and the chain it left collapses its gap. Any
    // other move (a root, or a stack move) carries the source's own sub-members.
    let source_micro = Micro::of(source.micro_location, source.flags);
    let carrying =
        matches!(source_micro, Micro::Stacked { .. }) && matches!(placement, Placement::Loose { .. });
    // Both LOOSE and STACK moves carry the same set the drag pickup ghosts
    // ([`drag_travelers`] / [`drag_carry_set`]) — the source's outward run if it's a
    // member, its full chain if it's a root. The single-branch join gate in
    // `resolve_stack` guarantees a STACK joiner's run is one branch.
    let travelers = drag_travelers(store, &source, now_ms);
    for m in &travelers {
        held_check(m, "descendant")?;
    }

    // ── resolve the destination ─────────────────────────────────────────
    let resolved = match placement {
        Placement::Stack { parent_id, direction } => {
            resolve_stack(store, card_id, &source, parent_id, direction, caller_player_id, now_ms, bits)?
        }
        Placement::Loose { surface, macro_zone, q, r, x, y } => {
            let (surface, macro_zone, micro) =
                resolve_loose(store, caller_player_id, surface, macro_zone, q, r, x, y, now_ms)?;
            // Seating a card loose on a tile is the bidirectional drop against that
            // tile: it hosts nothing, so the only resolution is the *invert* — the
            // tile joins the source's hex stack, which requires the source to host
            // hex (leaf-aware). The same rule movement uses ([`can_seat_on_tile`]).
            if !can_seat_on_tile(store, card_id, with_surface(macro_zone, surface), q, r, now_ms, bits) {
                return Err(format!(
                    "place: card {card_id} can't rest on a tile here — it doesn't host the hex stack the tile would join"
                ));
            }
            Resolved::Place { surface, macro_zone, micro }
        }
    };

    // ── build the write plan ────────────────────────────────────────────
    // Whichever chain JOINS the other carries its single-branch run onto the host,
    // re-indexed contiguously above its new slot, and splices the chain it left.
    // `moved` is the joiner + its run (the cards that departed a chain) — the splice
    // set, a no-op when the joiner was a root that took all its members.
    let mut writes = Vec::with_capacity(2 + travelers.len());
    let moved: Vec<u32> = match resolved {
        Resolved::Place { surface, macro_zone, micro } => {
            let full_macro = with_surface(macro_zone, surface);
            writes.push(Write { card_id, macro_zone: full_macro, micro });
            match micro {
                // Loose drop: the source is the (loose) root of where it lands.
                Micro::Loose { .. } => {
                    if carrying {
                        // A member lifted loose: its outward run re-roots onto the
                        // source (now a loose root), keeping branch, re-indexed from 0.
                        for (k, m) in travelers.iter().enumerate() {
                            writes.push(Write {
                                card_id: m.card_id,
                                macro_zone: full_macro,
                                micro: Micro::Stacked { root: card_id, branch: stack_branch(m.flags), index: k as u8 },
                            });
                        }
                    } else {
                        // A root moved loose: members travel unchanged (source stays
                        // their root), only their macro_zone follows.
                        for m in &travelers {
                            writes.push(Write {
                                card_id: m.card_id,
                                macro_zone: full_macro,
                                micro: Micro::of(m.micro_location, m.flags),
                            });
                        }
                    }
                }
                // Forward stack JOIN: the source joins the host; its single-branch run
                // re-roots onto the host, re-indexed contiguously ABOVE the join slot.
                Micro::Stacked { root: host_root, branch, index } => {
                    for (k, m) in travelers.iter().enumerate() {
                        writes.push(Write {
                            card_id: m.card_id,
                            macro_zone: full_macro,
                            micro: Micro::Stacked { root: host_root, branch, index: index + 1 + k as u8 },
                        });
                    }
                }
            }
            std::iter::once(card_id).chain(travelers.iter().map(|m| m.card_id)).collect()
        }
        // Invert: the PARENT joins the (stationary) source's chain at `micro`
        // (root = source). It carries its own single-branch run above its new slot —
        // the gate guaranteed ≤1 branch — and splices the chain it left.
        Resolved::Invert { parent_id, macro_zone, micro } => {
            writes.push(Write { card_id: parent_id, macro_zone, micro });
            let parent_run = store.members_of(parent_id, now_ms);
            if let Micro::Stacked { root: host_root, branch, index } = micro {
                for (k, m) in parent_run.iter().enumerate() {
                    writes.push(Write {
                        card_id: m.card_id,
                        macro_zone,
                        micro: Micro::Stacked { root: host_root, branch, index: index + 1 + k as u8 },
                    });
                }
            }
            std::iter::once(parent_id).chain(parent_run.iter().map(|m| m.card_id)).collect()
        }
    };

    // Close the gap(s) the joiner left in its old chain (Stage-2 splice). No-op when
    // the joiner was a root that carried all its members (nothing survives to collapse).
    writes.extend(plan_splice(store, &moved, now_ms));
    Ok(Plan { writes })
}

/// Can `card_id` be seated as a loose root on the tile at cell `(q, r)` of
/// `macro_zone` (a full zone key, surface included)? This is the bidirectional
/// drop against the cell's tile: the tile hosts nothing, so it can only join the
/// card's hex stack — i.e. the card must host hex (leaf-aware via [`open_stack`],
/// the same check [`resolve_stack`]'s invert uses). An empty cell has no tile to
/// mount, so seating is unconditional (a host-`0` card can occupy open cells —
/// the moving-tile-card edge case). The shared rule behind both loose placement
/// and movement onto a tile.
pub fn can_seat_on_tile<S: StackStore>(
    store: &S,
    card_id: u32,
    macro_zone: u64,
    q: u8,
    r: u8,
    now_ms: u64,
    bits: &dyn Fn(u16) -> StackBits,
) -> bool {
    let Some(card) = store.card_at(card_id, now_ms) else {
        return false;
    };
    let Some(tile) = store.tile_at(macro_zone, q, r, now_ms) else {
        return true; // empty cell — nothing to mount
    };
    let source_bits = bits(card.packed_definition);
    let tile_bits = bits(tile.packed_definition);
    open_stack(store, card_id, macro_zone, source_bits, tile_bits, STACK_DIR_HEX, now_ms, bits).is_some()
}

/// Reject if `view` is held by an in-flight action (claim / borrow / position).
fn held_check(view: &CardView, what: &str) -> Result<(), String> {
    if aspects::count(view.stock, aspects::StockAspect::Claim) > 0 {
        return Err(format!("place: {what} {} is exclusively held by an in-flight action", view.card_id));
    }
    if aspects::count(view.stock, aspects::StockAspect::Borrow) > 0 {
        return Err(format!("place: {what} {} is borrow-held by an in-flight action", view.card_id));
    }
    if aspects::count(view.stock, aspects::StockAspect::PosHold) > 0 {
        return Err(format!("place: {what} {} is position-held by an in-flight action", view.card_id));
    }
    Ok(())
}

/// The chain root of `view`: `micro_location` if it's a stack member, else itself.
pub fn chain_root_of(view: &CardView) -> u32 {
    let micro = Micro::of(view.micro_location, view.flags);
    match micro {
        Micro::Stacked { root, .. } => root,
        Micro::Loose { .. } => view.card_id,
    }
}

/// The drag-carry run for a loose move of stack member `source`: the cards stacked
/// OUTWARD from it (same branch, higher index), contiguous from `source.index + 1`,
/// stopping before the first **position-held** card. A position hold means "can't
/// be carried by a drag" — that card and everything above it stay on the old root,
/// while the run below it lifts off with the source. Cards toward the root (lower
/// index) are never carried (you lift what rests on it, not what it rests on).
/// Empty if `source` is loose. Sorted ascending by index.
fn carried_run<S: StackStore>(store: &S, source: &CardView, now_ms: u64) -> Vec<CardView> {
    let Micro::Stacked { root, branch, index: src_idx } =
        Micro::of(source.micro_location, source.flags)
    else {
        return Vec::new();
    };
    let mut sibs: Vec<CardView> = store
        .members_of(root, now_ms)
        .into_iter()
        .filter(|m| {
            stack_branch(m.flags) == branch && !is_dead(m.stock) && stack_index(m.flags) > src_idx
        })
        .collect();
    sibs.sort_by_key(|m| stack_index(m.flags));
    let mut run = Vec::new();
    let mut expected = src_idx + 1;
    for m in sibs {
        if stack_index(m.flags) != expected {
            break; // a gap ends the contiguous run (shouldn't happen post-collapse)
        }
        if aspects::count(m.stock, aspects::StockAspect::PosHold) > 0 {
            break; // a position-held card can't be carried — it (and above) stay
        }
        run.push(m);
        expected += 1;
    }
    run
}

/// The cards a LOOSE move/drag of `source` carries **beyond itself**: its outward
/// run (up to the first position-held card) if it's a stack member, else its whole
/// chain if it's a loose root. The single source of truth shared by [`plan_place`]'s
/// loose branch and [`drag_carry_set`], so the view's drag pickup ghosts EXACTLY
/// the set the move will carry.
fn drag_travelers<S: StackStore>(store: &S, source: &CardView, now_ms: u64) -> Vec<CardView> {
    match Micro::of(source.micro_location, source.flags) {
        Micro::Stacked { .. } => carried_run(store, source, now_ms),
        Micro::Loose { .. } => store.members_of(source.card_id, now_ms),
    }
}

/// The full set of card ids a loose drag of `card_id` lifts — the card itself plus
/// [`drag_travelers`]. The headless client exposes this so the (dumb) view copies +
/// dims exactly these cards on pickup; `plan_place`'s loose move carries the same
/// set, so the visual selection always matches the data move. Empty if the card is
/// missing. `card_id` is always first.
pub fn drag_carry_set<S: StackStore>(store: &S, card_id: u32, now_ms: u64) -> Vec<u32> {
    let Some(source) = store.card_at(card_id, now_ms) else {
        return Vec::new();
    };
    let mut ids = Vec::with_capacity(4);
    ids.push(card_id);
    ids.extend(drag_travelers(store, &source, now_ms).into_iter().map(|m| m.card_id));
    ids
}

/// How many distinct stacks a chain root HOSTS members in — the join gate's core.
/// A card may become a member of another (JOIN) only when this is `<= 1`: a member
/// extends a single direction, so a root hosting members in more than one stack
/// (e.g. hex + top) can't linearize into one slot and must invert instead. Counts
/// the distinct `stack_branch` of its live `members_of`, PLUS the hex branch when
/// the root sits on a tile (the tile is a synthetic member of the root's HEX stack —
/// the root hosts it). A stacked member hosts nothing → 0.
fn occupied_branches<S: StackStore>(store: &S, root: &CardView, now_ms: u64) -> usize {
    use std::collections::BTreeSet;
    let mut branches: BTreeSet<u8> = store
        .members_of(root.card_id, now_ms)
        .into_iter()
        .filter(|m| !is_dead(m.stock))
        .map(|m| stack_branch(m.flags))
        .collect();
    if let Micro::Loose { local_q, local_r, .. } = Micro::of(root.micro_location, root.flags) {
        if store.tile_at(root.macro_zone, local_q, local_r, now_ms).is_some() {
            branches.insert(STACK_HEX - 1); // the tile occupies the root's hex stack
        }
    }
    branches.len()
}

/// The **destroy** side of [`plan_place`]'s member re-root: compute the writes to
/// SPLICE the chains that lost a card. For each chain root that had a member (or
/// itself) destroyed:
///   - if the ROOT was destroyed, promote the lowest-ranked survivor to a LOOSE
///     root at the destroyed cell (rank: up-branch, then hex, then down; lowest
///     index) and re-root the rest onto it;
///   - then **collapse**: renumber every surviving branch's members contiguously
///     (0,1,2…), so a hole left by a destroyed MEMBER closes and the chain stays
///     gap-free in the data. A member whose `(root, branch, index)` is unchanged
///     gets no write (minimal churn — and a position-locked member only shifts
///     index, its macro_zone+stack stay fixed). Same [`Write`] shape as
///     `plan_place`, applied by the caller @completion. Pure over `store` — the
///     gate runs it on its gathered snapshot, a client could on its world.
pub fn plan_splice<S: StackStore>(store: &S, destroyed: &[u32], now_ms: u64) -> Vec<Write> {
    use std::collections::{BTreeMap, BTreeSet};
    let gone: BTreeSet<u32> = destroyed.iter().copied().collect();
    let rank = |b: u8| -> u8 {
        if b == STACK_DIR_UP {
            0
        } else if b == STACK_DIR_HEX {
            1
        } else {
            2
        }
    };

    // The pre-destroy chain root of every destroyed card (deduped) — the chains
    // that need re-rooting and/or index collapse.
    let roots: BTreeSet<u32> = destroyed
        .iter()
        .filter_map(|&id| store.card_at(id, now_ms).map(|c| chain_root_of(&c)))
        .collect();

    let mut writes = Vec::new();
    for root_id in roots {
        let Some(root) = store.card_at(root_id, now_ms) else {
            continue;
        };
        let mut members: Vec<CardView> = store
            .members_of(root_id, now_ms)
            .into_iter()
            .filter(|m| !gone.contains(&m.card_id) && !is_dead(m.stock))
            .collect();

        // Resolve the surviving root + the macro_zone the chain lives at.
        let (new_root, zone, promoted) = if gone.contains(&root_id) {
            // Root destroyed: promote the lowest-ranked survivor to a loose root.
            members.sort_by_key(|m| (rank(stack_branch(m.flags)), stack_index(m.flags), m.card_id));
            let Some(succ) = members.first().map(|m| m.card_id) else {
                continue; // whole chain gone
            };
            writes.push(Write {
                card_id: succ,
                macro_zone: root.macro_zone,
                micro: Micro::of(root.micro_location, root.flags),
            });
            members.retain(|m| m.card_id != succ);
            (succ, root.macro_zone, true)
        } else {
            (root_id, root.macro_zone, false)
        };

        // Collapse each branch's survivors to contiguous indices.
        let mut by_branch: BTreeMap<u8, Vec<CardView>> = BTreeMap::new();
        for m in members {
            by_branch.entry(stack_branch(m.flags)).or_default().push(m);
        }
        for (branch, mut ms) in by_branch {
            ms.sort_by_key(|m| (stack_index(m.flags), m.card_id));
            for (new_idx, m) in ms.iter().enumerate() {
                let new_idx = new_idx as u8;
                // Skip a write when nothing moved (root kept + same index). When a
                // successor was promoted everything re-roots, so always write.
                let unchanged = !promoted
                    && matches!(
                        Micro::of(m.micro_location, m.flags),
                        Micro::Stacked { root, index, .. } if root == new_root && index == new_idx
                    );
                if unchanged {
                    continue;
                }
                writes.push(Write {
                    card_id: m.card_id,
                    macro_zone: zone,
                    micro: Micro::Stacked { root: new_root, branch, index: new_idx },
                });
            }
        }
    }
    writes
}

/// Next free `index` in `(root, direction)` at `macro_zone` — `max occupied + 1`
/// (saturating at 15), or 0 when the branch is empty. Gap-tolerant.
fn next_branch_index<S: StackStore>(
    store: &S,
    root: u32,
    macro_zone: u64,
    direction: u8,
    now_ms: u64,
) -> u8 {
    let mut max: Option<u8> = None;
    for m in store.members_of(root, now_ms) {
        if m.macro_zone != macro_zone {
            continue;
        }
        if stack_branch(m.flags) == direction {
            let idx = stack_index(m.flags);
            max = Some(max.map_or(idx, |cur| cur.max(idx)));
        }
    }
    match max {
        Some(m) => ((m as u16 + 1).min(15)) as u8,
        None => 0,
    }
}

/// The outcome of resolving a [`Placement::Stack`] drop.
enum Resolved {
    /// Place the source (and its members) at this address — a forward stack onto
    /// a parent, a member-drop, or a loose move.
    Place { surface: u8, macro_zone: u64, micro: Micro },
    /// The drop INVERTED: the `parent` re-roots onto the (stationary) source at
    /// `micro` / `macro_zone`. The source stays the chain root; only the parent is
    /// written (it's a lone card — see [`resolve_stack`]).
    Invert { parent_id: u32, macro_zone: u64, micro: Micro },
}

#[inline]
fn stack_bit(stack: u8) -> u8 {
    1 << stack
}

/// The lowest stack a `joiner` can EXTEND on `root`'s chain, with the next free
/// index in that branch. A stack is extendable when the joiner joins it AND the
/// branch's current **leaf** — the highest-index live member, or the root itself
/// when the branch is empty — HOSTS it (the recursive leaf-append rule). Hex wins
/// over top/bottom; a top+bottom tie breaks on `direction`. `None` if no stack is
/// open, so a non-hosting leaf (e.g. a `test_dust` capping the top) makes the
/// drop fall through to another branch, and a leaf-capped chain with no open
/// branch falls through to the inverse drop / a rejection. For `DEFAULT_BITS` —
/// every card hosts every non-loose stack — this degenerates to the old
/// `match_stack(root.hosts, joiner.joins)` + next index.
#[allow(clippy::too_many_arguments)]
fn open_stack<S: StackStore>(
    store: &S,
    root_id: u32,
    root_zone: u64,
    root_bits: StackBits,
    joiner: StackBits,
    direction: u8,
    now_ms: u64,
    bits: &dyn Fn(u16) -> StackBits,
) -> Option<(u8, u8)> {
    let leaf_hosts = |stack: u8| -> bool {
        let branch = stack - 1;
        let leaf = store
            .members_of(root_id, now_ms)
            .into_iter()
            .filter(|m| m.macro_zone == root_zone && stack_branch(m.flags) == branch && !is_dead(m.stock))
            .max_by_key(|m| stack_index(m.flags));
        let host = leaf.map(|m| bits(m.packed_definition)).unwrap_or(root_bits);
        host.hosts & stack_bit(stack) != 0
    };
    let open = |stack: u8| joiner.joins & stack_bit(stack) != 0 && leaf_hosts(stack);
    let stack = if open(STACK_HEX) {
        STACK_HEX
    } else {
        match (open(STACK_TOP), open(STACK_BOTTOM)) {
            (true, true) => {
                if direction == STACK_DIR_DOWN {
                    STACK_BOTTOM
                } else {
                    STACK_TOP
                }
            }
            (true, false) => STACK_TOP,
            (false, true) => STACK_BOTTOM,
            (false, false) => return None,
        }
    };
    Some((stack, next_branch_index(store, root_id, root_zone, stack - 1, now_ms)))
}

/// Resolve a [`Placement::Stack`] drop of `source` onto `parent`. Three outcomes:
///
/// * **forward** — the source joins the parent's chain. When `parent` is a chain
///   ROOT, the open stack is found leaf-aware ([`open_stack`]): the source extends
///   the lowest branch whose leaf hosts it, so a non-hosting leaf makes the drop
///   fall through to another branch. When `parent` is a MEMBER, the drop targets
///   that card directly via [`match_stack`] on its own host bits (no cross-branch
///   fallback — you addressed that specific card).
/// * **invert** — forward found nothing, but the parent is a LONE root that can
///   host the source's join (the source can host the parent's join): the parent
///   re-roots onto the source. This turns "drop log onto test_dust" into
///   "test_dust stacks onto log". Disallowed when the parent is already a member
///   (it can't be torn out of its chain) or carries members of its own, and when
///   the source is itself a member.
/// * **reject** — neither direction stacks.
#[allow(clippy::too_many_arguments)]
fn resolve_stack<S: StackStore>(
    store: &S,
    source_id: u32,
    source: &CardView,
    parent_id: u32,
    direction: u8,
    caller_player_id: u32,
    now_ms: u64,
    bits: &dyn Fn(u16) -> StackBits,
) -> Result<Resolved, String> {
    if parent_id == 0 {
        return Err("place: Stack placement with parent_id == 0".to_string());
    }
    if parent_id == source_id {
        return Err(format!("place: card {source_id} can't stack onto itself"));
    }
    if !matches!(direction, STACK_DIR_UP | STACK_DIR_DOWN | STACK_DIR_HEX) {
        return Err(format!("place: invalid direction {direction} (expected UP=1, DOWN=2, HEX=0)"));
    }
    let parent = store
        .card_at(parent_id, now_ms)
        .ok_or_else(|| format!("place: parent card {parent_id} not found"))?;
    if is_dead(parent.stock) {
        return Err(format!("place: parent card {parent_id} is dead"));
    }
    if aspects::count(parent.stock, aspects::StockAspect::DropHold) > 0 {
        return Err(format!("place: parent card {parent_id} blocks stacking (drop_hold_count > 0)"));
    }
    let parent_root = chain_root_of(&parent);
    if parent_root == source_id {
        return Err(format!(
            "place: stacking would form a cycle (source {source_id} is the root of parent {parent_id}'s chain)"
        ));
    }
    // Reject re-dropping a card into a chain it's ALREADY a member of: dropping a
    // stack member back onto its own root (or a sibling in the same chain) would
    // otherwise re-stack it onto itself. Rearranging within a stack isn't a place —
    // lift the card out loose first.
    let source_root = chain_root_of(source);
    if source_root != source_id && source_root == parent_root {
        return Err(format!("place: card {source_id} is already part of {parent_id}'s stack"));
    }
    let chain_player = owning_player(store, parent_root, now_ms).unwrap_or(WORLD_PLAYER_ID);
    if chain_player != WORLD_PLAYER_ID && chain_player != caller_player_id {
        return Err(format!(
            "place: parent {parent_id}'s chain is owned by player {chain_player} (not {caller_player_id})"
        ));
    }

    let source_bits = bits(source.packed_definition);
    let parent_bits = bits(parent.packed_definition);

    if parent_root == parent_id {
        // Forward — the source joins the parent's chain. Gate: the source may only
        // become a member if it hosts members in ≤1 stack (a member extends one
        // direction); a multi-branch source falls through to the invert. Leaf-aware
        // branch scan (`branch = stack_id - 1`; members carry `micro_location = root`).
        if occupied_branches(store, source, now_ms) <= 1 {
            if let Some((stack, index)) =
                open_stack(store, parent_id, parent.macro_zone, parent_bits, source_bits, direction, now_ms, bits)
            {
                return Ok(Resolved::Place {
                    surface: surface_of(parent.macro_zone),
                    macro_zone: parent.macro_zone,
                    micro: Micro::Stacked { root: parent_id, branch: stack - 1, index },
                });
            }
        }
        // Invert: the parent re-roots onto the source. Symmetric gate — the parent
        // (now the joiner) must host members in ≤1 stack so it can linearize onto
        // the source, which must itself be a root to become the combined chain's
        // root. The parent carries its single-branch run (see `plan_place`).
        if occupied_branches(store, &parent, now_ms) <= 1 && chain_root_of(source) == source_id {
            if let Some((stack, index)) =
                open_stack(store, source_id, source.macro_zone, source_bits, parent_bits, direction, now_ms, bits)
            {
                return Ok(Resolved::Invert {
                    parent_id,
                    macro_zone: source.macro_zone,
                    micro: Micro::Stacked { root: source_id, branch: stack - 1, index },
                });
            }
        }
    } else if occupied_branches(store, source, now_ms) <= 1 {
        if let Some(stack) = match_stack(parent_bits, source_bits, direction) {
            // Parent is a member: target that card directly (its own host bits decide
            // the stack); append at the next index of that branch on the chain root.
            // No invert — a member can't be re-rooted. Same single-branch join gate.
            let branch = stack - 1;
            let index = next_branch_index(store, parent_root, parent.macro_zone, branch, now_ms);
            return Ok(Resolved::Place {
                surface: surface_of(parent.macro_zone),
                macro_zone: parent.macro_zone,
                micro: Micro::Stacked { root: parent_root, branch, index },
            });
        }
    }

    Err(format!(
        "place: card {source_id} can't stack onto {parent_id} — no stack it joins, and the inverse drop isn't available"
    ))
}

#[allow(clippy::too_many_arguments)]
fn resolve_loose<S: StackStore>(
    store: &S,
    caller_player_id: u32,
    surface: u8,
    macro_zone: u64,
    q: u8,
    r: u8,
    x: i16,
    y: i16,
    now_ms: u64,
) -> Result<(u8, u64, Micro), String> {
    // Uniform hex placement on every surface — no per-surface geometry. A
    // container target (a `macro_zone` whose owner band names a card) must be
    // owned by the caller; the world (owner `0`) is open. Snapped-vs-free is a
    // render concern, so the `(x, y)` offset just rides through (the headless
    // client passes `0`, i.e. centred).
    if q >= 8 || r >= 8 {
        return Err(format!("place: cell ({q}, {r}) out of range (0..=7 each)"));
    }
    let owner = owner_of(macro_zone);
    if owner != 0
        && owning_player(store, owner, now_ms).unwrap_or(WORLD_PLAYER_ID) != caller_player_id
    {
        return Err(format!(
            "place: container {macro_zone} (owner {owner}) not owned by caller {caller_player_id}"
        ));
    }
    Ok((surface, macro_zone, Micro::Loose { local_q: q, local_r: r, x, y }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use resonantdust_codec::packed::{with_owner, INVENTORY_LAYER, PLAYER_SOUL_PACKED, WORLD_LAYER};
    use resonantdust_codec::stacking::DEFAULT_BITS;
    use std::collections::HashMap;

    // Build a CardView via the codec so flags are laid out exactly as on the wire.
    fn loose(card_id: u32, owner_id: u32, surface: u8, q: u8, r: u8) -> CardView {
        let (micro_location, flags) = Micro::snap(q, r).apply(0);
        let macro_zone = with_surface(0, surface);
        CardView { card_id, owner_id, micro_location, macro_zone, packed_definition: 0, flags, stock: 0 }
    }
    fn stacked(card_id: u32, owner_id: u32, macro_zone: u64, root: u32, branch: u8, index: u8) -> CardView {
        let (micro_location, flags) = Micro::Stacked { root, branch, index }.apply(0);
        CardView { card_id, owner_id, micro_location, macro_zone, packed_definition: 0, flags, stock: 0 }
    }
    /// A player_soul (identified by definition 0xFFFF): owner_id is the player_id,
    /// terminates the owner walk.
    fn soul(card_id: u32, player_id: u32) -> CardView {
        let (micro_location, flags) = Micro::snap(0, 0).apply(0);
        CardView {
            card_id,
            owner_id: player_id,
            micro_location,
            macro_zone: 0,
            packed_definition: PLAYER_SOUL_PACKED,
            flags,
            stock: 0,
        }
    }

    #[derive(Default)]
    struct Mock {
        cards: HashMap<u32, CardView>,
        /// The synthetic tile every cell reports (tests place onto a single cell).
        tile: Option<CardView>,
    }
    impl Mock {
        fn with(mut self, v: CardView) -> Self {
            self.cards.insert(v.card_id, v);
            self
        }
        fn with_tile(mut self, t: CardView) -> Self {
            self.tile = Some(t);
            self
        }
    }
    impl CardStore for Mock {
        fn card_at(&self, id: u32, _t: u64) -> Option<CardView> {
            self.cards.get(&id).cloned()
        }
    }
    impl StackStore for Mock {
        fn members_of(&self, root_id: u32, _now: u64) -> Vec<CardView> {
            self.cards
                .values()
                .filter(|v| matches!(Micro::of(v.micro_location, v.flags), Micro::Stacked { root, .. } if root == root_id))
                .cloned()
                .collect()
        }
        fn tile_at(&self, _macro_zone: u64, _q: u8, _r: u8, _now: u64) -> Option<CardView> {
            self.tile.clone()
        }
    }

    const P: u32 = 7; // caller player_id

    #[test]
    fn stack_onto_loose_root_picks_first_index() {
        // soul(1024) owns parent(1025, loose on world) and source(1026, loose).
        let store = Mock::default()
            .with(soul(1024, P))
            .with({ let mut c = loose(1025, 1024, WORLD_LAYER, 1, 1); c.macro_zone = with_surface(0, WORLD_LAYER); c })
            .with({ let mut c = loose(1026, 1024, WORLD_LAYER, 2, 2); c.macro_zone = with_surface(0, WORLD_LAYER); c });
        let plan = plan_place(&store, 1026, Placement::Stack { parent_id: 1025, direction: STACK_DIR_UP }, P, 0, &|_| DEFAULT_BITS).unwrap();
        assert_eq!(plan.writes.len(), 1);
        let w = plan.writes[0];
        assert_eq!(w.card_id, 1026);
        assert_eq!(w.micro, Micro::Stacked { root: 1025, branch: STACK_DIR_UP, index: 0 });
    }

    #[test]
    fn second_stack_appends_next_index() {
        let mz = with_surface(0, WORLD_LAYER);
        let store = Mock::default()
            .with(soul(1024, P))
            .with({ let mut c = loose(1025, 1024, WORLD_LAYER, 1, 1); c.macro_zone = mz; c })
            .with(stacked(1027, 1024, mz, 1025, STACK_DIR_UP, 0)) // existing member at index 0
            .with({ let mut c = loose(1026, 1024, WORLD_LAYER, 2, 2); c.macro_zone = mz; c });
        let plan = plan_place(&store, 1026, Placement::Stack { parent_id: 1025, direction: STACK_DIR_UP }, P, 0, &|_| DEFAULT_BITS).unwrap();
        assert_eq!(plan.writes[0].micro, Micro::Stacked { root: 1025, branch: STACK_DIR_UP, index: 1 });
    }

    #[test]
    fn members_travel_and_reroot_on_stack_move() {
        let mz = with_surface(0, WORLD_LAYER);
        // source 1026 is a loose root with a single-branch run (1028 on its up stack).
        let store = Mock::default()
            .with(soul(1024, P))
            .with({ let mut c = loose(1025, 1024, WORLD_LAYER, 1, 1); c.macro_zone = mz; c })
            .with({ let mut c = loose(1026, 1024, WORLD_LAYER, 2, 2); c.macro_zone = mz; c })
            .with(stacked(1028, 1024, mz, 1026, STACK_DIR_UP, 0));
        let plan = plan_place(&store, 1026, Placement::Stack { parent_id: 1025, direction: STACK_DIR_DOWN }, P, 0, &|_| DEFAULT_BITS).unwrap();
        assert_eq!(plan.writes.len(), 2, "source + its run");
        // source joins 1025 going DOWN at index 0; its run follows it into the JOIN
        // branch, re-indexed contiguously ABOVE the source's slot (DOWN, index 1) —
        // the run is "outward" from the source regardless of its old branch.
        assert_eq!(plan.writes[0].micro, Micro::Stacked { root: 1025, branch: STACK_DIR_DOWN, index: 0 });
        let member = plan.writes.iter().find(|w| w.card_id == 1028).unwrap();
        assert_eq!(member.micro, Micro::Stacked { root: 1025, branch: STACK_DIR_DOWN, index: 1 });
    }

    #[test]
    fn stack_member_onto_card_carries_run_and_splices_old_chain() {
        // Chain on root 1100 (up): 1101(idx0), 1102(idx1), 1103(idx2). Grab the
        // MIDDLE member 1102 and stack it onto a separate loose card 1200. 1102 +
        // its outward run (1103) join 1200's up stack; the old chain collapses to
        // just 1101.
        let mz = with_surface(0, WORLD_LAYER);
        let store = Mock::default()
            .with(soul(1024, P))
            .with({ let mut c = loose(1100, 1024, WORLD_LAYER, 1, 1); c.macro_zone = mz; c })
            .with(stacked(1101, 1024, mz, 1100, STACK_DIR_UP, 0))
            .with(stacked(1102, 1024, mz, 1100, STACK_DIR_UP, 1))
            .with(stacked(1103, 1024, mz, 1100, STACK_DIR_UP, 2))
            .with({ let mut c = loose(1200, 1024, WORLD_LAYER, 5, 5); c.macro_zone = mz; c });
        let plan = plan_place(&store, 1102, Placement::Stack { parent_id: 1200, direction: STACK_DIR_UP }, P, 0, &|_| DEFAULT_BITS).unwrap();
        // 1102 joins 1200 up@0; 1103 (its run) re-roots above it at up@1.
        let w1102 = plan.writes.iter().find(|w| w.card_id == 1102).unwrap();
        assert_eq!(w1102.micro, Micro::Stacked { root: 1200, branch: STACK_DIR_UP, index: 0 });
        let w1103 = plan.writes.iter().find(|w| w.card_id == 1103).unwrap();
        assert_eq!(w1103.micro, Micro::Stacked { root: 1200, branch: STACK_DIR_UP, index: 1 });
        // 1101 stays on 1100 (it was below the grab — never carried); no gap to close
        // since 1102/1103 were the outward tail, so 1101 keeps index 0 (no write).
        assert!(plan.writes.iter().all(|w| w.card_id != 1101), "1101 unchanged at up@0");
    }

    #[test]
    fn multi_branch_root_cannot_join_inverts_instead() {
        // Root 1300 hosts members in TWO branches (up 1301, down 1302). Grab 1300 and
        // drop it onto lone card 1400: 1300 can't JOIN (a stack grows one direction,
        // so a 2-branch root can't linearize into one slot), so the drop inverts —
        // 1400 joins 1300 instead, leaving 1300 the root of its two branches.
        let mz = with_surface(0, WORLD_LAYER);
        let store = Mock::default()
            .with(soul(1024, P))
            .with({ let mut c = loose(1300, 1024, WORLD_LAYER, 1, 1); c.macro_zone = mz; c })
            .with(stacked(1301, 1024, mz, 1300, STACK_DIR_UP, 0))
            .with(stacked(1302, 1024, mz, 1300, STACK_DIR_DOWN, 0))
            .with({ let mut c = loose(1400, 1024, WORLD_LAYER, 5, 5); c.macro_zone = mz; c });
        let plan = plan_place(&store, 1300, Placement::Stack { parent_id: 1400, direction: STACK_DIR_UP }, P, 0, &|_| DEFAULT_BITS).unwrap();
        // Invert: 1400 (the parent) re-roots onto 1300 — 1300 stays the root, keeps
        // its two branches; only 1400 moves into 1300's chain.
        let w1400 = plan.writes.iter().find(|w| w.card_id == 1400).unwrap();
        assert!(matches!(w1400.micro, Micro::Stacked { root: 1300, .. }), "1400 joins 1300, not the reverse");
    }

    #[test]
    fn rejects_cycle_self_and_foreign_owner() {
        let mz = with_surface(0, WORLD_LAYER);
        let store = Mock::default()
            .with(soul(1024, P))
            .with({ let mut c = loose(1025, 1024, WORLD_LAYER, 1, 1); c.macro_zone = mz; c })
            .with(stacked(1026, 1024, mz, 1025, STACK_DIR_UP, 0)) // 1026 is a member of 1025
            .with(soul(2000, 9))
            .with({ let mut c = loose(3000, 2000, WORLD_LAYER, 3, 3); c.macro_zone = mz; c }); // owned by player 9
        // self-stack
        assert!(plan_place(&store, 1025, Placement::Stack { parent_id: 1025, direction: STACK_DIR_UP }, P, 0, &|_| DEFAULT_BITS).is_err());
        // already a member: dropping member 1026 back onto its own root 1025 must reject
        // (else it re-stacks onto itself rather than no-op).
        let err = plan_place(&store, 1026, Placement::Stack { parent_id: 1025, direction: STACK_DIR_UP }, P, 0, &|_| DEFAULT_BITS).unwrap_err();
        assert!(err.contains("already part of"), "{err}");
        // and dropping it onto a sibling in the same chain rejects the same way.
        let store2 = Mock::default()
            .with(soul(1024, P))
            .with({ let mut c = loose(1025, 1024, WORLD_LAYER, 1, 1); c.macro_zone = mz; c })
            .with(stacked(1026, 1024, mz, 1025, STACK_DIR_UP, 0))
            .with(stacked(1027, 1024, mz, 1025, STACK_DIR_UP, 1));
        let err = plan_place(&store2, 1026, Placement::Stack { parent_id: 1027, direction: STACK_DIR_UP }, P, 0, &|_| DEFAULT_BITS).unwrap_err();
        assert!(err.contains("already part of"), "{err}");
        // cycle: stacking root 1025 onto its own member 1026
        let err = plan_place(&store, 1025, Placement::Stack { parent_id: 1026, direction: STACK_DIR_UP }, P, 0, &|_| DEFAULT_BITS).unwrap_err();
        assert!(err.contains("cycle"), "{err}");
        // foreign-owned source
        let err = plan_place(&store, 3000, Placement::Stack { parent_id: 1025, direction: STACK_DIR_UP }, P, 0, &|_| DEFAULT_BITS).unwrap_err();
        assert!(err.contains("owned by player 9"), "{err}");
    }

    #[test]
    fn loose_world_placement_lands_at_cell() {
        let store = Mock::default()
            .with(soul(1024, P))
            .with({ let mut c = loose(1026, 1024, WORLD_LAYER, 2, 2); c.macro_zone = with_surface(0, WORLD_LAYER); c });
        let plan = plan_place(
            &store,
            1026,
            Placement::Loose { surface: WORLD_LAYER, macro_zone: with_surface(0, WORLD_LAYER), q: 5, r: 6, x: 0, y: 0 },
            P,
            0,
            &|_| DEFAULT_BITS,
        )
        .unwrap();
        assert_eq!(plan.writes[0].micro, Micro::Loose { local_q: 5, local_r: 6, x: 0, y: 0 });
    }

    #[test]
    fn loose_into_unowned_container_rejected() {
        // A container macro_zone owned by player 9's soul; caller P may not place.
        let other_soul = 5000u32;
        let inv = with_owner(with_surface(0, INVENTORY_LAYER), other_soul);
        let store = Mock::default()
            .with(soul(2000, 9))
            .with({ let mut c = loose(other_soul, 2000, INVENTORY_LAYER, 0, 0); c.owner_id = 2000; c })
            .with(soul(1024, P))
            .with({ let mut c = loose(1026, 1024, WORLD_LAYER, 2, 2); c.macro_zone = with_surface(0, WORLD_LAYER); c });
        let err = plan_place(
            &store,
            1026,
            Placement::Loose { surface: INVENTORY_LAYER, macro_zone: inv, q: 0, r: 0, x: 0, y: 0 },
            P,
            0,
            &|_| DEFAULT_BITS,
        )
        .unwrap_err();
        assert!(err.contains("not owned by caller"), "{err}");
    }

    // ── leaf-aware host/join stacking (test_dust / log scenario) ──────────────
    //
    // Three card kinds, resolved by `packed_definition` through the test `BITS`:
    //   LOG  (10): hosts top+bottom, joins top+bottom — a normal host.
    //   DUST (20): hosts NOTHING, joins top+bottom — a leaf that caps a stack.
    //   CORPUS(30): DEFAULT (hosts hex+top+bottom, joins top+bottom).
    const LOG: u16 = 10;
    const DUST: u16 = 20;
    const CORPUS: u16 = 30;
    const TILE: u16 = 40;
    const TOP_BOTTOM: u8 = 0b1100;
    const HEX: u8 = 0b0010;

    fn bits_for(p: u16) -> StackBits {
        match p {
            LOG => StackBits { hosts: TOP_BOTTOM, joins: TOP_BOTTOM },
            DUST => StackBits { hosts: 0, joins: TOP_BOTTOM },
            TILE => StackBits { hosts: 0, joins: HEX }, // tile: hosts nothing, joins hex
            _ => DEFAULT_BITS, // CORPUS + anything else (hosts hex+top+bottom)
        }
    }

    fn card(id: u32, packed: u16) -> CardView {
        let mut c = loose(id, 1024, WORLD_LAYER, 2, 2);
        c.macro_zone = with_surface(0, WORLD_LAYER);
        c.packed_definition = packed;
        c
    }

    fn tile_view(packed: u16) -> CardView {
        CardView {
            card_id: 0,
            owner_id: 0,
            micro_location: 0,
            macro_zone: with_surface(0, WORLD_LAYER),
            packed_definition: packed,
            flags: 0,
            stock: 0,
        }
    }

    #[test]
    fn loose_on_tile_requires_hex_host() {
        let mz = with_surface(0, WORLD_LAYER);
        let pl = Placement::Loose { surface: WORLD_LAYER, macro_zone: mz, q: 2, r: 2, x: 0, y: 0 };
        // CORPUS hosts hex (DEFAULT): the tile joins its hex stack → seated loose.
        let store = Mock::default().with(soul(1024, P)).with(card(1300, CORPUS)).with_tile(tile_view(TILE));
        let plan = plan_place(&store, 1300, pl, P, 0, &bits_for).unwrap();
        assert_eq!(plan.writes.len(), 1);
        assert!(matches!(plan.writes[0].micro, Micro::Loose { .. }));
        // DUST hosts nothing: the tile can't join it → rejected, no overlap.
        let store = Mock::default().with(soul(1024, P)).with(card(1400, DUST)).with_tile(tile_view(TILE));
        let err = plan_place(&store, 1400, pl, P, 0, &bits_for).unwrap_err();
        assert!(err.contains("hex"), "{err}");
    }

    #[test]
    fn loose_on_empty_cell_allows_non_hex_host() {
        // No tile at the cell (Mock reports None): a host-0 card still seats — the
        // moving-tile-card-into-open-cell edge case.
        let mz = with_surface(0, WORLD_LAYER);
        let store = Mock::default().with(soul(1024, P)).with(card(1400, DUST));
        let plan = plan_place(
            &store,
            1400,
            Placement::Loose { surface: WORLD_LAYER, macro_zone: mz, q: 5, r: 5, x: 0, y: 0 },
            P,
            0,
            &bits_for,
        )
        .unwrap();
        assert_eq!(plan.writes.len(), 1);
    }

    #[test]
    fn forward_dust_joins_log_top() {
        // Drop dust onto a loose log: log hosts top, dust joins it → dust on top.
        let store = Mock::default().with(soul(1024, P)).with(card(1100, LOG)).with(card(1200, DUST));
        let plan = plan_place(
            &store,
            1200,
            Placement::Stack { parent_id: 1100, direction: STACK_DIR_UP },
            P,
            0,
            &|p| bits_for(p),
        )
        .unwrap();
        assert_eq!(plan.writes.len(), 1);
        assert_eq!(plan.writes[0].card_id, 1200);
        assert_eq!(plan.writes[0].micro, Micro::Stacked { root: 1100, branch: STACK_DIR_UP, index: 0 });
    }

    #[test]
    fn invert_log_onto_dust_reroots_dust_onto_log() {
        // Drop log onto a LONE dust: forward fails (dust hosts nothing), so the
        // drop inverts — the dust re-roots onto the (stationary) log at top. Same
        // end state as `forward_dust_joins_log_top`, reached the other way.
        let store = Mock::default().with(soul(1024, P)).with(card(1100, LOG)).with(card(1200, DUST));
        let plan = plan_place(
            &store,
            1100,
            Placement::Stack { parent_id: 1200, direction: STACK_DIR_UP },
            P,
            0,
            &|p| bits_for(p),
        )
        .unwrap();
        // Only the parent (dust) is written; the source (log) stays put as root.
        assert_eq!(plan.writes.len(), 1);
        assert_eq!(plan.writes[0].card_id, 1200);
        assert_eq!(plan.writes[0].micro, Micro::Stacked { root: 1100, branch: STACK_DIR_UP, index: 0 });
    }

    #[test]
    fn invert_rejected_when_parent_is_a_member() {
        // dust is already stacked on log (top). Dropping corpus onto the dust must
        // REJECT: forward fails (dust hosts nothing) and the inverse is disallowed
        // because dust can't be torn out of log's chain.
        let mz = with_surface(0, WORLD_LAYER);
        let store = Mock::default()
            .with(soul(1024, P))
            .with(card(1100, LOG))
            .with({ let mut c = stacked(1200, 1024, mz, 1100, STACK_DIR_UP, 0); c.packed_definition = DUST; c })
            .with(card(1300, CORPUS));
        let err = plan_place(
            &store,
            1300,
            Placement::Stack { parent_id: 1200, direction: STACK_DIR_UP },
            P,
            0,
            &|p| bits_for(p),
        )
        .unwrap_err();
        assert!(err.contains("can't stack onto 1200"), "{err}");
    }

    #[test]
    fn leaf_fallback_corpus_skips_capped_top_for_bottom() {
        // log's top is capped by a dust leaf (hosts nothing). Dropping corpus onto
        // the log root asking for UP can't extend top (the leaf won't host it), so
        // it falls through to the bottom stack, which the log hosts.
        let mz = with_surface(0, WORLD_LAYER);
        let store = Mock::default()
            .with(soul(1024, P))
            .with(card(1100, LOG))
            .with({ let mut c = stacked(1200, 1024, mz, 1100, STACK_DIR_UP, 0); c.packed_definition = DUST; c })
            .with(card(1300, CORPUS));
        let plan = plan_place(
            &store,
            1300,
            Placement::Stack { parent_id: 1100, direction: STACK_DIR_UP },
            P,
            0,
            &|p| bits_for(p),
        )
        .unwrap();
        assert_eq!(plan.writes[0].card_id, 1300);
        assert_eq!(plan.writes[0].micro, Micro::Stacked { root: 1100, branch: STACK_DIR_DOWN, index: 0 });
    }

    #[test]
    fn two_non_hosting_cards_cannot_stack_either_way() {
        // Two dusts: neither hosts anything, so forward AND inverse both fail.
        let store = Mock::default().with(soul(1024, P)).with(card(1200, DUST)).with(card(1201, DUST));
        let err = plan_place(
            &store,
            1200,
            Placement::Stack { parent_id: 1201, direction: STACK_DIR_UP },
            P,
            0,
            &|p| bits_for(p),
        )
        .unwrap_err();
        assert!(err.contains("can't stack onto 1201"), "{err}");
    }

    // ── splice index-collapse ─────────────────────────────────────────────────

    #[test]
    fn splice_collapses_branch_after_member_destroy() {
        // top branch on root 100: 200@0,201@1,202@2,203@3,204@4. Destroy 202 (a
        // mid-stack member) → 203,204 shift down to 2,3; 200,201 unchanged (no
        // writes). Mirrors corpus_b_top destroying a mid-stack corpus so the
        // survivor's index becomes the card-below's index + 1.
        let mz = with_surface(0, WORLD_LAYER);
        let store = Mock::default()
            .with(soul(1024, P))
            .with({ let mut c = loose(100, 1024, WORLD_LAYER, 1, 1); c.macro_zone = mz; c })
            .with(stacked(200, 1024, mz, 100, STACK_DIR_UP, 0))
            .with(stacked(201, 1024, mz, 100, STACK_DIR_UP, 1))
            .with(stacked(202, 1024, mz, 100, STACK_DIR_UP, 2))
            .with(stacked(203, 1024, mz, 100, STACK_DIR_UP, 3))
            .with(stacked(204, 1024, mz, 100, STACK_DIR_UP, 4));
        let writes = plan_splice(&store, &[202], 0);
        let mut got: Vec<(u32, u8)> = writes
            .iter()
            .map(|w| match w.micro {
                Micro::Stacked { index, root, .. } => {
                    assert_eq!(root, 100, "root unchanged on member destroy");
                    (w.card_id, index)
                }
                _ => panic!("expected stacked write"),
            })
            .collect();
        got.sort();
        assert_eq!(got, vec![(203, 2), (204, 3)], "only the cards above the hole shift down");
    }

    #[test]
    fn splice_promotes_successor_and_collapses_on_root_destroy() {
        // root 100 destroyed; members 200@up0, 201@up1, 202@down0. Successor =
        // 200 (rank up<down, lowest index) → loose root; 201 collapses to up0 on
        // it; 202 re-roots to down0.
        let mz = with_surface(0, WORLD_LAYER);
        let store = Mock::default()
            .with(soul(1024, P))
            .with({ let mut c = loose(100, 1024, WORLD_LAYER, 2, 2); c.macro_zone = mz; c })
            .with(stacked(200, 1024, mz, 100, STACK_DIR_UP, 0))
            .with(stacked(201, 1024, mz, 100, STACK_DIR_UP, 1))
            .with(stacked(202, 1024, mz, 100, STACK_DIR_DOWN, 0));
        let writes = plan_splice(&store, &[100], 0);
        let w200 = writes.iter().find(|w| w.card_id == 200).expect("successor write");
        assert!(matches!(w200.micro, Micro::Loose { .. }), "successor becomes loose root");
        let w201 = writes.iter().find(|w| w.card_id == 201).expect("201 write");
        assert_eq!(w201.micro, Micro::Stacked { root: 200, branch: STACK_DIR_UP, index: 0 });
        let w202 = writes.iter().find(|w| w.card_id == 202).expect("202 write");
        assert_eq!(w202.micro, Micro::Stacked { root: 200, branch: STACK_DIR_DOWN, index: 0 });
    }

    // ── drag-carry on a loose move of a stack member ─────────────────────────

    #[test]
    fn loose_move_member_carries_whole_run_when_no_lock() {
        // root 100; top: 200@0, 201@1, 202@2 (no holds). Move 200 loose → it carries
        // 201,202 (the run above it); they re-root onto 200 as a fresh top stack.
        let mz = with_surface(0, WORLD_LAYER);
        let store = Mock::default()
            .with(soul(1024, P))
            .with({ let mut c = loose(100, 1024, WORLD_LAYER, 1, 1); c.macro_zone = mz; c })
            .with(stacked(200, 1024, mz, 100, STACK_DIR_UP, 0))
            .with(stacked(201, 1024, mz, 100, STACK_DIR_UP, 1))
            .with(stacked(202, 1024, mz, 100, STACK_DIR_UP, 2));
        let plan = plan_place(
            &store,
            200,
            Placement::Loose { surface: WORLD_LAYER, macro_zone: with_surface(0, WORLD_LAYER), q: 5, r: 6, x: 0, y: 0 },
            P,
            0,
            &|_| DEFAULT_BITS,
        )
        .unwrap();
        let m = |id: u32| plan.writes.iter().find(|w| w.card_id == id).map(|w| w.micro);
        assert!(matches!(m(200), Some(Micro::Loose { .. })), "leader becomes a loose root");
        assert_eq!(m(201), Some(Micro::Stacked { root: 200, branch: STACK_DIR_UP, index: 0 }));
        assert_eq!(m(202), Some(Micro::Stacked { root: 200, branch: STACK_DIR_UP, index: 1 }));
        // root 100 has no top survivors → no collapse writes for it.
        assert_eq!(plan.writes.len(), 3, "leader + 2 carried, no old-chain writes");
    }

    #[test]
    fn loose_move_member_run_terminates_at_position_lock_and_old_chain_collapses() {
        // root 100; top: 200@0, 201@1, 202@2 (POSITION-HELD), 203@3. Move 200 loose:
        // the run carries 201 only (it stops at the held 202); 202+203 stay and
        // collapse to 0,1 on root 100. Mirrors jim moving axe1 with dust locked.
        let mz = with_surface(0, WORLD_LAYER);
        let held = {
            let mut c = stacked(202, 1024, mz, 100, STACK_DIR_UP, 2);
            c.stock = aspects::inc(c.stock, aspects::StockAspect::PosHold);
            c
        };
        let store = Mock::default()
            .with(soul(1024, P))
            .with({ let mut c = loose(100, 1024, WORLD_LAYER, 1, 1); c.macro_zone = mz; c })
            .with(stacked(200, 1024, mz, 100, STACK_DIR_UP, 0))
            .with(stacked(201, 1024, mz, 100, STACK_DIR_UP, 1))
            .with(held)
            .with(stacked(203, 1024, mz, 100, STACK_DIR_UP, 3));
        let plan = plan_place(
            &store,
            200,
            Placement::Loose { surface: WORLD_LAYER, macro_zone: with_surface(0, WORLD_LAYER), q: 5, r: 6, x: 0, y: 0 },
            P,
            0,
            &|_| DEFAULT_BITS,
        )
        .unwrap();
        let m = |id: u32| plan.writes.iter().find(|w| w.card_id == id).map(|w| w.micro);
        assert!(matches!(m(200), Some(Micro::Loose { .. })), "axe1 lifts off as a loose root");
        assert_eq!(m(201), Some(Micro::Stacked { root: 200, branch: STACK_DIR_UP, index: 0 }), "axe2 carried");
        // the held dust stays on 100 but its index collapses 2→0;
        assert_eq!(m(202), Some(Micro::Stacked { root: 100, branch: STACK_DIR_UP, index: 0 }), "locked dust stays, index shifts");
        // corpus3 stays above dust, collapses 3→1 (dust's index + 1).
        assert_eq!(m(203), Some(Micro::Stacked { root: 100, branch: STACK_DIR_UP, index: 1 }));
    }
}
