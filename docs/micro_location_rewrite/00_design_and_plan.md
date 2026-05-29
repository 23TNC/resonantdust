# `micro_location` / stacking rewrite — design & phased plan

Status: **in progress** (started 2026-05-28). Phases 1–2 done (Phase 1
verified); Phase 3 (server logic, 12 files) is the active front. The server
does **not compile** mid-Phase-3 by design — `bin/st build shard` is the
compiler-driven worklist. See `01_issues_log.md` for the `Micro` pattern every
remaining site follows and the per-file checklist.

This rewrite replaces the dual-field, dual-mechanism stacking encoding with a
single, fixed definition. It touches ~15 server files and ~20 client files.
See `01_issues_log.md` for problems hit and how they were solved.

---

## 1. The new model

### 1.1 `micro_location` (u32) — gated by the `micro_is_card` flag

`micro_location` now has exactly two interpretations, selected by the new
`micro_is_card` flag (in `flags_bk`):

- **`micro_is_card` set → `micro_location` is a `root` card_id.** The card is
  stacked. Its chain is identified by `root` (a loose/snapped card with
  `micro_is_card` clear); its branch by `stack_state`; its slot by `stack_index`.
  We store **root, never parent** — flat chains, fault-tolerant (a deleted
  member leaves a gap, no repair write), no spawn-order fragility.

- **`micro_is_card` clear → `micro_location` is packed loose coords + offset:**

  ```
  bit 31 ............. 29 | 28 .. 26 | 25 ........ 14 | 13 ......... 2 | 1 .. 0
     [ local_q : u3      | local_r:u3 |  x : i12      |   y : i12     | rsvd:2 ]
  ```

  `local_q` / `local_r` (0..7) address a cell within the zone (hex or rect grid,
  per surface). `x` / `y` (signed 12-bit, ±2047) are the offset *within* that
  cell. Reserved 2 bits for future use.

### 1.2 `micro_zone` (u8) — **REMOVED**

Every datum `micro_zone` carried now lives elsewhere: coords → `micro_location`
(loose form), stacked-state → `flags`, position/direction → `flags`. The column
is dropped from the `Card` table and `SoulPrivate`. (Data is disposable
pre-release, so the schema reshape is free.)

### 1.3 New flags

| flag | field | bits | kind | why this field |
|------|-------|------|------|----------------|
| `micro_is_card` | `cards_bk` | 24 | single | discriminates `micro_location`; must NOT forward-propagate independently of `micro_location` |
| `stack_state`   | `cards_bk` | 25–26 | u2 | branch / loose-kind (see 1.4); pairs with `micro_location` |
| `stack_index`   | `cards_bk` | 27–30 | u4 | slot in the chain (0..15); pairs with `micro_location` |
| `zone_born`     | `cards_state` | 13 | single | static origin marker; safe to forward-propagate |

**Placement rationale (the load-bearing decision):** `write_at` forward-
propagates **only `flags_state`** (`propagate_flag_diff_forward`); `flags_bk` and
the position columns (`micro_location`) carry forward by row-cloning and are
*not* independently propagated. The stacking trio (`micro_is_card`,
`stack_state`, `stack_index`) is meaningless unless it stays in lockstep with
`micro_location` — so it must share `micro_location`'s propagation behaviour →
**`flags_bk`**. Putting it in `flags_state` would let the bit-diff propagator
walk it forward independently of `micro_location` and tear the two apart.
`zone_born` is static (set once at materialize, never flipped), so forward-prop
is harmless → `flags_state` (preserves `flags_bk` headroom; bk would otherwise
fill to exactly 32).

`flags_bk` budget after: bits 24–30 used, **bit 31 free**.
`flags_state` budget after: bit 13 used, bits 14–31 free.

### 1.4 `stack_state` (u2) semantics — gated on `micro_is_card`

| value | `micro_is_card` set (stacked) | `micro_is_card` clear (loose) |
|-------|-------------------------------|-------------------------------|
| 0 | **hex** branch (visually beneath root) | **loose-hex** — free offset in a hex cell |
| 1 | **top** branch | **loose-rect** — free offset in a rect cell |
| 2 | **bottom** branch | **snap-hex** — centered, exclusive cell occupant |
| 3 | **deferred** — resolve at mirror time | **snap-rect** — centered on rect grid |

Stacked values 0/1/2 keep the existing `STACK_DIR_HEX/UP/DOWN` branch numbers
(so the recipe-grammar `slot.<N>` convention is unchanged). `stack_index` gives
the slot within a branch.

### 1.5 Loose flavours (`micro_is_card` clear)

- **loose-hex / loose-rect** — many per cell, positioned by `x`/`y` offset.
  Used for scattered world items / loot and free inventory placement.
- **snap-hex / snap-rect** — centered (`x`/`y` ignored), **one per cell**
  (exclusivity is server-arbitrated; contested snap degrades to loose). A snap
  card is a chain *root*. When a structure (rect) is snapped onto a tile cell,
  the structure is the root and the `zone_born` tile becomes a `hex`-branch
  member of the structure's chain.

### 1.6 `zone_born` + synthetic tiles

`zone_born` marks a card generated from zone tile data. Tiles stay **synthetic**
(client-derived for recipe matching) until a recipe materializes a real `Card`
row. Materialized `zone_born` tiles carry stock state (`tile_stock_0/1`) that
can't be re-derived; the server tracks their cell for zone write-back, so the
cell survives even when the tile is stacked (its `micro_location` becomes a root
pointer) — see issue log "materialized tile loses cell".

### 1.7 Stacking is one mechanism (root model)

