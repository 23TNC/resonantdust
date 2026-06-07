# Gate-authority pivot — revised plan

Status: **planning** (2026-06-03). Supersedes the gate/module split in
`00_design_and_plan.md` (Phases 2–3). The shared crate work and the gate's DSL
runtime survive; the **direction reverses** — the DSL leaves the SpacetimeDB
modules entirely and lives only in the gate.

## 1. Architecture

- **Shards = dumb transactional data authority.** Rows, versions, and the lock
  state. No DSL, no content registries, no interpretation. Content-agnostic.
- **Gate = compute / state authority** for its players. All validation, DSL
  evaluation, planning, worldgen, and lifecycle resolution. Reads the `.rd`
  corpus from a file at startup (no DSL-in-table).
- **Multiple gateways + multiple data shards.** A recipe may span shards (region
  shard + per-player card shards) but is always driven by **one** gate.
- **No cross-gate recipes.** Invariant: *a recipe's participants ⊆ one gate's
  player set ∪ shared-world cards.* Gate routing must co-locate any players who
  can co-participate (proximity/region-based).
- **Multi-gate concurrency = self-expiring lease locks, fail-fast.** The gate
  validates, then acquires holds (`use`/`claim`/`share`/`borrow`) on the shards.
  Each acquire atomically writes its own future-stamped release
  (`completion_ms`), so a lock is a lease that self-heals on crash. A gate that
  hits an exclusively-held card is rejected and backs out — no waiting, so no
  deadlock. Contention resolves by whoever's acquire commits first.

Why this works cheaply: the game is **extremely latency-tolerant** (server runs
≤10s ahead of clients; proposed times must fall in `[server-10s, server]`).
Internal cross-shard round-trips and "held-then-expired" lock waste are noise
against that window. The future-stamped/forward-propagated model turns the hard
distributed-locking problems (crash leaks, cross-shard atomicity, deadlock) into
non-issues.

## 2. Impact on existing work

**Keep (re-home to the gate):**
- `resonantdust-data` — the whole DSL runtime. Linked by the gate only.
- The gate's `dsl_recipe.rs` (frame build → match → plan → ActionPlan).
- The def-metadata API (`packed_def`, `name_for_packed`, `is_magnetic`,
  `stock_defaults`, `def_aspect_total`, `worldgen::generate_tile`). Same code —
  the **call site moves from the modules into the gate.**

**Revert (Phase 3 module embedding):**
- `regions` + `cards`: remove the `resonantdust-data` dep, `build.rs` `.rd`
  embed, and `content.rs`. Stop calling the Bundle.
- `regions/world_gen.rs`: the DSL tile generation moves to the gate; the module
  keeps only a dumb "write these zone bytes" reducer.
- `cards`: `create_card` takes a pre-computed `packed_def` + state-flag mask as
  args; `souls`/`blueprints` content logic moves to the gate.
- Modules keep `resonantdust_content::packed` (pure bit-packing — content-free)
  but drop all `definition_core` / `biome_core` / `recipe_*` usage. Fully
  porting `packed` into a shared crate is deferred.

**Reshape (the gate):**
- `apply.rs` → lease-lock protocol (acquire+expiry in one call; fail-fast).
- New gate responsibilities: worldgen-on-zone-enter, card-spawn def-metadata,
  soul-stats, blueprint-cap, and magnetic/lifecycle resolution.

## 3. Workstreams (finish gate + modules first)

### P1 — Lease-lock protocol — **CODE DONE 2026-06-03 (build-verified; contention test in P5)**

Landed: `cards::acquire_lease` (atomic acquire@acquire_ms + release@release_ms,
reader/writer CAS — SLOT_HOLD rejects on any exclusive|shared, SLOT_SHARE rejects
on exclusive; reads `prior_at(acquire_ms).flags_bk`); `dispatch_hold` shared
helper; `regions::acquire_tile_lease` (tile mirror). Gate `apply.rs` reshaped to
single-pass `card_lease`/`tile_lease`, fail-fast, no separate release pass.
cards+regions+gate all build.

