# Tile holds via the op-log (on the already-spawned tile-card)

Status: **plan**. Implement tile concurrency holds — currently a never-wired TODO
— through the op-log, on the tile-card that acting on a tile already promotes.
Retires the vestigial flag-based tile-hold mechanism AND unblocks removing the
flag word's hold/dead fields entirely.

## The realization

Acting on a tile **promotes it to a real `Card`** (`tiles::find_or_create_tile_card`
→ `create_at(...)`). So there's already a card to hold — we don't need a distinct
"tile-hold" concept, just the holds that card already has (the op-log).

## Current reality (what the trace showed)

- **Tile holds were never implemented.** `gateway/src/apply.rs:138` passes
  `hold_mask = 0` with a `// TODO: runtime tile holds`. So `acquire_tile_hold`
  (flag-based, in `tiles.rs`) is **never called** — `cut_tree`'s concurrent-cut
  guard does nothing today. Two players can cut the same tree and double-harvest.
- **The tile is the SYNTHETIC tile at match/translate time** (`synth_card`, zone
  data, no card_id). The tile-card is minted only at apply (`apply_action_tile` →
  `find_or_create_tile_card`), for the stock (wood) writes.
- `apply_action_tile` (region DB) is a separate reducer because tiles live on the
  region DB; the `op_log` table exists there too (same shard module), so LogOps
  work on the tile-card.

So: not a migration of a live mechanism — **a first correct implementation**, on
the op-log, replacing dead flag code.

## Design

A tile recipe's hold writes (`set_use`/`set_claim` on the tile = `claim`/`touch`
on the synthetic tile) become **tile-LogOps**: the same op-log deltas as a card
hold, but the `card_id` is resolved at apply time (the minted tile-card), not
carried — the tile is identified by `(surface, macro_zone, q, r)`, already
`apply_action_tile`'s params.

**Concurrency guard = an apply-time CAS, not match-time `can_claim`.** The matcher
binds the *synthetic* tile (zone data), which can't see the transient tile-card's
holds, so `@input can_claim` on a tile is best-effort. The exact guard is in
`apply_action_tile`: promote the tile-card, read its op-log-materialized `claim`,
reject if an exclusive acquire collides — atomic within the reducer transaction
(mirrors the existing per-shard race-guard discipline).

## Phases

### T1 — translate emits tile-LogOps
`shared/rules/src/dsl_recipe.rs`
- In the synthetic-tile branch (the `else` that currently only does
  `ModifyTileStock`), route GLOBAL-aspect writes (`StockAspect::from_name(aspect)`)
  to a new `Effect::TileLogOp { aspect_id, op, modifier, at }` (no card_id; the
  shard resolves the tile-card). Per-def tile aspects (wood) stay `ModifyTileStock`.
- **Verify:** rules test — `set_use` on a tile → `TileLogOp(Claim,Inc)@0` +
  `(Claim,Dec)@win`; `wood dec` stays `ModifyTileStock`.

### T2 — gateway sends the tile-LogOps
`gateway/src/apply.rs`
- Collect `Effect::TileLogOp`s into a `Vec<LogOpArg>`-shaped arg (card_id unused /
  0) and pass to `apply_action_tile`, replacing the `hold_mask = 0` TODO. Drop the
  `hold_mask` param.

### T3 — apply_action_tile applies them on the tile-card (+ CAS)
`spacetime/server/modules/shard/src/gate_api.rs`, `tiles.rs`
- Promote the tile-card (`find_or_create_tile_card`) once. For each acquire LogOp
  that's an exclusive `Claim`, CAS against the tile-card's materialized stock
  (`aspects::count(tile.stock, Claim) > 0` → `Err`, rolls back). Then
  `oplog::apply_op(tile_card_id, aspect, time, op, modifier)` for each.
- Delete `acquire_tile_hold` / `release_tile_hold` (`tiles.rs`) and
  `HOLD_MASK_KINDS` / `hold_field` (`gate_api.rs`) — now unused. Bindings regen.

### T4 — retire the flag hold + dead fields
`shared/codec/src/flags.rs`, `card_model.rs`, `spacetime` `flags.rs`
- With the tile path off the flags too, NOTHING reads/writes the flag refcounts
  (`slot_*_count`) or the `dead` bit. Remove them from the layout + the helpers
  (`HoldField`, `hold_count`, `increment_hold`/`decrement_hold`, `drop_hold_count`,
  flag `has_active_holds`, `card_model::is_dead`'s old bit, `dead` in `state_mask`).
  Frees the bottom of the `flags` word — the original motivation.
- **Verify:** full corpus + shared tests; the flag word's `state_mask` still
  carries the surviving bits (pos_need/pos_want/surface_locked/zone_born).

### T5 — fire cut_tree end-to-end (the verification the op-log never got)
harness
- Fix the `CUT_TREE_SPIKE` scenario so it MATCHES: light the corpus first
  (`corpus_lit ≥ 1`) — currently the loadout corpus is dim, so cut_tree's `@input`
  never passes. Then: fire cut_tree → assert the tile-card carries `Claim`/`Touch`
  LogOps in `op_log`; fire two concurrent cuts on one tile → assert the second is
  rejected by the CAS. This is also the first full new-model verification of the
  tile-context recipe (tile hold + `^create` + the wood decrement).

## Why this is the right shape
- **Fixes a real gap** (tile concurrency was never guarded), not just cleanup.
- **One hold mechanism** — the tile-card uses the op-log like every card; the
  separate flag tile-hold path is deleted.
- **Unblocks the flag-word retirement** (T4) that the card-side cleanup couldn't
  finish while the tile path still used the flags.

## Risks / notes
- The match-time `can_claim` on a tile stays best-effort (synthetic tile can't see
  the transient tile-card's holds); the apply-time CAS is the exact guard. If we
  later want match-time tile-hold visibility, the matcher would need to read a
  promoted tile-card — out of scope here.
- `apply_action_tile` stays a separate reducer (region DB) — only its hold
  mechanism changes (flag → op-log).
- T4 (flag-field removal) is the one core-layout change; do it last, after T1–T3
  prove nothing else reads the fields.
