# Shared crate split — design & plan

## Goal

`resonantdust-data` (at `pixijs/src/shared/data`) is one monolith holding several
distinct concerns. Split it into a small set of layered crates so:

- **SpacetimeDB modules shed the DSL.** Today every module links the whole crate
  (parser, vm, loader, worldgen) but mostly needs the bit codec. Modules are
  wasm; this is real size cut off every module.
- **The `protocol` feature flag dies.** `protocol = ["dep:serde_json"]` is a crate
  boundary in disguise — make it a crate.
- **Layering is compiler-enforced.** `state` literally cannot reach the parser.
- The new Rust `client` links exactly what it needs.

## The constraint: the DSL is one indivisible blob

The intra-crate dependency graph (measured) has a tight cycle cluster around
`loader`: `loader → vm → loader`, `loader → worldgen → loader`,
`loader → resolve → validate → resolve`. Rust crates can't be cyclic, so the
entire language machinery is **one crate** — it cannot be subdivided.

What IS cleanly separable (zero back-edges into the blob):

- `protocol` — depends on nothing.
- the codec leaves — `packed`, `bits`, `flags`, `plan`, `card_model`.
- `recipe_state` — depends on codec only, **not** the DSL (the surprise: state
  validation is already independent of the language).

## Target layout

A cargo workspace under `pixijs/src/shared/` (already a workspace —
`resonantdust-shared` with member `data`). Add members; `data` becomes a thin
re-export facade during transition, deleted once consumers narrow.

```
pixijs/src/shared/                resonantdust-shared (cdylib wrapper, workspace root)
  codec/                          resonantdust-codec
  protocol/                       resonantdust-protocol
  dsl/                            resonantdust-dsl
  state/                          resonantdust-state
  rules/                          resonantdust-rules     (created in phase 3, with the moves)
  data/                           resonantdust-data      (facade → deleted after narrowing)
  src/                            wrapper lib.rs
```

## Module → crate assignment

| crate     | modules (from `shared/data/src`)                                                            | depends on        |
|-----------|--------------------------------------------------------------------------------------------|-------------------|
| `codec`   | `bits`, `flags`, `packed`, `plan`, `card_model`                                             | — (serde derive)  |
| `protocol`| `protocol`                                                                                  | — (serde, serde_json) |
| `dsl`     | `parser`, `resolve`, `validate`, `loader`, `vm`, `bridge`, `defs`, `inspect`, `recipe`, `worldgen`, `noise`, `locales` | `codec` |
| `state`   | `recipe_state` (+ phase-3 movers: views, `synthetic_tile`, effect semantics, stacking)     | `codec`           |
| `rules`   | (phase 3) `dsl_recipe` glue + gather-derivation/apply-semantics movers                      | `dsl`, `state`, `codec` |

Acyclic layering: `codec → {protocol, dsl, state} → rules`.

## Per-consumer dependencies (end state, after narrowing)

| consumer                          | depends on                              | drops            |
|-----------------------------------|-----------------------------------------|------------------|
| SpacetimeDB modules (shard, …)    | `codec` (+ `state` iff it validates)     | dsl, protocol    |
| gateway                           | `codec`, `protocol`, `dsl`, `state`, `rules` | —            |
| client                            | `codec`, `protocol`, `dsl`, `state`, `rules` | —            |
| `resonantdust-shared` (pixijs wasm)| `codec`, `dsl`, `state`, `rules`        | protocol (TS mirrors it) |

## Build-wiring changes (the fiddly part)

Today: gateway/client **bind-mount** `../shared/data → shared-data`; modules
**path-ref** the real tree `../../../pixijs/src/shared/data`.

The facade's path-deps (`../codec`, …) live *outside* a `shared/data`-only mount,
so the mount must widen to the whole workspace:

- **gateway** `compose.yml`: `- ../shared/data:/workspace/shared-data` →
  `- ../shared:/workspace/shared`; `Cargo.toml` `path = "shared-data"` →
  `path = "shared/data"`. Imports unchanged (facade re-exports).
