# `micro_location` rewrite — issues log

Running log of problems encountered during the refactor and how they were
resolved. Newest at the bottom of each phase.

---

## Phase 1 — Foundation (`packed.rs`, `flags.json`, `flags.rs`) — DONE

- **`packed.rs`**: removed `StackedState` enum, `pack/unpack_micro_zone`,
  `micro_zone_state`, `pack/unpack_stack_micro_zone`, `micro_zone_position/direction`,
  `pack_slot_micro_zone`, `is_stack_layout`, `pack/unpack_micro_location_xy`.
  Added `pack_micro_loose` / `unpack_micro_loose` / `micro_loose_cell` /
  `pack_micro_snap` (loose layout `[lq3|lr3|x12|y12|rsvd2]`), and the constants
  `STACK_STATE_DEFERRED`, `LOOSE_HEX/RECT`, `SNAP_HEX/RECT`. Kept `STACK_DIR_*`
  and the `micro_location` card_id passthrough. Tests swapped (73 pass).
- **`wasm_api.rs`** (content crate, `#[cfg(feature="js")]`): replaced
  `packMicroZone`/`unpackMicroZone`/`packStackMicroZone`/`unpackStackMicroZone`/
  `packSlotMicroZone`/`isStackLayout` exports with `packMicroLoose` /
  `unpackMicroLoose` / `packMicroSnap`.
- **`flags.json`**: `zone_born` → `cards_state` bit 13; `micro_is_card` →
  `cards_bk` bit 24; `stack_state` → `cards_bk` 25-26; `stack_index` →
  `cards_bk` 27-30. (bk now 24-30 used, bit 31 free.)
- **`flags.rs`**: added the four to `StateFlags`/`BkFlags` + accessors.

### Issue: wasm pkg is generated, not hot-path

`wasm_api.rs` is only compiled under the `js` feature (the `content/pkg/` wasm
bundle, built by `bin/content wasm`). `bin/content test` does NOT compile it.
The client imports `allTextures`/defs from `content/pkg` but **not** the micro
helpers (those are dead exports; the client uses the `packing.ts` native
mirror). **Solution:** regenerated the pkg with `bin/content wasm` to keep
`wasm_api.rs` ↔ pkg in sync and validate the wasm build; no client import
breaks because nothing imported the removed micro exports.

### Decision: STACK_DIR_* reused as stacked-branch `stack_state` values

Rather than a new enum, the stacked-branch `stack_state` values ARE
`STACK_DIR_HEX/UP/DOWN` (0/1/2) + `STACK_STATE_DEFERRED` (3), preserving the
recipe-grammar `slot.<N>` branch-number convention unchanged.

---

## Phase 2 — Server schema + core abstraction (`cards.rs`, `souls.rs`) — DONE

### The `Micro` abstraction (the central pattern for the whole rewrite)

`cards.rs` now defines `enum Micro { Stacked { root, branch, index } | Loose {
local_q, local_r, x, y, kind } }` with:
- `Micro::apply(&mut Card)` — writes `micro_location` + the `micro_is_card` /
  `stack_state` / `stack_index` bits in `flags_bk` together.
- `Micro::of(&Card)` — decodes a row's placement.
- `Micro::snap(lq, lr, kind)`, `Micro::deferred(host)` — constructors.
- free fns `micro_is_card(&Card)`, `stack_branch(&Card)`, `stack_index(&Card)`,
  `root_of_member(&Card)`.

**Every old `(micro_zone, micro_location)` construction site becomes a single
`Micro`.** This is the pattern the remaining server files (Phase 3) follow:
replace `pack_micro_zone(q,r,Free)` → `Micro::Loose{..}` / `Micro::snap`;
`pack_stack_micro_zone(pos,dir,OnRoot)` + parent/root in `micro_location` →
`Micro::Stacked{root, branch, index}`; `pack_slot_micro_zone(dir)` (parent
pointer) → `Micro::Stacked{root, branch, index}` (flat — NO parent pointers).

### Converted in `cards.rs`
- `Card` struct: `micro_zone` field removed; `micro_location` doc updated.
- `create` / `create_at`: take `micro: Micro` instead of `(micro_zone,
  micro_location)`.
