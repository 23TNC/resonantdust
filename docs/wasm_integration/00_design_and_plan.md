# Wiring the wasm DSL runtime into gate, client & modules — design & phased plan

Status: **planning** (started 2026-06-03). The DSL runtime (`resonantdust-data`,
parser→validate→resolve→VM, Phase 1–3 complete) is built and tested but not yet
*called* by the live game. The legacy JSON content crate
(`pixijs/src/content`, `resonantdust_content`) is still the authority for all
three consumers. This plan migrates each consumer onto the DSL runtime, then
decommissions the legacy crate. Legacy and new coexist until each consumer flips
— nothing breaks mid-migration.

Related memory: data is disposable pre-release (id renumbers / schema reshapes
are free); the bit-packing and client matcher are load-bearing wire-byte
optimizations and must be *ported*, not stripped.

---

## 0. Current state (verified 2026-06-03)

- **Runtime** (`shared/data` = `resonantdust-data`, rlib; wrapped by `shared/` =
  `resonantdust-shared`, cdylib for the browser):
  - `Content` exposes `card_def_id` / `card_view` / `match_recipe` / `plan_recipe`.
  - `match_recipe`/`plan_recipe` take **no host table** — only the lower-level
    `vm::run` does. So `@init`/`@update` (which consume `^biome`/`^seed`) have
    **no public entry point**.
  - No worldgen/biome/climate surface at all.
  - `resolve.rs` defers `shape`/`faction`/`type` to the legacy JSON registries.
- **Gate** (`gateway`): already links `resonantdust-data`, already reads every
  `.rd` at startup (`gateway/src/content.rs::load_bundle`) and stores the
  `Bundle` in `Pool` — but **never calls it**. propose/validate/apply still run
  the legacy planner (`recipe_core` / `recipe_validate` / `recipe_plan`).
- **Regions module** (`spacetime/server/modules/regions`): owns worldgen
  (`world_gen.rs`), server-authoritative, on legacy `biome_core` /
  `cards_of_type` / `decode_definition`. Embeds JSON via its content dep's
  `build.rs`.
- **Client** (`pixijs`): new wasm bundle (`shared/pkg`) built but imported nowhere.
  Bootstrap, `recipeMatcher.ts`, `LayoutWorld.buildTile` all on the legacy
  `resonantdust_content` wasm. No `.rd` loader for the browser.
- **Climate noise**: FBM samplers live only in `regions/world_gen.rs` — native,
  server-only.

---

## 1. Decisions (locked)

| # | Decision | Resolution |
|---|----------|------------|
| **D1** | def_id authority | **Bundle is authority; delete legacy `id.json`.** Keep the wire format `[type:u4 \| def_id:u12]`. Derive `type` from each card's declared `aspect.type` (tiles already `tile &aspect.type set`), map to the nibble; assign per-type 1-based def_ids. No translation layer, no routing change. |
| **D2** | `^biome` cell contract | Host provides `Map{ rarity, elevation, temperature, humidity, aether }`, all **0–100 ints** (host scales the `f32 [0,1)` noise). `rarity` is a **new 5th noise channel** (own seed offset) quantised to tiers. `^seed` → the cell's deterministic seed. |
| **D3** | climate-noise location | **In `resonantdust-data`** (`noise`/`biome` module) — gate, client, and the regions module all link it. Port `fbm`/`value_noise`/`sample_*` out of `world_gen.rs` so output is bit-identical. |
| **D4** | stock bit budget | **Cap tiles at 2 dynamic stocks for now**; keep the Zone 2×2-bit layout (the bulk-bandwidth path, 64 tiles/zone). **Re-assess widening the Zone after the refactor is complete.** |
| **D5** | tile-pick model | **Simple model — biome → single default tile (`&tile.0`) → tile `@init` stock.** Legacy's rarity-weighted multi-candidate selection and cluster bias are **intentionally cut** (like other recovered-snapshot cut features), not ported. `rarity` stays a `^biome` channel because tile `@init` reads it for stock tiers. |

### D4 content constraint

`content/data/cards/tiles.rd` `forest` currently declares **3** dynamic stocks
(`pine`, `flora`, `stone`). Under D4, one must become **static or derived** so
each tile def has ≤2 `stock`-declared aspects. Recommended: keep `pine` + `flora`
dynamic (humidity-driven), make `stone` a static/derived aspect. Audit every
tile def for the ≤2 rule when porting.

---

## 2. Phases

### Phase 1 — Shared runtime surface in `shared/data` (serial unblocker) — **DONE 2026-06-03**

Landed: `noise.rs` (ported FBM + rarity channel, bit-for-bit parity lock vs
legacy), `worldgen.rs` (`biome_host` / `select_biome` / `generate_tile`),
`loader.rs` biome indexing + `card_type` / `type_def_id` / `packed_def` (D1),
`bits.rs` `pack_def` / `pack_tile_slot` codec, and `Content::generate_tile` /
`packed_def` + `generateTile` / `packedDef` wasm bindings. 68 tests pass; wasm
bundle builds; real corpus loads clean (44 cards, biomes indexed).