- A chain = one **root** (`micro_is_card` clear, loose/snapped) + N **members**
  (`micro_is_card` set, `micro_location == root`, `stack_state` = branch,
  `stack_index` = slot). Flat: no nested roots, no parent pointers.
- "Stack onto card B" (B mid-chain) = join B's root + B's branch, claim
  `index = B.index + 1`; if taken, **append at the branch's max+1** (never
  renumber the common path); overflow / missing-target / deferred-target →
  **fail-to-loose**.
- Lookup "members of root R" = query the `micro_location` btree for `== R`,
  filter `micro_is_card` + branch, sort by `stack_index`. Client mirrors this
  with a `byRoot` map (like the existing `byZone`).

---

## 2. Bit-layout reference (canonical: `content/src/packed.rs`)

New / changed helpers (mirror in `packing.ts`):

- `pack_micro_loose(local_q: u8, local_r: u8, x: i16, y: i16) -> u32`
- `unpack_micro_loose(v: u32) -> (u8, u8, i16, i16)`
- `micro_loose_cell(v: u32) -> (u8, u8)` (just local_q/local_r)
- `micro_location` as card_id: identity (`pack/unpack_micro_location_card_id`
  kept).

Removed: `pack_micro_zone`, `unpack_micro_zone`, `micro_zone_state`,
`pack_stack_micro_zone`, `unpack_stack_micro_zone`, `micro_zone_position`,
`micro_zone_direction`, `pack_slot_micro_zone`, `is_stack_layout`,
`pack_micro_location_xy` / `unpack_micro_location_xy` (loose XY is now part of
`micro_loose`). `StackedState` enum **removed** (state is now the `stack_state`
flag field with the dual semantics in 1.4).

`STACK_DIR_HEX/UP/DOWN` (0/1/2) are kept — they are now the `stack_state` values
for the `micro_is_card`-set branch.

---

## 3. Phases

Each phase aims to leave the tree in a known state. Server first (schema +
logic), regenerate bindings, then client (tsc-driven).

- **Phase 1 — Foundation: `packed.rs` + `flags.json`.**
  - Rewrite `packed.rs` micro section (new `micro_loose` helpers, drop the
    `micro_zone` / `StackedState` machinery, keep `STACK_DIR_*`). Add roundtrip
    tests.
  - `flags.json`: add `zone_born` (cards_state 13), `micro_is_card` (cards_bk
    24), `stack_state` (cards_bk 25–26), `stack_index` (cards_bk 27–30).
  - `flags.rs`: add the four to `StateFlags`/`BkFlags` + accessors.
  - Verify: `bin/content test`.

- **Phase 2 — Server schema.** `cards.rs`: drop `micro_zone` from `Card` +
  `SoulPrivate`; fix `write_at` dirty-diff (remove `micro_zone`). Add helpers:
  `set_stacked(card, root, branch, index)`, `set_loose(card, lq, lr, x, y, kind)`
  that write `micro_location` + the bk flags together (encapsulate the
  discipline). Compiler then enumerates every break.

- **Phase 3 — Server logic.** Rework, compiler-driven: `stacks.rs`, `place.rs`,
  `action_completion.rs`, `cards.rs` (`find_or_create_tile_card`, `inspect_hex`,
  `state_3_followers`, cascade), `movement.rs`, `mini_zone.rs`, `world_gen.rs`,
  `gc.rs`, `recipe_eval.rs`, `actions.rs` (`chain_stitch`), `utilities.rs`,
  `blueprints.rs`, `players.rs`, `souls.rs`. Convert parent-walks → root-filter;
  stacked-state reads → flag reads; coord reads → `micro_loose`.

- **Phase 4 — Build server + regen bindings.** `bin/st build shard`.

- **Phase 5 — Client foundation.** `packing.ts` (mirror `packed.rs`),
  `cardData.ts` (constants, helpers, flag accessors), bindings `types.ts`
  (drop `microZone`).

- **Phase 6 — Client logic (tsc-driven).** `DataManager.ts` (`mirrorCard`),
  `CardManager.ts` (chains/splice/deferred/setCardPosition/byRoot index),
  `Card.ts`, `HexCard.ts`/`RectCard.ts`, `dropResolver.ts`/`DragManager.ts`,
  `LayoutWorld.ts`/`worldCoords.ts`/`pathfind.ts`,
  `ActionManager.ts`/`recipeMatcher.ts`, `InventoryGame.ts`, `DetailsPanel.ts`,
  `LifecycleResolutionManager.ts`, `ReducerManager.ts`.

- **Phase 7 — Verify.** `bin/content test`, `bin/st build shard`,
  `npx tsc --noEmit`, cross-impl parity check, numeric/audit sweep.

---

## 4. Key judgment calls (made without prompting, per instruction)

1. **Remove `micro_zone` entirely** rather than leave it vestigial — the new
   model gives it nothing to hold, and the disposable-data policy makes the
   schema reshape free.
2. **Stacking trio in `flags_bk`, `zone_born` in `flags_state`** — for
   propagation-consistency with `micro_location` (§1.3).
3. **Pure-root chains (no parent pointers / no `Slot` state)** — the current
   server stores parent for `Slot` and root for `OnRoot`; the rewrite collapses
   to one flat root+index mechanism.
4. **`micro_location` loose layout = `[local_q3 | local_r3 | x12 | y12 | rsvd2]`**
   (§1.1). Order chosen for readability; client+server must match.
5. **Deferred / overflow / missing-target → fail-to-loose** (safe floor; nothing
   authoritative corrupts because position is client-local staging until a
   recipe syncs).
