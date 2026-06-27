# DSL rewrite — implementation plan

Status: **Phases A–E landed (shared-side), gateway integration pending.** Reference
syntax: `content/data/recipes/02.rd`. Temporal/persistence model (deferred):
`docs/temporal_aspect_log.md`.

Progress:
- ✅ **A** `<data_func>` + pop/ret ABI (`1f6c4a9`)
- ✅ **B** `aspect`→`data`/`visual` split (`38f4a5d`) + rules fixup (`9993ff1`)
- ✅ **C** schema-by-execution + zone-first (`8ab90b3`)
- ✅ **D1** `^macro_zone`/`^create` validator arities (`8156e84`)
- ✅ **D/E** new recipe model — predicate `@input`, `sys.time` timeline, holds/dead
  as `Stock`, `^create`/`^macro_zone` runtime, codec `ActionPlan` reshape, rules
  `translate()` rewrite (`b02d8e5`). All shared crates green.
- 🟡 **Gateway integration** — `gateway/src/{apply,propose}.rs` now **compile**
  against the new `ActionPlan` (gateway `05203e9`): effects map to the existing
  `apply_action` reducer (Create/SetCardStock/ModifyTileStock); `@input` is the
  hold authority (propose `wants_exclusive=false`). Runtime gaps documented as
  TODOs — they need **`spacetime` shard reducer changes + harness verification**:
  - per-effect future-stamping (all effects apply at `completion_ms`, ignoring `at`);
  - holds-as-stock enforcement (bound_masks=0; claim/touch writes don't yet keep a
    card alive or gate concurrent claims);
  - dead-as-stock reaping (destroy is `data.dead inc`; reaper must act on the bit;
    soul-stat decrement not re-derived);
  - runtime tile holds (tile hold mask=0; regions DB has no runtime tile-hold field).
- ✅ **status.rd / corpus green** (`a7157ef`) — added placeholder new-model
  `despair/strike/gloom` magnetic recipes (recipes/03_status.rd) so the dangling
  refs resolve; the whole shared workspace now passes. (Stubs resolve the magnet
  via `data.dead inc` — replace with real outcomes when magnetic gameplay ports.)
- ⬜ **Shard reducers** (`spacetime` submodule) — the runtime semantics behind the
  4 gateway TODOs (per-effect future-stamping, holds-as-stock, dead-as-stock
  reaping, runtime tile holds). Needs the harness; where the temporal op-log
  becomes load-bearing.
- ⬜ **Deferred** — the temporal op-log / GC / subscription split.

## What's changing (the rulings we locked)

1. **Stack discipline.** `call` gives the callee an isolated operand stack + a
   fresh locals scope; args arrive via `pop`; `ret <val>` tears down and pushes
   the result. Bare leading path segment = a **frame-local register** (holds a
   `Ref` into the shared Store; `slot.*` stays recipe-global).
2. **`<data_func>` bucket** — pure helpers, distinct `$data_func::` registry
   (separate from `$functions`).
3. **Aspect namespace split** — drop `aspect`; two anchors: **`data.*`**
   (server-authoritative, stock-packed, persisted) and **`visual.*`**
   (client-only, ephemeral, no bit allocation). VM routes storage by anchor.