Open follow-ups (not blockers for the build, address before/with P5):
- **Post-lock re-validation:** currently relies on guarded/idempotent effects
  (idempotent `destroy`, find-or-create `set_tile_stock`). Confirm tile-stock
  `dec` **saturates** at 0 so a stale plan can't underflow; otherwise add a
  re-read+reconfirm after the leases are held.
- **Dedup vs retry:** `claim_pending` still runs before the leases, so a
  fail-fast lease abort leaves the dedup row until `completion_ms` (blocks
  immediate retry of the same tuple). Not a regression; consider moving
  `claim_pending` after the lease pass for clean retry.

Original design:
- **Acquire reducer (per shard):** atomically `+1` the hold now **and** write the
  `-1` release at `completion_ms` in one transaction (self-expiring lease).
  Exclusive verbs (`use`/`claim`) do a check-and-set: reject if `count > 0` on
  **latest committed** state (execution-time serialization, not `valid_at`).
- **Gate apply loop:** gather → validate/plan (optimistic) → acquire all holds in
  a canonical order, **fail-fast** on any conflict (reject; held leases expire) →
  **re-read the locked cards and re-confirm predicates** (or rely on guarded,
  idempotent effects: saturating `dec`, idempotent `destroy`) → write effects
  future-stamped. Drop the separate release pass (now part of acquire).
- **Verify:** two gates contending on one card — exactly one wins; loser backs
  out; no leaked locks after `completion_ms`.

### P2 — Worldgen → gate — **CORE DONE 2026-06-03 (build-verified)**

Landed: `gateway/src/worldgen.rs::tiles_for_zone` (gate computes a world zone's
16 packed tile-u64s from the Bundle + shared noise); `ws.rs` intercepts
`request_zone` and injects the tiles; regions `request_zone` reshaped to take
`tiles: Vec<u64>` and store them; `regions/world_gen.rs` deleted (incl. the
unused `generate_forest_terrain`). regions + gate build.

**P2b DONE 2026-06-03:** regions is now **fully content-agnostic** — no
`resonantdust-data` dep, no `.rd` embed, no `content.rs` (keeps only
`resonantdust_content::packed`, pure bit-packing). `request_zone` stores the
gate-computed tiles for every surface (gate fills an empty grid for non-world);
`create_disk_at`/`create_rect_at` (future mini-zone/inventory scaffolding) now
take a gate-supplied `empty_packed`; `stock_defaults_for` /
`set_tile_at_with_defaults` removed (DSL stock defaults are always 0). regions +
gate build. Bulk world bootstrap (was `generate_forest_terrain`) becomes a
gate-side loop over `request_zone` (P5).

Original design:
- Move `generate_zone_tiles` (the per-cell `generate_tile` loop) into the gate.
- `regions`: replace `generate_forest_terrain` with a dumb
  `write_zone(macro_zone, tiles[16])` reducer the gate calls on zone-enter
  (idempotent: same seed → same bytes, so concurrent gates are fine).
- Revert the regions `.rd` embed + `resonantdust-data` dep + `zones.rs`
  Bundle calls (`stock_defaults_for`, `"empty"`).

### P3 — Card spawn + content-derived server logic → gate — **PARTIAL 2026-06-03**

Done (build-verified): `create_card` takes a gate-computed `packed_def` (the gate
resolves the def name from its Bundle in `apply.rs`); `definition_state_flag_mask`
stubbed to 0 (magnetic is inert — no live resolver; the gate-side lifecycle
scheduler will set the bit when built); `is_soul_card` was already content-free
(type nibble). cards + gate build.