Notes vs the original plan:
- **1.1 host-fed entry**: the host-fed `@init` path is exercised through
  `worldgen::tile_stock` (runs `:data @define` then `@init` with the `^biome`
  host). No separate generic `Content::run_hook` was added — defer until a
  consumer (client visuals / prediction) needs it.
- **1.8 parity reframed by D5**: a byte-match against legacy `pick_tile` is
  *not* a goal — the DSL is a deliberately simpler model. Parity is pinned at
  the **noise layer** (`matches_legacy_noise_bit_for_bit`), plus determinism,
  Zone-budget, and biome-envelope sanity. The climate *field* is identical to
  the live server's; tile selection intentionally differs (no rarity/cluster).
- **D4 enforcement**: the ≤2-stock cap is applied at the pack site
  (`generate_tile` reads the first two stock-schema slots), exactly like legacy
  `pick_stocks_for`. No `tiles.rd` edits — `desert`/`mountain`/`forest` keep
  their extra stock declarations for full card instances; the Zone fast-path
  carries two.

Original task list (all complete):

1. **Host-fed execution entry** — public `Content::run_hook(def, facet, hook, host)`
   (and/or `init_card(def, host)`) wrapping `vm::run`. Keystone.
2. **Noise module** (D3) — port FBM + the climate samplers, add the `rarity`
   channel. Deterministic across native + wasm targets.
3. **`^biome`/`^seed` provider** (D2) — `biome_host(global_q, global_r, world_seed)
   -> Vec<(String, Cell)>`.
4. **Biome selection** — walk `<biome>` `@define` envelopes, first `within` match
   → `&tile.0`. Analogue of legacy `biome_for_climate`.
5. **Worldgen surface** — `Content::generate_tile(q, r, seed) -> (packed_def: u16,
   stock: [u8; 2])`: select biome → pick tile def → run its `@init` with the
   biome host → read stock cells → quantise to the Zone budget (D4).
6. **def_id/type + packing** (D1) — Bundle reads `aspect.type` per card, assigns
   per-type 1-based ids, exposes `packed_def(name) -> u16`; port the
   `[type|def_id|stock]` codec from `resonantdust_content::packed` into `bits.rs`
   so it is shared.
7. **wasm-bindgen wrappers** for the client (`generateTile`, `runHook`, `packedDef`).
8. **Verification gate:**
   - corpus determinism test;
   - **parity test**: new `generate_tile` matches legacy `world_gen::pick_tile`
     for a sample of cells (proves the port before any cutover);
   - gate↔client identical-climate test.

### Phase 2 — Gate cutover — **CODE COMPLETE 2026-06-03 (needs live verify)**

Landed in `resonantdust-data`: `recipe.rs` — `iterators()` (enumerates slot
iterators identically to legacy `recipe_tape`, so `bindings[iterator_id][offset]`
aligns with the client; tested vs the `recipe_tape` cases) and `build_frame()` /
`Frame` (assembles the operating-set `Store` from positional bindings, nests
owner re-anchors, drops the synthetic tile at the `slot.0.0` sentinel, records a
`slot-path → card_id` map). Plus `bridge::stock_slot_for_aspect` (sub-aspect
widening). 73 data-crate tests pass.

Landed in the gate: `dsl_recipe.rs` translates `vm::Plan` → the **legacy
`ActionPlan`** so `apply.rs` is **untouched**. `propose.rs` now does
`validate_bindings` (state checks, legacy) → `dsl_recipe::run` (build frame →
`match_recipe`/`plan_recipe` → translate). `validation.rs` trimmed to the
`CardStore` adapter. Gateway builds clean (`bin/gate build`).

The name-join bridge: stored rows carry legacy `packed_definition`; the gate
decodes to a card **name** (`decode_definition().key`) and re-ids against the
DSL `Bundle`. No stored-data change until Phase 3.

**NOT yet verified behaviorally** — needs a live run (gate + cards/regions/players
modules + a client action under `RD_ENV=claude`). Specific things to confirm
live: (1) every card/recipe **name** matches between JSON and DSL content (a
mismatch makes `lookup` return `None` → silent match failure); (2) the synthetic
tile-stock op (`aspect.wood dec` → correct stock slot); (3) the `create
…owner.inventory` owner-walk; (4) hold mapping incl. the legacy `Borrow →
slot_share` aggregation (replicated deliberately — revisit if it looks wrong).

Original sub-steps:

1. **operating_set + reverse map** — extend `gather.rs` to build the VM frame
   from the snapshot plus a slot-path ↔ `card_id` map.
2. **Plan→reducer translator** — map `vm::Plan` (abstract `Effect::Create{def,
   target}` / `Stock` / `Destroy`, slot-path holds) to concrete reducer calls,
   replacing `apply.rs`'s legacy `ActionPlan` materialization. Resolve `target`
   paths (e.g. `owner.inventory`) to real container ids.
3. **Switch call sites** — `propose.rs` / `validation.rs` call
   `Content::match_recipe` / `plan_recipe` instead of the legacy planner.
