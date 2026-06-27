# Pulling flags into the DSL — `<flags>` + `flags.*`

Status: **plan**. Goal: a third aspect namespace `flags.*` over the propagating
`flags` u32 word, defined by a global `<flags>` bucket — completing the
`data` / `visual` / `flags` triad. Resolves the `dead`/holds duplication and gives
the **content-agnostic shard** a content-free `dead`/`reap` bit.

## End state

| Bucket | Defines | Instance namespace |
|---|---|---|
| `<globals>` | shared constants | — |
| `<aspect>` | aspect registry (satisfies LUT) | `data.*` (stock u64, per-def schema) |
| **`<flags>`** | **the u32 flag layout (name → width)** | **`flags.*`** (the flags word) |
| — | — | `visual.*` (ephemeral, client-only) |

- `<flags>` declares the bit layout ONCE, globally (single universal layout).
  Append-stable allocation (declaration order, optional pin), 32-bit budget
  enforced at load. A def's width is `1` (a flag) or `N` (a refcount field) — so
  `<flags>` unifies today's `flag_bit` + `flag_field`.
- `flags.*` reads/writes the card's `flags` word through that layout
  (`*a.flags.claim`, `&a.flags.dead inc`) — no projection bridge.
- Holds + `dead`/`reap` move OUT of `data.*` stock INTO `flags.*` (where the
  refcount fields already exist). `flags.*` is for **propagating + shard-read**
  coarse state; `data.*` (roomy u64) stays for magnitudes.

## Why it works

The layout is global + content-independent, so it lives in `codec` (linked by the
shard), and the shard reads `flags.dead`/`flags.reap` at a known bit with **no
content load**. GC stays trivial: `dead` is one fixed bit.

## Key mechanism note — atomicity

`flags.*` writes split by kind, reusing what already works:
- **Refcount holds** (`claim`/`borrow`/`touch`/`pos_hold`) → the EXISTING atomic
  hold path (`check_hold_available` + `apply_hold_mask` in the shard). A snapshot
  read + gate-computed absolute is racy for a refcount; the shard's CAS is the
  guard. So `set_use`/`set_claim` (the data_funcs writing `flags.claim` inc/dec)
  translate to a hold mask, not an absolute write. **This supersedes the current
  holds-as-`data.*`-stock implementation.**
- **Single-bit flags** (`dead`, state) → absolute `SetCardFlags` (gate computes
  the new word; the shard writes `c.flags = value`). Idempotent set, no CAS needed.

## Phases

Each is independently testable (`shared` unit tests) before the claude-env redeploy.

### Phase 0 — `<flags>` bucket: parse + load + layout (mirror-validated)
`shared/dsl/src/{parser,loader,resolve}.rs`
- Parse `<flags>` like `<globals>`/`<aspect>` (`::name> @define> <n> &width set`,
  optional `&bit set` pin).
- Loader builds a `FlagLayout { name → (shift, width) }` (append-allocated, budget
  ≤ 32). Stored on `Bundle`.
- **Mirror check:** assert the `<flags>` layout matches `codec`'s hardcoded
  `flag_bit`/`flag_field` — fail load on divergence. This makes `<flags>` the
  documented source WITHOUT yet regenerating `codec` (so live rows keep their bit
  positions).
- `resolve.rs`: register `<flags>` names; route `flags.X` member-checks here.
- **Verify:** dsl unit test (parse + layout + mirror match).

### Phase 1 — `flags.*` read (card_view projection)
`shared/dsl/src/bridge.rs`, `shared/rules` lookup
- Add `flags: u32` to `bridge::Card` + the `dsl_recipe` lookup (from `CardView`).
- `card_view` decodes the `flags` word → `flags.*` entries via the layout, so
  `@input can_claim` reads `*a.flags.claim` directly.
- **Verify:** bridge test (a card's flags → `flags.claim`/`flags.dead` readable).

### Phase 2 — `flags.*` write (recipe → flag effects)
`shared/dsl/src/vm.rs`, `shared/codec/src/plan.rs`, `shared/rules`, `gateway`, `spacetime`
- VM `@output`: `&…flags.X inc/dec/set` → a flag effect (resolve `X` → field via
  the layout). Single-bit → value; refcount → delta.
- codec: `Effect::SetCardFlags { card_id, flags }` (absolute, single-bit path);
  refcount holds reuse the hold-mask effect.
- `translate()`: single-bit → `SetCardFlags`; refcount → hold acquire/release
  (the existing path). Re-derive `propose`'s `wants_exclusive` from the
  `flags.claim` writes (drives the shard CAS pre-check).
- gateway + shard: apply `SetCardFlags` (`c.flags = value` @time); holds via
  `apply_hold_mask` (already there). Bindings regen (`bin/st build shard`).
- **Verify:** rules test (`flags.claim inc` → hold; `flags.dead inc` →
  `SetCardFlags` with bit 26 → reaper reads it).

### Phase 3 — migrate holds + `dead` from `data.*` to `flags.*`
`content/data/functions/01.rd`, `content/data/recipes/*.rd`, `content/data/aspect/01.rd`, `shared/rules`
- `aspect_flags` + the `can_/set_/release_` data_funcs operate on `flags.*`
  (claim/borrow/touch/pos_hold/dead) instead of `data.*`; drop their stock
  declarations. `pstyle` → `visual.*`.
- Recipes: `data.claim`/`data.dead` → `flags.claim`/`flags.dead`.
- Remove the `data.dead → Destroy` special-case (`flags.dead` IS the reaper bit).
- Aspect registry: drop claim/borrow/touch/pos_hold/dead (now in `<flags>`).
- **Closes the dead-READ gap** (`can_claim` reads `flags.dead` for real).
- **Verify:** corpus loads; cut_tree rules test; redeploy claude + browser
  (world loads; concurrency guard via `flags.claim`).

### Phase 4 — `reap` + reaper refcount
`content/data/flags`, `spacetime` gc.rs
- Declare `reap` in `<flags>`; define the gc semantics (`dead` count + `reap`
  count → when to actually remove). Resolves the deferred refcount design.
- **Verify:** gc behaviour (browser / harness).

### Phase 5 — (optional) codegen: `<flags>` owns the word
`shared/codec`, build pipeline
- Generate the `codec` flag registry FROM `<flags>` (a build step, like the
  gateway bindings); retire hand-written `flag_bit`/`flag_field`. Pull placement
  (`stack`/`index`) into `<flags>` too (own the whole word).
- Only after 0–4 are stable and the generated layout matches live bit positions.

## Risks / notes
- **32-bit budget is near full** (placement 8 + holds 16 + dead/state ~6). `<flags>`
  formalizes the existing word; little headroom. New state → `data.*` unless it
  must be shard-read + propagating. Per-type layouts are the escape hatch only if
  the word overflows (then the shard needs a small type→layout table; `dead`/`reap`
  stay universal so GC never needs it).
- **Supersedes** the current holds-as-`data.*`-stock impl (`d535c9a`) — Phase 3
  reverts those holds to the atomic hold-mask path, driven by `flags.*`.
- Phases 0–2 are pure `shared` (unit-verifiable); 3 needs the claude redeploy +
  browser; 5 touches the codec build.
