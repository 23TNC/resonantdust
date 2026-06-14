# shared/

The shared Rust — the definition-language toolchain, the VM that runs it, the
content loader, the storage bridge, and the client bindings. It's called
"shared" because the **gate** and the **client** run this *same code*: the
**gate links it as an rlib**, the **client gets it as a wasm bundle**. Same
logic, both sides — that single shared evaluation is the point of the rewrite
(it replaces the old JSON crate whose logic was mirrored in TS).

## Crates

A Cargo workspace (`members = [codec, protocol, dsl, state, rules]`) plus the
root `resonantdust-shared` cdylib. The former monolithic `resonantdust-data` /
`resonantdust-content` crates are **gone** — this is the carved-up form.

- **`codec/` — `resonantdust-codec`.** The packing / encoding primitives shared
  by *everything* (gate, modules, client). `packed.rs` (macro_zone / card_id /
  `valid_at` / region packing + `region_of_zone`), `flags.rs` (the flag-field
  **registry** — the runtime source of flag mask/shift/max, replacing the retired
  `flags.json`), `card_model.rs` (the `Micro` placement model), `stacking.rs`
  (`StackBits` / `match_stack`), `bits.rs` (`get_field` / `set_field`), `plan.rs`
  (the `Plan` type).
- **`dsl/` — `resonantdust-dsl`.** The definition-language toolchain: `parser`
  (lexer + block-tree for `.rd`) → `validate` → `resolve` (whole-corpus symbol
  table) → `vm` (the interpreter: data hooks, `match_recipe` / `plan_recipe`,
  `^` system calls, the `Cell` store + `Catalog`) → `loader` (`load(&[(name,
  src)]) -> Bundle`, def ids content-derived from sorted names) → `bridge`
  (stored card → VM operating-set `Cell`). Plus `defs`, `recipe`, `locales`,
  `noise`, `worldgen` (the `^biome` terrain impl), `inspect`.
- **`state/` — `resonantdust-state`.** Client-side state machines: `recipe_state`,
  `stack` (the leaf-aware drop resolver).
- **`protocol/` — `resonantdust-protocol`.** The gate↔client wire types —
  `GateMsg` / `ClientMsg`, the `call_ok` / `call_err` / `call_promise` frames.
- **`rules/` — `resonantdust-rules`.** `dsl_recipe` — recipe rules over the DSL.
- **root — `resonantdust-shared` (cdylib).** Thin `wasm-bindgen` JSON wrappers
  over the crates for the browser, gated on the `js` feature so `cargo test` /
  `check` exercise the logic natively. (The *view* loads the separate
  `client/wasm` core for transport; this cdylib is the content/DSL surface.)

## DSL spec

The language is specified in the vendored `content/` tree, next to the content it
governs: [`content/data/SYNTAX.txt`](../content/data/SYNTAX.txt) (sigils + ops)
and [`content/data/CONVENTIONS.txt`](../content/data/CONVENTIONS.txt) (the
slot / aspect / chain model).

## Build & test (`bin/shared`)

All dockerized on the `clockworklabs/spacetime` image (host `cargo` is not used):

| Command | Action |
| --- | --- |
| `bin/shared test` | `cargo test --workspace` |
| `bin/shared corpus` | load + validate + resolve every `content/data/*.rd` (the load-bearing cross-file lint) |
| `bin/shared check` | `cargo check --workspace --all-targets` |
| `bin/shared build` | the wasm bundle (`cargo build --target wasm32 --features js` + `wasm-bindgen`) → `pkg/` |

## Status

The pure data + wasm layer is **built, tested, and integrated** end to end:

- **gate** links the crates directly: `gather` (walk card rows → an
  `operating_set` frame) + `apply` (a validated `Plan` → the coarse
  `apply_action` / `apply_action_tile` reducers, one commit per shard); worldgen
  (`^biome`) computes tile bytes the regions reducer just stores.
- **modules** (the unified [`shard`](../spacetime/server/modules/shard/AGENTS.md)
  + `players` + `chat`) link `codec` for the packing / flag / stacking
  primitives.
- **client** (`client/` core, compiled to wasm) links `codec` / `dsl` / `state` /
  `protocol` and runs the *same* matcher / VM as the gate — no TS mirror.

The crate decomposition is **done** (`codec` / `dsl` / `state` / `protocol` /
`rules`); the load-side split is enforced by Cargo's dependency graph — neither
runtime pulls in what it doesn't use. Open work lives in
[docs/ROADMAP.md](../docs/ROADMAP.md).