- **client** `compose.yml`: `- ../shared/data:/workspace/client/shared-data` →
  `- ../shared:/workspace/client/shared`; `Cargo.toml` `path = "shared/data"`.
- **modules**: **no change** in phase 1 — they path-ref the real tree, where the
  sibling crates are present; the facade pulls them in.
- **wrapper** `shared/Cargo.toml`: add the new members to `[workspace] members`.

## The facade (de-risker)

`resonantdust-data` becomes:

```rust
pub use resonantdust_codec::*;
pub use resonantdust_dsl::*;
pub use resonantdust_state::*;
pub use resonantdust_protocol::*;   // replaces the protocol feature
```

So every existing `use resonantdust_data::X` keeps compiling. The split lands with
zero call-site churn; narrowing consumers to specific crates (the leanness win)
happens incrementally and reversibly afterward.

## Phased execution (each phase ends green)

0. **Migration green** — done (gate builds).
1. **Split** (mechanical) — ✅ DONE. Created `codec`/`protocol`/`dsl`/`state`
   crates; moved the 20 modules per the DAG; rewrote the cross-crate refs
   (`crate::{bits,flags,…}` → `resonantdust_codec::…`); turned `data` into the
   re-export facade (incl. the `protocol` feature); widened the gateway + client
   mounts to the whole `shared/` workspace; modules unchanged (they mount all of
   `../pixijs`). Verified green: `cargo check --workspace` (shared), `bin/gate
   build`, `bin/client test`, `bin/st build shard`.
2. **Narrow modules** → `codec` — ✅ DONE. `shard` + `players` now depend on
   `resonantdust-codec` directly (they used only `card_model`/`flags`/`packed`);
   `chat` + `regionindex` never depended on the shared crate. Modules no longer
   link the DSL blob. Verified: `bin/st build shard`, `bin/st build players`.
3. **Land the audited moves** into `state`/`rules` — IN PROGRESS.
   - ✅ `dsl_recipe` glue → new `resonantdust-rules` crate, genericized over
     `CardStore` (+ `now_ms` threaded). Gateway deletes its copy and calls
     `resonantdust_rules::dsl_recipe::run`. Verified: `bin/gate build`.
   - ✅ host/join stacking resolver ported `stacking.ts` → `resonantdust-rules`
     (`stacking` module): `stack_bits`/`match_stack`/`resolve_stack_drop`, 4 unit
     tests incl. the card-onto-tile reverse. The drift-killer.
   - ⬜ `synthetic_tile` derivation, effect semantics (`owning_soul`/`stat_slot`/
     `hold_mask`), versioned-row collapse → `state`. Needs the shared `ZoneView`
     layer first — DEFERRED until the client world model is the real consumer
     (see status note below), to avoid shaping the abstraction blind.
4. **Delete the facade** — ✅ DONE. Narrowed every `use resonantdust_data::X`
   across gateway / client / wrapper (`shared/src`) to the owning member crate
   (`resonantdust_codec` / `_dsl` / `_state` / `_protocol`), swapped each
   consumer's `Cargo.toml` `resonantdust-data` dep for the specific members it
   uses, dropped `data` from the workspace `members`, and deleted
   `shared/data/`. Verified green: `bin/shared test` (172), `bin/client test`
   (38), `bin/gate build`, `bin/st build shard`. (The deferred phase-3 movers —
   `synthetic_tile` / effect-semantics / versioned-row collapse into `state` —
   remain in `dsl` for now; that's a separate refactor, not blocking the facade
   deletion.)

## Risks

- **Build-wiring churn across 4 consumers + the bind-mount model** — exactly the
  "stale build wiring post-reorg" hazard. The facade keeps each phase's churn
  small and each phase verifiable; do not collapse phases.
- **`bits` placement**: only the DSL cluster uses it today, but it's generic bit
  math — kept in `codec` as foundation so any external `use …::bits` still
  resolves.
- **`noise → biome`** edge: confirm `biome` is a `noise` submodule (not a stray
  ref) before moving `noise` into `dsl`.
```