4. **Schema by execution** — derive the stock schema by running `:data @define`
   against an empty card and recording `data.* stock` allocations in order
   (the static `strip_prefix("aspect.")` scan can't see helper-declared stock).
   **Zone bits first**: bottom u4 is zone-savable, by declaration order, so tiles
   declare their persisted aspects before any stock-allocating `data_func`.
5. **Holds/lifecycle as aspect deltas** — `claim`/`borrow`/`touch_user`/
   `touch_server`/`pos_hold`/`dead`/`reap`/`pstyle` are `data.*` stock aspects
   mutated by `inc`/`dec` (commutative). `use`/`claim`/`share`/`borrow` verbs
   retired in favor of `can_*`/`set_*`/`release_*` helpers.
6. **`@input` is an int predicate** — `0 ret` = match, nonzero = reject;
   `match_recipe` reads `ret == 0`, returns no hold list. Read-only w.r.t.
   `data.*` (writes to `data.*` forbidden in match mode; frame-locals ok).
7. **`@output` is a timeline** — `sys.time` is an effect-stamp cursor; effects
   carry their stamp (`Plan.effects: Vec<(time, Effect)>`); duration = max stamp.
   `@output` writes the full acquire@0 → mutate@10 → release@10 arc atomically.
8. **Syscalls replace magic verbs** — `^macro_zone(card_id, surface, q, r)` →
   zone; `^create(zone, def, owner)`; `destroy` → `data.dead inc`. Retire
   `create`/`move`/`destroy` verbs.

Deferred (documented, not in this plan): the future-stamped op-log table, GC
compaction, and the snapshot/live-tail subscription split. Until built, the gate
applies the `sys.time` timeline via the existing future-row stamping mechanism.

## Phases (dependency-ordered)

Each phase is independently testable in `shared/dsl` / `shared/rules` unit tests
before any live gate/client verification.

### Phase A — VM execution core (keystone)
`shared/dsl/src/{parser,vm,loader}.rs`
- Parser: `pop` token; `<data_func>` bucket header.
- VM: call frames (isolated operand stack, per-frame locals map, return addr);
  `pop` opcode (transfer next arg caller→callee); `ret <val>` teardown.
- Frame-local resolution: bare anchor → current frame's locals; assigned an
  address it stores a `Ref`; `*x.field` follows it into the shared Store.
- Loader/VM: `$data_func::` registry + `call` dispatch (lineage-aware like
  `functions`).
- **Verify:** a `data_func` pops an arg, mutates via the alias, returns; nested
  calls don't stomp each other's locals; `slot.*` still resolves recipe-global
  inside a callee.

### Phase B — Aspect namespace split + storage routing
`shared/dsl/src/{vm,bridge,resolve}.rs`, `content/**`
- Rename `aspect.` → `data.` (DSL, bridge's hardcoded prefixes at
  `bridge.rs:42/83/103/163/188`, `resolve.rs` aspect set, content).
- Add `visual.*` as an ephemeral loose-`Cell` anchor (no schema, no bits).
- VM routes writes by anchor: `data.*` → stock-backed; `visual.*` → ephemeral
  map; reject `stock`/`range`/`scatter` on `visual.*`.
- **Verify:** `data.*` packs; `visual.*` stays loose; existing bridge tests pass
  under the `data.` prefix.

### Phase C — Schema by execution + zone-first
`shared/dsl/src/{bridge,loader}.rs`
- Replace `stock_schema`'s static scan with: execute `:data @define` on an empty
  card, record `data.* stock` allocations in order (capture the resolved
  sub-path, e.g. `touch.user`).
- Bottom-u4 zone-savable by declaration order; tile lint ("≥1 `stock` before any
  stock-allocating `data_func`").
- **Verify:** `forest` schema = `[pine, flora, claim, borrow, …]`, pine/flora in
  bits 0–3, helper holds in upper bits; nested `touch.user` keyed correctly.

### Phase D — Recipe semantics
`shared/dsl/src/vm.rs`
- `@input` → int verdict; `match_recipe` = `exec(input) == 0`; drop the hold list.
- Read-only `@input`: forbid `data.*` writes in `Mode::Input` (locals ok).
- `@output` → `sys.time` cursor; `Plan.effects: Vec<(time, Effect)>`; duration =
  max stamp.
- New syscalls `^macro_zone`, `^create`; retire `use/claim/share/borrow/
  destroy/create/move` verbs.
- **Verify:** `cut_tree` matches + plans; holds emitted as `data.*` deltas at
  t=0, mutations + releases at t=10, all stamped.

### Phase E — rules / codec / gate wiring
`shared/rules/src/dsl_recipe.rs`, `shared/codec/src/plan.rs`, `gateway/`
- `ActionPlan` carries time-stamped effects; `dsl_recipe::run` translates the
  timeline (acquire/mutate/release) into effects.
- Gate applies the timeline via existing future-row stamping (write t=0 effects
  now, t=10 effects future-stamped) — precursor to the deferred op-log.
- **Verify:** rules unit tests; then live gate via the multi-client harness —
  `cut_tree` end to end (acquire, build window, release, spawn).

### Phase F — Content migration + validation
`content/**`, `shared/dsl/src/{validate,resolve}.rs`, `content/data/SYNTAX.txt`,
`content/data/CONVENTIONS.txt`, editor highlighter
- Migrate all `.rd` to helpers + data/visual split + new verbs. **Fix
  `aspect_stack_*` to write `stack_hosts`/`stack_joins`** (engine reads the long
  names — `defs.rs:720-721`), drop card-level duplicates.
- `validate.rs`: update stack-neutrality effects for `pop`/`ret`/`call`-frame ABI;
  `resolve.rs`: `$data_func::` resolution + read-only-`@input` and tile zone-first
  lints.
- Update SYNTAX/CONVENTIONS docs and the two-color highlighter (data vs visual).
- **Verify:** corpus loads (`bin/shared test`); harness `cut_tree` /
  `triple_corpus`; browser smoke.

### Deferred — Temporal op-log + GC + subscription split
Per `docs/temporal_aspect_log.md`: delta op-log, settled-watermark compaction to
one in-place checkpoint, one-shot login snapshot + live-tail subscription. Build
when the future-stamp scheduling in Phase E needs to survive restarts / scale.

## Risks / watch-items
- **Stack-neutrality validator** must learn the new ABI or it will reject valid
  `data_func` bodies (`pop` = (0→1), `call` = (n→1), `ret` = (1→0)).
- **Bridge `data.` rename** is the widest mechanical edit; do it as its own commit
  (Phase B) to keep the semantic diffs clean.
- **`visual.*` from server recipes** has no propagation path yet (not persisted/
  folded) — out of scope here; revisit with the visual side.
- **Holds in a rect card's persisted u64** are self-clearing via the scheduled
  release delta (crash-safe once the op-log lands); fine under future-stamping now.