Remaining bundle uses in cards (dep can't drop until all gone):
- **`utilities::spawn_soul`** (×4 `packed_def` lookups) — bootstrap starter-card
  spawning ("disposable pre-release seeding"). Move to gate-supplied ids (gate
  intercepts `spawn_soul`) or retire the seeding.
- **`blueprints` builder-cap** (`def_aspect_total`) — gate intercepts
  `request_blueprint`, computes the cap, relays/rejects.
- **Soul-stats — DONE (gate-owned, option a).** Removed `on_card_write`'s stat
  diff + `card_contribution` + `stat_map`/`stat_slot_for` (the per-write content
  lookup — the load win). Kept the content-free `apply_slot_delta` byte-writer,
  exposed as the `set_soul_stat(soul, field, byte, delta, time)` reducer. The
  gate owns the stat-card→slot map + an `owning_soul` walk over the snapshot and
  pushes `set_soul_stat(±1)` on stat-card create/destroy in `apply.rs` (snapshot
  threaded into `apply`). cards + gate build.
  - **Gap to close:** bootstrap `spawn_soul` spawns `corpus×3` server-side (not
    via the gate), so the bootstrapped soul's stats start at 0 — fold into the
    bootstrap-ids work below (set initial stats in `spawn_soul`, or move the
    seeding gate-side). Stat-card *moves* (pickup/drop) also need a gate push if
    stat cards ever become hand-movable (deferred — they're recipe/lifecycle-managed).

**Still blocking the cards dep-drop:**
- **`utilities::spawn_soul`** (×4 `packed_def` lookups) — bootstrap seeding;
  gate-supply the ids (+ set initial soul stats).
- **`blueprints` builder-cap** (`def_aspect_total`) — gate intercepts
  `request_blueprint`, computes the cap, relays/rejects.
Then drop the `resonantdust-data` dep + `.rd` embed from cards.

Original design:
- `create_card`: gate computes `packed_def(name)` + magnetic flag mask, passes
  them as args; the reducer just stores. Revert the cards `.rd` embed + dep.
- **Soul-stats:** move the `packed → StatSlot` interpretation gate-side; the gate
  pushes the soul's stat bytes (no server-side content map).
- **Blueprint cap:** move the `def_aspect_total(soul, builder)` check to the gate;
  `request_blueprint` becomes a dumb "set discovery bit / spawn blueprint" reducer.
- **Magnetic / lifecycle:** the resolver is DSL work → gate-side. A gate-owned
  scheduler counts down each in-flight magnetic action it triggered and drives
  success/failure via the same propose→lock→apply path.

### P4 — Multi-gate enablement
- Config for N gateways (each its own port/DBs; `RD_ENV` already scopes claude).
- **Routing invariant:** recipe participants ⊆ one gate. Co-gate interactable
  players (region/locality). Document + enforce.
- **Content-version invariant:** all gates load byte-identical `.rd` (else
  divergent validation + worldgen). Deploy-time check.

### P5 — Live verification
- Stand up ≥2 gates under `RD_ENV=claude` against shared shards; regenerate the
  world; drive recipes incl. deliberate cross-gate contention on a shared tile;
  confirm lease expiry, fail-fast rejection, and no leaks.

## 4. Open decisions (recommendations baked in; correct as needed)
- **Magnetic/lifecycle → gate scheduler** (vs server tick). Recommend gate — it's
  DSL work and the triggering gate is the state authority. Confirm.
- **Soul-stats → gate** (vs a minimal static module table). Recommend gate, to
  keep modules content-agnostic.
- **Keep `resonantdust_content::packed` in the modules** for now (vs port packing
  to a shared crate immediately). Recommend keep; port later.

## 4.5 Live verification (RD_ENV=claude, 2026-06-03)

Ran against the claude stack — proves the pivot live, not just compiling:
- **Modules publish + init** (players/regionindex/regions/cards) — regions loads
  fully content-agnostic (no `resonantdust-data`), cards loads slimmed. No crash.
- **Gate boots + loads bundle** — `content bundle loaded files=33 cards=44
  recipes=14 aspects=45 version=b8e60c9a86775f08`, `gate listening :8474`.
- **`ensure_region`** executes → region row written (`zone_presence=u64::MAX`).
- **`request_zone` stores gate-supplied tiles** — passed `t_0=0x12345678` for a
  fresh world zone; the row read back `t_0=305419896` exactly. P2 worldgen-push
  path confirmed (gate computes tiles → regions stores them).
- **`create_card`** with a gate-supplied `packed_def` → card row created.
- **Lease CAS (P1)** — `acquire_lease` SLOT_HOLD on card 1033 succeeded; a
  second exclusive `acquire_lease` on the same card was **rejected**
  (`card 1033 unavailable (exclusive=1, shared=0)`). The multi-gate
  concurrency guard works against the running DB.

Not yet live (needs the client / a WS driver — deferred): full `propose_action`
recipe round-trip (gather→match→lease→effects→`set_soul_stat`), and the
self-expiry of a lease at `completion_ms` (same future-stamped mechanism).

## 4.6 Status & residual

**Done + live-verified (load-bearing):** P1 leases, P2/P2b worldgen→gate +
regions content-agnostic, P3 hot-path (`create_card` gate-supplied, soul-stats
gate-owned), gate DSL match/plan, P4 content-version fingerprint.

**P3b DONE — both modules fully content-agnostic (no `resonantdust-data`):**
- `spawn_soul` / `add_card` take gate-supplied packed defs; the gate intercepts
  them in `relay_call` and injects (the dev-loadout composition now lives in the
  gate — single source). `STARTER_SOUL_KEY` removed.
- `request_blueprint` takes a gate-supplied `max_active` (the gate computes the
  player-soul's folded `builder` aspect via `content::def_aspect_total` and
  injects it; the reducer just compares vs `active_blueprints`). Assumes blueprint
  requests are for the player_soul def (the only one) — fine under the current
  single-soul-def model; revisit if multiple soul defs request blueprints.
- cards `content.rs` / `build.rs` / `.rd` embed / dep removed. cards + gate build;
  cards republishes + inits content-agnostic.
- **Known cosmetic gap:** the dev human's stats start at 0 (the removed
  `on_card_write` hook used to bump `corpus` from the 3 starter corpus). The dev
  loadout is an opaque packed Vec to `spawn_soul` now, so it doesn't self-init
  stats. Dev-only/disposable; wire a gate stat-push or per-card init if wanted.

**Residual — NOT load-bearing:**
- **Multi-gate routing** — the lease enabler (P1) is done + verified; running N
  gate instances + a player→gate router (honoring "recipe participants ⊆ one
  gate") is deployment/ops, not module code.
- **Full `propose_action` e2e** — needs a WS driver / the client (Phase 4).

## 4.7 Content-Rust decommission (porting `resonantdust-content` → wasm)

Goal: `content/` = `.rd` + JSON data only; all Rust in `resonantdust-data`.

**Ported to `resonantdust-data` (build-verified):**
- `packed` (911L bit-layout — macro_zone/micro/zone-tile/routing), verbatim.
- `card_model` (flags_bk readers) + `flags` (positions transcribed from
  `flags.json` to consts — modules can't embed JSON; `flags.json` stays as the
  spec). `flag_bit`/`flag_field`/`FlagField` API preserved.
- `plan` (the `ActionPlan`/`Effect`/`HoldKinds`/`StockOp` contract).
- `biome_core` is dead (gone in practice). 99 wasm tests pass.

**Now fully content-free:** `players`, `regions` (dropped `resonantdust-content`).

**Remaining (the logic-heavy, client-id-coupled tail) — keeps gate + cards on
`resonantdust-content`:**
- **gate recipe cluster:** `recipe_core::recipe(id)` (recipe id→name — the gate
  should read `recipes/id.json` itself) + `recipe_validate` (`validate_bindings`
  reimplemented gate-native over the snapshot + the vm Plan's holds;
  `CardStore`/`CardView`/`SyntheticTile` types relocated). These are coupled
  (validate_bindings consumes the legacy `Recipe`). The recipe **id space** is
  the client's (`recipes/id.json`) — the Rust can move now (gate reads the JSON
  data); the *ids* only change with the client.
- **cards blueprint cluster:** `blueprint_core` (the gate resolves blueprint
  id→key from the registry and passes it, like the builder-cap; cards stops
  using it) + a stray `definition_core` ref to clear.
- Then drop the `resonantdust-content` dep from gate + cards, delete content's
  `build.rs` + Cargo + lib (and the now-dead legacy registries) → content = data.

## 5. Deferred: client
Untouched until gate + modules settle. Then (old Phase 4): vite `.rd` bundling,
`Content` bootstrap, port `recipeMatcher.ts` / `LayoutWorld`, def_id/locale
migration, delete the legacy content wasm. The browser bundle (`shared/pkg`) is
already built and waiting.