4. **Verification:** existing recipes (cut_tree, …) produce identical reducer
   calls vs legacy; then drop `resonantdust_content` from the gate.

### Phase 3 — Regions module worldgen — **IN PROGRESS**

Name-parity check (Phase 2 follow-up) found the DSL **deliberately renamed**
content vs the legacy JSON: tiles folded (`forest_1..4` → `forest`), polarity
cards (`corpus+/-` → `_lit/_dim/_upgrade`), 3 recipes (`corpus-` → `corpus_dim`,
`corpus_b.1/.2` → `corpus_b_top/bottom`). So the gate's name-join only covers
unchanged names — Phase 3 (DSL-native ids in the modules + world regen) is a
prerequisite for verifying the gate, not independent. After it, the gate decodes
via the Bundle and the legacy-decode bridge in `dsl_recipe.rs` is deleted.

- **3a DONE** — regions module links `resonantdust-data` (path
  `../../../pixijs/src/shared/data`, reachable via the `pixijs` build mount);
  `build.rs` embeds `content/data/**.rd` → `RD_FILES`; `content::bundle()` loads
  the `Bundle` once. Compiles to the SpacetimeDB wasm target.
- **3b DONE** — `world_gen.rs` rewritten: all legacy noise / biome / pick /
  cluster code removed; `generate_zone_tiles` now walks cells through
  `resonantdust_data::worldgen::generate_tile`, packing the DSL Bundle tile
  `def_id`s. Zone packing stays on the legacy `packed` re-export for now.
  (`biome_for`/`pick_tile` were dead — dropped.) Builds clean.
- **3c DONE** — cards module on the Bundle: `gate_api`/`utilities`/`souls`
  `find_packed_by_key` → `bundle.packed_def`; soul-stat keys `-` → `_dim`
  (Injured `-i` left as no-op, `TODO(content)` — absent in legacy `id.json` too,
  so no regression); `cards.rs` magnetic via `bundle.is_magnetic` +
  `state_flags().magnetic`; `blueprints.rs` builder-cap via
  `content::def_aspect_total` (folded `aspect.builder`). regions read-sites
  switched too (`zones::stock_defaults_for` → `bridge::stock_defaults`, `"empty"`
  → `bundle.packed_def`). Both modules build; new Bundle def-metadata API
  (`name_for_packed`/`stock_defaults`/`is_magnetic`/`is_descendant`) tested
  (75 wasm tests).
- **3d — code DONE, live-ops TODO** — gate decode switched to
  `bundle.name_for_packed`; **legacy decode bridge deleted**; gate builds.
  Remaining is live only: `bin/st` build+publish cards+regions, `bin/gate`
  publish, **wipe + regenerate the claude DB** (existing legacy-id rows are
  unreadable by the now-DSL gate — data disposable), re-bootstrap +
  `generate_forest_terrain`, drive a recipe (`triple_corpus`, `cut_tree`) and
  confirm end-to-end. Players module untouched (auth/index, assigns no card ids —
  confirm during the run).

Original sub-steps:

1. **`.rd` delivery into the module** — mirror the legacy `build.rs` pattern:
   `include_str!` the `.rd` tree, `load()` the `Bundle` once in a `OnceLock`.
   (Avoids the table-push design for now.)
2. **Port `world_gen.rs`** to call `resonantdust-data` (noise + biome-select +
   `@init`) instead of `biome_core` / `cards_of_type` / `decode_definition`.
3. **Unify packing** via the shared codec (1.6); `create_card` /
   `find_packed_by_key` use Bundle ids.
4. **Verification:** generated zones byte-match the Phase 1 parity baseline;
   remove `resonantdust_content` from regions (then cards, players).

### Phase 4 — Client

1. **`.rd` bundling** — vite step (or build script) reads `content/data/**.rd` →
   `[[name, text], …]` JSON.
2. **Bootstrap `Content`** in `main.ts` after the legacy init (dual-run during
   migration).
3. **Port `recipeMatcher.ts`** to `Content.match_recipe` (preserve the
   incremental client-matcher behavior — do not regress it).
4. **Tile render via `card_view`** — `LayoutWorld.buildTile` reads visuals from
   the Cell; `@init`/`@visuals` feed the object decorator.
5. **def_id / locale migration** to the Bundle space.
6. **Verification:** local prediction matches server; render parity; delete the
   legacy `resonantdust_content` wasm import.

### Phase 5 — Decommission

- Resolve the deferred `shape`/`faction`/`type` registries into the DSL so the
  JSON registries can go.
- Delete `pixijs/src/content` (legacy crate + `id.json` + JSON catalogs) once all
  three consumers are off it.

---

## 3. Sequencing

```
Phase 0 (done) ─→ Phase 1 ─┬─→ Phase 2 (gate)            ─┐
                           ├─→ Phase 3 (regions module)  ─┼─→ Phase 5
                           └─→ Phase 4 (client)          ─┘
```

Phase 1 is the hard serial dependency. Phases 2–4 are independent once it lands
and can run in parallel or any order. The **Phase 1.8 parity tests are the
linchpin** — they let each consumer cut over with a proof that new == legacy
before the old path is deleted.