- `scrub_or_repath_position_forward`: takes `new_micro: Micro`.
- `write_at` dirty-diff: drops `micro_zone`; treats a change to the stack flag
  bits as a position change (they're part of the position tuple).
- `state_3_followers`: deferred = `micro_is_card && stack_branch ==
  STACK_STATE_DEFERRED`.
- `inspect_hex`: matches on `Micro::of` (loose-at-cell vs hex-branch member).
- `find_or_create_tile_card`: builds `Micro::Stacked{branch:HEX}` under a rect,
  else `Micro::snap(q,r,SNAP_HEX)`; **marks the tile `zone_born`** (in
  `flags_state`).
- `set_micro_zone` removed; added `set_micro(ctx, id, Micro)`.

### Converted in `souls.rs`
- `Soul` table mirror: `micro_zone` field + its two write sites removed (souls
  are loose-on-world; `micro_location` carries loose coords).

### Issue: `scrub` macro_zone no-op compare

After switching to `new_micro.apply(&mut updated)`, the `pos_changed` macro
compare must use the *pre-apply* macro_zone (`prev_macro`), since `apply` /
the assignment already overwrote the field. Fixed by snapshotting `prev_macro`
/ `prev_loc` / `prev_stack` before the mutation.

---

## Phase 3 + 4 — Server logic + build — DONE

All 12 files converted to the `Micro` pattern + flat-root model; **shard builds
green and TS bindings regenerated** (`bin/st build shard`).

- **`stacks.rs`** — DELETED. `CardStack`/`apply` had no callers (the generalized
  `place.rs` replaced that path) and implemented the old parent-pointer model.
  Removed `pub mod stacks;` from `lib.rs`.
- **`place.rs`** — rewritten flat-root: `chain_root_of` (one hop), `collect_members`
  (single `micro_location` btree lookup), `next_branch_index` (append-to-end).
  `resolve_stack_target`/`resolve_loose_target` return `(surface, macro_zone,
  Micro)`. `place_card` applies the `Micro`; on a stack move, members re-root to
  the new root (loose move just re-stamps macro_zone). Removed
  `walk_branch_top`/`chain_root_id`/`collect_descendants`/`PLACE_WALK_DEPTH_CAP`.
- **`actions.rs`** — `propose_action` wire arg `micro_zone: u8` → `micro_location:
  u32`; `chain_stitch` writes flat members (`Micro::Stacked{root, branch,
  index=offset}`), root loose; verifier `.parent` guarded by `micro_is_card`
  (flat chains are depth-1), branch check via `stack_branch`. `loose_kind_for_surface`
  moved to `packed.rs`.
- **`action_completion.rs`** — `Effect::Create` → `Micro::snap(0,0,kind)`;
  `CreateDeferred` → `Micro::deferred(host)`, host-gone → loose (fail-to-loose).
  `.parent` walk guarded by `micro_is_card`.
- **`movement.rs`** — `TilePoint.micro_zone: u8` → `micro_location: u32`; per-step
  soul write `Micro::Loose` (loose-on-world, centered); `scrub` call passes
  `Micro::of(&soul)`; `anchor_covering_hex` call uses `(local_q, local_r)`.
- **`mini_zone.rs`** — `global_hex` takes `micro_location`; `anchor_covering_hex`
  takes `(local_q, local_r)`; `deploy_mini_zone` wire `target_micro_zone: u8` →
  `target_local_q/r: u8`; anchor write + spill + inventory-return via `Micro`.
  Deleted dead `tile_at_anchor`.
- **`recipe_eval.rs`** — `soul_stack` collapses to one `micro_location` btree
  lookup + filter branch + sort by `stack_index` (was an owner_id BFS).
- **`gc.rs`** — `resolve_tile_hex` flat (loose → own cell; member → root's cell,
  one hop).
- **`blueprints.rs`** — `request_blueprint` drops the `micro_zone: u8` wire arg;
  spawns loose from `micro_location`.
- **`players.rs`** / **`utilities.rs`** — soul / add_card spawns → `Micro`.
- **`world_gen.rs`** — doc only (no card-creation micro code).

### Wire-format changes (client must match in Phase 6)
- `propose_action`: `micro_zone: u8` → `micro_location: u32`.
- `move_soul_path` `TilePoint`: `micro_zone: u8` → `micro_location: u32`.
- `request_blueprint`: dropped `micro_zone: u8` (keeps `micro_location: u32`).
- `deploy_mini_zone`: `target_micro_zone: u8` → `target_local_q: u8, target_local_r: u8`.
- `Card` / `Soul` rows: `micro_zone` column removed.

### Resolved: deferred fallback-cell open question
Confirmed during `action_completion` conversion: **drop the baked fallback cell.**
A deferred row carries only the host id (`micro_location`); the client resolves
the concrete cell from the host's chain. If the host is already gone at commit,
the row is created loose (not deferred) — the fail-to-loose floor at creation.

### Cleanup
Removed unused imports (`LOOSE_HEX` in cards.rs, `action_completion` in
mini_zone.rs). Two pre-existing `_*_table` unused-import warnings are unrelated
to this refactor.

## Phase 5 — Client foundation — DONE

- **`packing.ts`** — removed `packMicroZone`/`unpackMicroZone`/`packStackMicroZone`/
  `unpackStackMicroZone`/`packSlotMicroZone`/`isStackLayout`. Added the
  `micro_location` loose layout (`packMicroLoose`/`unpackMicroLoose`/
  `microLooseCell`), the flag-bit constants (`MICRO_IS_CARD` bit 24,
  `stackState` 25-26, `stackIndex` 27-30, `ZONE_BORN` bit 13) + accessors
  (`microIsCard`/`stackState`/`stackIndex`/`zoneBorn`), the branch/loose
  constants (`STACK_DIR_*`, `STACK_STATE_DEFERRED`, `LOOSE_*`, `SNAP_*`),
  `looseKindForSurface`, and the client `Micro` type with `decodeMicro` /
  `applyMicro` (mirror of the server's `Micro::of` / `Micro::apply`). Stacking
  bits stay raw on the row (`microLocation` + `flagsBk`); accessors decode them
  inline (no decoded object on the row — bitwise on numbers is cheap, unlike
  the bigint `macroZone`). Bit positions hand-mirror `flags.json`.
- **`cardData.ts`** — rewritten to re-export the new helpers + keep the
  semantic `StackDirection`/`LooseXY` types, `STACK_DIRECTION_*` aliases,
  `MAX_CHAIN_DEPTH` (= u4 cap + 1), and `decodeLooseXY`/`encodeLooseXY` (now
  cell-(0,0) i12-offset compat wrappers for inventory pixel placement). Dropped
  the microZone-based `STACKED_*` / `getStackedState` / `getStackPosition` /
  `getStackDirection`.
- **`bindings/types.ts`** — `Card`/`Soul` auto-drop `microZone` (regenerated
  `GenCard` no longer has it); comment updated. Regenerated bindings confirmed:
  `cards_table`/`souls_table` → `microLocation` only; `propose_action` /
  `move_soul` `TilePoint` → `microLocation`; `request_blueprint` dropped its
  `microZone`; `deploy_mini_zone` → `targetLocalQ/targetLocalR`.

### Issue: `*/` inside a doc comment

`cardData.ts`'s rewritten header contained `LOOSE_*/SNAP_*`, whose `*/`
prematurely closed the block comment → 17 parse errors. Reworded to
`LOOSE_HEX/RECT, SNAP_HEX/RECT`.

### Decision: no decoded `micro` object on client rows

Unlike `macroZone` (a bigint, decoded into an object on the row), `micro` stays
raw (`microLocation: number` + `flagsBk: number`). Reason: bitwise on JS numbers
is cheap and correct (using `>>>`), so the per-row decode/object the bigint
needed isn't warranted. Readers call `decodeMicro(microLocation, flagsBk)` or
the individual accessors.

## Decision: inventory IS a world (full unification, 2026-05-28)

Inventory becomes an 8×8 **rect-cell grid** surface, not a pixel-xy bucket.
Cards on it are `Micro::Loose { local_q, local_r, x, y, kind: LOOSE_RECT }` — a
cell + within-cell offset (cell ≈ one 72×96 card rect, so i12 offset is harmless
overkill; no bit-layout change). Same `Micro`/placement code for world and
inventory; only cell shape (hex vs rect) differs for pixel layout. Removes the
inventory special-cases: `decodeLooseXY`/`encodeLooseXY` cell-0,0 wrappers, the
bucket-pixel branch in `RectCard`, the `INVENTORY_LAYER` xy path in `place.rs`.
Push-collision + tile-snapping shared across both views. **Full unification
chosen** (shared rendering/push/snapping), so `place.rs`'s inventory branch,
`dropResolver`, `RectCard.isHexGridSurface`→`isGridSurface`, and the inventory
view (`LayoutInventory`/`InventoryGame`) all fold toward the world grid.

## COMPLETE (2026-05-28) — verification green

The `micro_location` rewrite compiles and verifies end to end:
- `bin/st build shard` — green, bindings regenerated (`microLocation` everywhere;
  `microZone` gone; `deploy_mini_zone` → `targetLocalQ/R`; `request_blueprint`
  drops `microZone`).
- `bin/content test` — 73 pass.
- `pixijs` `tsc --noEmit` — **0 errors**.
- Cross-impl parity — client `packMicroLoose(lq,lr,x,y)` byte-equals server
  `pack_micro_loose` across signed extremes + bit-31 cells; client flag
  constants (`MICRO_IS_CARD` 24, `stackState` 25-26, `stackIndex` 27-30,
  `ZONE_BORN` 13) match `flags.json`.

### CardManager flat-root rewrite (66 → 0)

The model collapsed the parent-pointer machinery: **deleted** `spliceSlotMember`,
`spliceOnRootMember`, `renumberOnRootSuccessors`, `findSlotChild`,
`findOverflowTop`, `appendSlotSubChain`, `findChainLeafFor`,
`findFreeTileInMacroZone`, `chainRootRow`, `slot`, `flipChain`,
`repairBackPointers`. **Rewrote** `spliceCard` (member death = gap-tolerant
no-op; root death = `spliceRoot` promote), `buildChain` (members-of-root sorted
by `stackIndex`), `rootOf` (one hop), `setCardPosition` (build `Micro` →
`applyMicro`), `appendAtChainLeaf` (host-chain append → owner inventory →
fail-to-loose), `evictCard`, `stack` (re-root via `setCardPosition`). **Added**
`membersOf` / `findMemberAt` / `nextBranchIndex` / `rootRowOf`. `insertIntoSlotChain`
reworked to flat index-shuffle for `pos_need`/`pos_want`.

### DataManager mirrorCard flat-root (16 → 0)

`serverState` (0/1/2/3) → `decodeMicro` booleans (`isStackedMember` /
`isDeferred`). Preserve gate collapses to loose-vs-stacked; deferred
short-circuit via `appendAtChainLeaf`; orphan + preserve + `pos_need` splice +
`renumberAfterForcedStackPosition` all rebuilt on `applyMicro` / `findMemberAt`.

### Remaining follow-on: inventory-as-world RENDERING convergence

The **data model** is unified (inventory cards are `Micro::Loose` at
cell+offset, `LOOSE_RECT`; same placement path as world). NOT yet done: the
**rendering/interaction** convergence — `RectCard.isHexGridSurface` still
excludes inventory, so inventory still renders via its pixel-offset branch
(cell (0,0) + offset, i.e. the old visual preserved through the new data
model) rather than the shared world-grid cell rendering + push-collision +
tile-snapping. That convergence (`LayoutInventory`/`InventoryGame` ↔ the world
grid view) is a self-contained rendering refactor that doesn't affect the
`micro_location` compile/correctness; it's the piece left of "full unification."

#### Multi-viewport effort (2026-05-28) — separate phased plan

Inventory-as-world raised the broader goal: **multiple `GameViewPanel`s live at
once**, up to **split-screen of the SAME region** (user's chosen scope). Full
plan in `~/.claude/plans/typed-swinging-tulip.md`. Approach: **per-view card
instances** (one `Card` model → N per-panel `CardView`s), NOT cameras/RT — both
design passes rejected cameras (would rewrite input/hit-test + drop retained
render). Most infra is already multi-instance-safe (anchors by name, tier union,
zone refcount, PanelManager, per-panel input via `findLayoutWorldInChain`).

- **Phase A — DONE (tsc green).** De-singletoned the per-view ctx hooks. Removed
  `ctx.worldOverlay/worldHexAt/onTilesChanged` (`GameContext` + `main.ts` init +
  `LayoutWorld` ctor assignments/destroy clears). New `WorldViewServices`
  interface (`game/world/WorldViewServices.ts`) with `findWorldView(node)` — a
  branded parent-chain walk (no `LayoutWorld` value-import → no cycle).
  `LayoutWorld implements WorldViewProvider` (brand `isWorldView`, `worldHexAt`,
  `makeObjectOverlayForTile`, new `onTilesChanged` method). `LayoutCard` gained a
  `worldView` getter (lazy chain-walk, **cached so it survives a drag** when the
  card is in the overlay). `WorldObjectOverlay` takes a `getServices` getter and
  rebinds its tile-change sub per-view (`syncTileSub`). `RectCard`/`HexCard` pass
  `() => this.worldView` + read `this.worldView?.worldHexAt`. `MainScene` click
  uses `hit.worldHexAt`. `DragManager.resolveGhostWorldDrop` uses
  `findLayoutWorldInChain` gated by `surface >= WORLD_LAYER` (excludes a
  `RectGrid` inventory view). Single-view behavior identical (the one view
  resolves the same as the old singleton). `ctx.layout.worldView` left in place
  (now effectively unused; removal is optional).
- **Phase B — DONE (tsc green).** `LayoutManager.surfaces` is now
  `Map<ZoneId, Set<LayoutNode>>`. `register(zoneId, surface)` adds;
  `unregister(zoneId, surface)` removes that surface (signature change — updated
  the 2 `LayoutWorld` sites + `InventoryLayout`). Added `surfacesFor` +
  `onUnregister`; `surfaceFor` kept as a first-wins shim. Dropped the overwrite
  warn (so `debug` import removed). Set-of-one ⇒ single-panel identical.
- **Phase C — DONE (tsc green).** Model/view split, set-of-one. New
  `game/cards/CardView.ts` owns the `LayoutCard` + the surface-dependent ops:
  `attachToCurrent`, `reparentSmoothly`, `reparentToModel`, the visual half of
  `setDragging`, `applyData`, `destroy` — all taking model `(parentId,
  direction, zoneId)` as args. `Card` now holds `readonly view: CardView` (+ a
  `get layoutCard()` shim for the 7 external readers), keeps all model state
  (position decode, `stacked*` back-pointers, `gameCard`), and delegates. The
  `onDataChange` split: model-half stays (orphan check, zone-bucket move,
  back-pointers, `fireStackChange`) and calls `view.reparentToModel(...)` +
  `view.applyData(row)`; `gameCard.applyData` runs once. Deleted Card's
  `attachToCurrent`/`reparentSmoothly` (moved to CardView). Behavior identical
  for one view.
- Phase D (views map + lifecycle + N panels, per-view parent-host resolution,
  death-anim guard, `gameview:<id>` opener) **deferred** — only needed for
  same-region split-screen (one card in two panels). The inventory second view
  is a *distinct surface* (1 vs 64), so each card lives in exactly one view at a
  time; A/B/C suffice.

#### Inventory second view + test seed (2026-05-28) — DONE (server + tsc green)

Goal: render a human soul at world (0,0) and show its inventory (surface 1,
owner = human card_id) as a second view, seeded with a dust. Ownership chain
Player → player_soul → human → dust (via the `owner_id` walk: dust.owner_id =
human card_id, human.owner_id = player_soul card_id).

- **Server** (`players.rs::spawn_soul_for`): after the player_soul, seed a
  `find_packed_by_key("human")` soul at `pack_macro_zone_full(0, WORLD_LAYER, 0,
  0)` / `Micro::snap(0,0, LOOSE_HEX)` / owner_id = player_soul card_id (+ a
  `SoulPrivate` row, mirroring player_soul), and a `find_packed_by_key("dust")`
  at `pack_macro_zone_full(human_id, INVENTORY_LAYER, 0, 0)` / `LOOSE_RECT` /
  owner_id = human_id. Dev seed (runs per new signup) — `bin/st build shard`
  green, bindings regenerated. **Needs a fresh signup / DB wipe to appear.**
- **Client** (`MainScene` left-click): re-enabled click-to-open inventory —
  clicking a card whose def carries the `inventory` aspect opens
  `openInventoryPanel(cardId)` (the existing `InventoryPanel`/`LayoutInventory`,
  surface 1, `ensureInventory(cardId)`). Click the human at (0,0) → its
  inventory opens, dust renders.
- **Deliberately used the existing `InventoryPanel`, NOT a `RectGrid`
  `LayoutWorld` viewport.** A LayoutWorld inventory viewport still bakes
  **hex-shaped** fallback tiles (`buildTile` → `cardTextures.getHex`) regardless
  of grid, so a rect grid would render hex chrome — the terrain/tile-shape axis
  of "generalize world" isn't done yet. Full inventory-as-LayoutWorld
  convergence (tile-less or rect-tile rendering) remains the follow-on.

#### Inventory-as-LayoutWorld convergence (2026-05-29) — DONE (tsc green)

The full "generalize world" payoff: inventory is now a terrain-less `RectGrid`
`LayoutWorld` viewport — the same grid view as the world, pointed at the
bucket's `(surface, owner)` zone. Bespoke `LayoutInventory` + `GameInventory`
**deleted**. Five steps:

1. **Terrain-optional `LayoutWorld`** — ctor `opts.renderTerrain` (default
   true). When false: skip tile hydration + the tile-card/zone subscriptions
   (early-return in the ctor) + the per-cell tile build (early-return in
   `layout()` after bg + card-surface positioning). Fixes the hex-fallback-tile
   blocker — a terrain-less view draws no tiles, just cards. Also added
   `opts.origin: "center" | "topleft"` (`originPixel()` drives `worldToLocal`/
   `localToWorld`): inventory uses `topleft` so the fixed grid fills
   down-and-right; world stays `center` (pannable). World path untouched
   (defaults preserve it).
2. **Panel hosts the viewport** — `InventoryPanel` builds a
   `new LayoutWorld(ctx, layout, "inventory-view:<surf>:<owner>", surface,
   new RectGrid(GRID_W, GRID_H), { renderTerrain:false, origin:"topleft",
   gridChrome:true })` instead of `LayoutInventory`. No `WorldPanManager` ⇒ the
   `viewport:` anchor never moves (fixed). `ensureInventory(owner)` is called
   **before** the ctor so the zone is already `active` when the ctor registers
   its card surface. Cards render via `RectCard`'s loose branch → new
   `WorldViewServices.cellToPixel(localQ, localR)` (the owning view's grid),
   centred per cell; falls back to raw pixel if no grid view owns the card.
3. **Grid chrome + bounded extent** — `LayoutWorld.gridOverlay` draws faint
   rect-cell boundary lines in `drawGridChrome()` (terrain-off path), bounded to
   8 cells/axis (the `localQ/localR` 3-bit field width). `showGrid(bool)`
   brightens on E-key (replaces `LayoutInventory.showGrid`).
4. **Cell occupancy** — new `game/inventory/GridInventory.ts` replaces
   `GameInventory`'s continuous overlap-push with **one-card-per-cell**: each
   loose root keeps its in-bounds cell if free, else raster-scans for the next
   free one, via the new `CardPositionState` `"cell"` (sets `micro.localQ/R`,
   zero offset). Dragging roots pin their cell so others route around. Ticked by
   `MainManager` like the old `GameInventory`.
5. **Deleted** `InventoryLayout.ts` + `InventoryGame.ts`. Fixed the two code
   consumers: `dropResolver.resolveInventoryDropTarget` now finds the owning
   `InventoryPanel` (via `findPanelByDescendant`) for the bucket's owner+surface
   instead of a `LayoutInventory` node, and `isDroppableHit` drops its
   `LayoutInventory` branch (the `LayoutWorld` branch covers inventory now);
   `MainManager` retyped to `GridInventory`.

**Fix (2026-05-29): in-inventory drag deleted the card.** Because inventory is
now a `LayoutWorld`, the drop resolver's step-2 `resolveWorldDropCoords`
(`findLayoutWorldInChain`) matched the *inventory* view and resolved an
in-inventory drop as a **world-tile** drop → `setCardPosition({kind:"world"})`
rewrote `macro_zone` to **owner 0** (`makeMacroZone(0, surface, …)`), yanking the
card out of its `owner=<soul>` inventory zone so the view (subscribed to the soul
zone) dropped it. Fixes: (a) gate `resolveWorldDropCoords` **and**
`DragManager.handleBlueprintDrop` to `isHexGridSurface(view.surface)` (now
exported from `RectCard`) — a rect-grid inventory view falls through to the
inventory path; (b) new `DropIntent` `"cell"` + `CardPositionState` `"cell"`:
an in-inventory drop now repositions to the *targeted* rect cell
(`localToWorld` → clamp 0..7 → local `setCardPosition`), and `GridInventory`
resolves any collision. (`resolveGhostWorldDrop` was already gated
`surface < WORLD_LAYER`.)

**Correction (2026-05-29): resolve drops to the viewport OWNER, not a
hardcoded 0 — and the surface-gate was the wrong fix.** The real bug:
`buildPlacement`/`setCardPosition`/`findCardAtTile` `"world"` cases hardcoded
`makeMacroZone(**0**, surface, …)`. A drop into *any* non-world viewport thus
wrote owner 0, yanking the card out of its `owner=<soul>` bucket. The
grid-type/surface gate I'd added was a band-aid that happened to work only
because inventory's *surface* (1) isn't a hex-grid surface — it would still
break a hex-grid viewport owned by a non-zero card. Proper fix (a viewport is
`(owner, surface)`, grid shape is pure rendering):
- `LayoutWorld` gained `owner` (default 0) + `singleChunk` (clamp cells to chunk
  (0,0) for a one-zone bucket). World = owner 0, multi-chunk; inventory =
  owner=soul, single-chunk.
- `resolveWorldDropCoords` returns the viewport's `owner` (+ clamps for
  `singleChunk`); **gate removed** — it matches *any* viewport now.
- `DropIntent "world"` + `CardPositionState "world"` carry `owner`;
  `buildPlacement`/`setCardPosition`/`findCardAtTile`/`shouldSyncPlacement` use
  it (sync fires on owner OR surface change).
- **Deleted the inventory drop special-case** (`resolveInventoryDropTarget`) and
  the `"cell"` *drop intent* — the owner-resolved `"world"` path handles
  in-inventory rearrange (same owner+surface → local) and world→inventory
  (owner/surface change → server `placeCard`) uniformly. (`"cell"`
  `CardPositionState` stays — `GridInventory` uses it.)
- **Inventory switched to a `HexGrid`** (`InventoryPanel`) to prove the toggle:
  it behaves identically (drops resolve to owner, cards land on hex cells).
  `GridInventory` now takes the grid's cell footprint so occupancy bounds match
  any grid. Grid chrome still draws *rect* lines (cosmetic; doesn't match hex
  spacing — a known polish gap). Toggle back to `RectGrid` is a one-liner.
- Remaining `makeMacroZone(0, …)` sites (ghost/soul movement, blueprints,
  pathfinding) are legitimately world-only; the same fix extends to them if an
  owned hex viewport ever needs soul/blueprint placement.

**Generalize the grid: tiles derived from zone data, shaped per grid
(2026-05-29) — DONE (tsc + shard build green).** The inventory grid is no
longer bespoke chrome — its cells are "empty" tile cards in the inventory zone,
rendered by the SAME tile pipeline the world uses for hex tiles, just
rect-shaped because the viewport is a rect grid.
- `CellGrid` gained `shape: "hex" | "rect"` (`HexGrid`/`RectGrid`).
- `CardTextureManager.getRectTile(def, bodyTexture)` — the rect analogue of
  `getHex` (body-only rect, `style[0]` fill or `bodyTexture`, visible outline).
- `LayoutWorld.buildTile` picks `getRectTile` vs `getHex` by `grid.shape`.
- **Reverted the terrain-less hack**: inventory is now `renderTerrain: true`
  (default) — it renders the seeded empty tiles. Removed the `gridChrome`
  machinery (`gridOverlay`, `drawGridChrome`, `showGrid`, the opt) — the tiles
  ARE the grid now. `InventoryPanel.showGrid` is a no-op.
- **Bounded extent**: `singleChunk` viewports clamp `activeRectKeys` to cells
  0..7 (one chunk) so off-chunk cells aren't fallback-rendered.
- **Server** (`players.rs::spawn_soul_for`): back the human's inventory with a
  single **Zone row** (`zones::create_rect_at` — the dense rect-grid sibling of
  `create_disk_at`) instead of 64 empty tile cards. ~153 B vs ~2560 B; the 8×8
  grid is seeded with the `"empty"` tile def. The client renders the cells from
  the Zone (`decodeZoneTiles` → `tileData` → `buildTile`, same path as world
  hexes, just rect), and tile-cards spawn on demand via
  `find_or_create_tile_card` only when a recipe touches a cell — exactly the
  world model. The dust renders on top via `GridInventory`.

Caveats / not runtime-verified: empty fill (#0b1426) == backdrop, so cells read
via their outline. Check: open the human's inventory → an 8×8 (visible-subset)
rect grid of outlined cells, dust at top-left, drag dust between cells.

#### Viewport unification — one `ViewportPanel` (2026-05-29) — DONE (tsc green)

Collapsed `GameViewPanel` + `InventoryPanel` into a single flag-driven
`game/viewport/ViewportPanel.ts` — world and inventory are two configs of
`{ grid, surface, owner, viewer, pan, occupancy, follow, origin, singleChunk }`.
No `if (inventory)`. Three phases:

1. **Pan on any grid.** `LayoutWorld.pixelDeltaToCell(dx,dy)` exposes
   `grid.pixelToCellFractional`; `WorldPanManager` (hex math was *identical* to
   that) → renamed `PanController`, moved to `viewport/` (common), now
   grid-agnostic. HexGrid math byte-identical → world pan unchanged.
2. **Owner-aware anchors.** `WorldAnchor` gained `owner`; `setAnchor(name, q, r,
   surface, owner=0)`; `recomputeAnchorZones` packs `makeMacroZone(owner, …)`
   (was hardcoded `0`). `PanController` carries `owner` → panned viewport
   subscribes ITS owner's chunks. World (owner 0) unchanged. `subscribeWorldZone`
   already does `cards WHERE macro_zone = key`, so the inventory's dust + tiles
   load via the anchor — `ensureInventory` is now only the panel-less background
   sub (`SoulManager`).
3. **Collapse.** New `ViewportPanel` owns the shared spine + wires flag-gated
   bits: `pan`→`PanController`, `occupancy`→`GridInventory`, `viewer`→soul
   subscriptions + focus-activate + (`follow`) recenter. Deleted
   `hex/GameViewPanel.ts` + `rect/InventoryPanel.ts`; `MainLayout` openers
   collapsed to `openViewport` + thin wrappers (`openWorldView(viewer)` /
   `openInventoryPanel(owner)` / `openGameViewPanel`=alias /
   `openPlayerInventoryPanel`), keyed `viewport:<surface>:<owner>`. `MainScene`
   handlers + tick unified on `focused("viewport")` / `instanceof ViewportPanel`.
   **Dropped `ctx.layout.worldView`** (orphaned).

The **viewer** is now a first-class field (perspective soul, distinct from zone
`owner`); permission-gated visibility (ally/enemy) is the future layer it'll
read. Follow-ons: that permission layer; multi-chunk unbounded inventory boards;
removing now-dead `LayoutWorld.setSurface`/`PanController.setSurface` (the old
`focusAt` soul-jump was their only caller). Inventories pan now (`pan:true`,
`singleChunk` — scroll the 8×8 in a small window). Not runtime-verified.

**Panning** is per-viewport opt-in, not baked into `LayoutWorld` — it comes from
a `WorldPanManager` the panel wires to its view. The world panel wires one; the
inventory panel deliberately doesn't (a fixed 8×8 grid). To give inventory pan,
construct + wire a `WorldPanManager(ctx, layoutWorld, anchorName, surface)` in
`InventoryPanel` (and the LayoutWorld would pan via its anchor).

**Not runtime-verified** (no game run available): check the human's dust renders
top-left in its inventory; cards snap one-per-cell; grid lines show + brighten
on E; drag a card into/within inventory. **Known behaviour change:** inventory
went from free-pixel + push to cell-occupancy (top-left fill); a card dropped in
lands in the first free cell, not exactly under the cursor (drop-to-pointed-cell
is a refinement). AGENTS.md notes under `game/inventory`, `scenes/main`, and
`src/` still reference the deleted classes — stale, update later.

#### Step A — generalize the world view (2026-05-28) — DONE (tsc green)

Plan agreed: generalize `LayoutWorld` into a grid-shape-agnostic viewport
*before* removing the bespoke inventory view, so inventory becomes a second
`LayoutWorld` instance pointed at a different `(surface, macro_zone)` with a
rect grid. Discovery up front: the *data/subscription layer is already
unified* — inventory cards are just cards-in-a-zone (`CardManager.byZone`,
`SubscriptionManager.subscribeCards`, `SoulManager` refcount), and the
constructor was *already* parameterized on `surface` + `viewportAnchorName`
and multi-instance-safe (the mini-zone view is already a second `LayoutWorld`).
So only the **view** + the push logic are bespoke.

What changed (all in `pixijs/src/game/world/`):
- **New `CellGrid.ts`** — `interface CellGrid` (cellWidth/Height,
  `cellToPixel`, `pixelToCellFractional`, `roundCell`, `cellsInViewport`) with
  `HexGrid` (pointy-top axial; math lifted verbatim from `LayoutWorld`) and
  `RectGrid` (square cells; cell (0,0) at origin, mirroring hex so the shared
  viewport math is identical).
- **`LayoutWorld`** now holds `private readonly grid: CellGrid`, injected via a
  new last constructor arg `grid` (defaults to `new HexGrid(WORLD_HEX_RADIUS)`).
  The four coordinate methods (`worldToLocal` / `localToWorld` / `worldPixel` /
  `worldHexAt`) and `activeRectKeys` delegate to it; tile-body sizing /
  positioning / LOD-texture-size route through `grid.cellWidth/cellHeight`.
- **Left hex-specific on purpose:** object overlays, debug hex rings, neighbor
  fan-out math — world terrain decoration inventory won't use.

Verified behaviour-identical for world: `HexGrid.cellWidth == WORLD_HEX_WIDTH`,
`cellHeight == WORLD_HEX_HEIGHT`; `cellsInViewport` is the old `activeRectKeys`
body verbatim. Sole caller `GameViewPanel` passes 4 args → grid defaults to hex.
`tsc --noEmit` green; no server/content changes.

Still to do for the inventory viewport (next steps, deliberately not started —
user gated "generalize world first"): (1) a `RectGrid` `LayoutWorld` instance +
its grid chrome / bounded extent; (2) `macro_zone`-owner scoping (an inventory
bucket is one soul's zone, not all zones on a surface); (3) fold
`InventoryGame` push/snap into cell-occupancy on the shared grid; (4)
`RectCard` layout to branch on `stack_state` kind, not `surface`; (5) delete
the bespoke `LayoutInventory`/`InventoryGame`.

## Phase 6 — Client logic rework — DONE (history below)

tsc-driven; **client does not compile yet.** Count went 156 → 137 after the two
layout cards. Done:
- **`HexCard.ts` / `RectCard.ts`** — `GameHexCard`/`GameRectCard` cache
  `isMember` (was `stackedState`); `isLoose()` = `!microIsCard`; layout reads
  `decodeMicro` (loose → cell or pixel offset; stacked → parent to the chain
  ROOT with an `index`-scaled title-bar offset, flat — no parent-pointer
  Pixi chain; deferred → chunk-origin fallback render).

### Card.ts — DONE (137 → 118)

`stackParentOf` now returns the chain **root** (flat-root: members parent to the
root's stack host, offset by `stackIndex` in RectCard layout — no per-card
predecessor lookup). `stackDirectionOf` via `directionForBranch(stackState)`.
`currentMicroZone` field → `currentMicroLocation`; tile-move detection fires on
`!microIsCard && surface ≥ WORLD && microLocation changed`. `onDataChange`'s
unconditional `applyData` re-renders re-index moves, so no extra trigger needed.

### Structural decisions for the CardManager/DataManager chain rewrite (next)

The flat-root model **collapses** most of the parent-pointer splice machinery:

- **Splice on death:** a dying MEMBER leaves a gap — gap-tolerant, **no-op**. A
  dying ROOT promotes a member to new root + re-roots the rest (the only splice
  that survives, ≈ old `spliceLooseRoot`). DELETE `spliceSlotMember`,
  `spliceOnRootMember`, `renumberOnRootSuccessors`.
- **`byRoot` index:** add `Map<rootId, Set<Card>>` maintained like `byZone`;
  `buildChain(root, dir)` = filter members + sort by `stackIndex`; `rootOf` =
  `decodeMicro(...).root` (one hop).
- **`findSlotChild`/`findSlotOccupant`** → `findMemberAt(root, branch, index)`.
- **`insertIntoSlotChain`/`findOverflowTop`/`renumberAfterForcedStackPosition`
  (pos_need/pos_want splice in DataManager):** in flat-root the server sends an
  explicit `(root, branch, index)` + pos_need; the client honors it (incoming
  wins the slot; a colliding local card is bumped to the next free index, or the
  collision is tolerated). Much of the parent-pointer splice logic deletes.
- **`setCardPosition`:** build a `Micro` and write `microLocation` + `flagsBk`
  via `applyMicro`.
- **`appendAtChainLeaf` (deferred cascade):** target+1 → full-range scan →
  fail-to-loose, per the design.
- **`evictCard`:** `Micro::Loose`/inventory placement.

### Remaining (118 errors), in dependency order

The three deep, interdependent files are the core (the client mirror of the
flat-root model — gap-tolerant, fail-to-loose, `byRoot` index):
- [ ] **`Card.ts` (19)** — `stackParentOf` returns the chain ROOT (not the
  immediate parent); `stackDirectionOf` via `stackState`; back-pointer system
  (`stackedTop/Bottom/Hex`, `attachToCurrent`, `repairParenting`) reworked so
  members parent to the root's stack host; `onDataChange` tile/stack-change
  detection via `decodeMicro`.
- [ ] **`CardManager.ts` (66)** — the big one. `byZone`→keep; add `byRoot`
  index (`Map<rootId, Set<Card>>`, maintained like `byZone`). Rewrite:
  `buildChain` (filter members of root by branch, sort by `stackIndex`),
  `spliceLooseRoot`/`spliceSlotMember`/`spliceOnRootMember` → flat gap-tolerant
  (a deleted member leaves a hole; only a dying ROOT needs a promote),
  `insertIntoSlotChain`/`renumberAfterForcedStackPosition` → claim-free-index,
  `appendAtChainLeaf` (deferred cascade: target+1 → full-range scan →
  fail-to-loose), `setCardPosition` (build `Micro`, write `microLocation` +
  `flagsBk` via `applyMicro`), `rootOf`/`chainRootRow`/`findFreeTileInMacroZone`,
  `evictCard`. `PlacementTarget` stays.
- [ ] **`DataManager.ts` (16)** — `mirrorCard` preserve logic: the LOOSE / SLOT
  / ON_ROOT / DEFERRED branches collapse to loose-vs-stacked (`micro_is_card`);
  the `pos_need`/`pos_want` splice + orphan-slot fallback rebuilt on flat-root;
  state-3 short-circuit via `decodeMicro`.

Mechanical reader updates (`getStackedState(microZone)` → `microIsCard`/
`stackState(flagsBk)`; `unpackMicroZone(microZone)` → `microLooseCell(
microLocation)`; wire args → `microLocation`):
- [ ] `ActionManager.ts` (11) — root-state checks (`!microIsCard`), hex-address
  reads (`microLooseCell`), binding capture shape.
- [ ] `InventoryGame.ts` (5) — `findRootCard` flat walk.
- [ ] `LayoutWorld.ts` (4), `pathfind.ts` (3), `DragManager.ts` (3),
  `GameViewPanel.ts` (2), `dropResolver.ts` (2), `DetailsPanel.ts` (2),
  `ReducerManager.ts` (2 — `proposeAction`/`moveSoul` path args:
  `microZone`→`microLocation`), `MainScene.ts` (1),
  `LifecycleResolutionManager.ts` (1).

## Phase 3 (original checklist superseded above)

Not yet started. The server will **not compile** until these are done (the
`micro_zone` field and the old `packed.rs` helpers are gone; `create`/`create_at`/
`scrub` signatures changed). Compiler-driven from here — `bin/st build shard`
enumerates every site. Files to convert, each following the `Micro` pattern and
**flat-root (no parent pointers)** model:

- [ ] `stacks.rs` — `apply()` builds rows from the wire `CardStack`; bottom card
  loose, each above as `Micro::Stacked{root, branch, index}` (index = position
  in branch; was parent-pointer `Slot`).
- [ ] `place.rs` — `resolve_stack_target` / `walk_branch_top` / `chain_root_id`
  / `collect_descendants`: parent-walk → root-filter
  (`micro_location().filter(root)` + `micro_is_card` + branch + sort by
  `stack_index`). `resolve_loose_target` → `Micro::Loose`/`snap`/`Stacked`.
- [ ] `actions.rs` — `chain_stitch` root + child writes → `Micro` (flat
  root+index), keep `pos_need`.
- [ ] `action_completion.rs` — `Effect::Create` / `CreateDeferred` →
  `Micro::deferred(host)` (was `pack_micro_zone(q,r,Deferred)` +
  `micro_location=host`). The deferred fallback `(q,r)` previously lived in
  `micro_zone`; now there is no micro_zone — decide where the fallback cell goes
  (likely: deferred carries host in `micro_location`; the client resolves cell
  from the host, no separate fallback needed — confirm against client
  `appendAtChainLeaf`).
- [ ] `movement.rs` — `move_soul` per-step: `Micro::Loose` (loose-on-world);
  `scrub_or_repath_position_forward` call drops the `micro_zone` arg.
- [ ] `mini_zone.rs` — anchor deploy/undeploy: `Micro::snap`/`Loose` for the
  world card; reads of anchor cell via `Micro::of`.
- [ ] `world_gen.rs` — tile promotion placement → `Micro::snap(q,r,SNAP_HEX)` +
  `zone_born`.
- [ ] `gc.rs` — chain-root walk for loose tile coords → root-filter + `Micro::of`.
- [ ] `recipe_eval.rs` — `soul_stack` iterator chain walk → root-filter.
- [ ] `utilities.rs` — spawn-default placements → `Micro::snap`/`Loose`.
- [ ] `blueprints.rs` — blueprint spawn placement → `Micro`.
- [ ] `players.rs` — player-soul spawn placement → `Micro::Loose`.
- [ ] `zones.rs` — verify (may only appear via broad grep; check for micro refs).

### Open question for Phase 3 (deferred fallback cell)

Old deferred rows stored a fallback `(q,r)` in `micro_zone`'s upper 6 bits while
`micro_location` held the host id. With `micro_zone` gone and `micro_location`
holding the host id, there's no room for a fallback cell on a deferred row.
**Tentative resolution:** the client deferred cascade resolves the cell from the
host's chain/position, so the explicit fallback cell is redundant — drop it.
Confirm when converting `action_completion.rs` against the client
`appendAtChainLeaf` (Phase 6). If a fallback cell is still wanted, it can ride
in the loose layout's `x`/`y` of a separate field or be re-derived. Documented
so the decision is deliberate.
