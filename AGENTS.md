# Resonant Dust

Multiplayer card / hex-tile game. The repo is a shell over a few submodules plus
the shared Rust that ties them together. Each directory has its own `AGENTS.md`
— start there for the contracts.

## Layout

| Path | Repo | Purpose |
| --- | --- | --- |
| view/ | main repo | PixiJS v8 + TypeScript **renderer**. Draw + input only — no game logic. Hosts the wasm client core in a worker, renders world / inventory from its snapshot. Talks to the **gate**, never SpacetimeDB. |
| client/ | submodule | The **client core** (Rust, sans-IO) + its wasm wrapper. Owns ALL client logic: recipe matching, zone streaming, the clock, NPCs run headless. `core/` (rlib + NPC bin) + `wasm/` (cdylib the view loads). |
| gateway/ | submodule | The **gate** (Rust). The client's transport endpoint; validates + plans recipes, generates terrain, relays narrow reducer calls to SpacetimeDB. Links the shared logic crates as rlibs. |
| spacetime/ | submodule | SpacetimeDB modules (Rust) — authoritative *packed* card / zone / player state + hold arbitration. Dumb packed-state stores. (Per-module docs under `spacetime/server/modules/*/AGENTS.md`.) |
| [content/](content/AGENTS.md) | **main repo** (vendored) | Game content: the stack-VM **DSL** under [`content/data/`](content/data/) (`*.rd`; spec in [`SYNTAX.txt`](content/data/SYNTAX.txt) / [`CONVENTIONS.txt`](content/data/CONVENTIONS.txt)), plus `locales/`, `visuals/`, `manifest.json`. The old JSON catalogs are **gone** — DSL-only now. |
| [shared/](shared/AGENTS.md) | **main repo** (vendored) | The shared Rust, split into member crates `codec` / `protocol` / `dsl` / `state` / `rules`, plus the root `resonantdust-shared` wasm cdylib. The gate + modules link the crates directly; the client gets them built to wasm. |
| docs/ | main repo | Design docs + [ROADMAP.md](docs/ROADMAP.md) — the consolidated open-work list. |
| bin/ | main repo (gitignored) | Dockerized build/run wrappers — `bin/st` / `bin/gate` / `bin/client` / `bin/shared` / `bin/content`, `bin/art` / `bin/cards` / `bin/dsl`, and `bin/redeploy` (change-detecting rebuild+redeploy, see below). |

`shared/` and `content/` are the Rust + content that are **not** submodules —
vendored as real files in the main repo so they can't drift out of reach (a
nested content submodule once swallowed weeks of work). `pixijs/` is a **retired**
submodule (the renderer moved to `view/`); still registered in `.gitmodules` but
archived out-of-tree.

## The shift: a DSL + one shared VM

The project migrated from "JSON schema with logic mirrored in Rust **and**
TypeScript" to a **stack-VM definition language** interpreted by **one shared
Rust VM**:

- Content is `*.rd` programs (cards / recipes / aspects / functions / assets),
  **loaded at runtime** — editing content needs no recompile. The DSL is the only
  content form; the JSON catalogs and the old `resonantdust-content` /
  `resonantdust-data` crates are gone.
- The VM (`shared/dsl/src/vm.rs`) evaluates them. The gate + modules link the
  shared crates as rlibs; the client runs the *same code* compiled to wasm.
  **Evaluation is not mirrored** — server and client run identical logic, no
  manual TS/Rust lockstep.
- The shared Rust is split by load-side into member crates: `codec` (packing /
  flags / stacking primitives, shared by everything), `dsl` (parser → validate →
  resolve → VM → loader → bridge), `state`, `protocol` (the gate↔client wire
  types), `rules`. The root `resonantdust-shared` cdylib wasm-binds a subset for
  the browser.
- **Recompile boundary:** content change → none (reload the `.rd`); language
  change (new op / sigil) → rebuild the `dsl` crate + dependents; storage-schema
  change → rebuild the modules.

## Rebuild / redeploy

`bin/redeploy` encodes the recompile boundary above as a dependency graph and
acts only on what changed. It content-hashes each build unit's *source closure*
into a gitignored stamp dir (`spacetime/.build-state/`) — **not** mtime, **not**
`git diff` — so it catches uncommitted edits, means "since last build", and is
idempotent. The shared crates (`codec` / `dsl` / …) are folded into every
consumer's inputs, so a DSL/VM edit automatically marks `shard` + `players` +
`gate` + the client wasm dirty (the fan-out a hand-typed build chain forgets). The unified **`shard`** module is
one binary published to BOTH the `cards` and `regions` databases (owner-card data
vs region/terrain data); `redeploy` fans its one source change out to `st re
cards` + `st re regions`.

- `redeploy` — dry run: print the plan, build nothing.
- `redeploy --run` — execute (changed module → `st re <mod>`; gate → `gate
  republish`; content edit → `gate publish` restart + reseed content dependents).
- `--no-reset` republishes without wiping data; `--mark` adopts the current tree
  as the clean baseline (use after a manual deploy, or on first adoption — but
  only if the current source is actually what's deployed); `--force` rebuilds all.

Unit definitions are the `INPUTS` table at the top of the script; the
content→reseed set is `CONTENT_DEPENDENTS`. Edit those when a module gains a
path-dep, a module is added, or the content-seeding flow changes.

## Submodules

`client`, `gateway`, `spacetime`, and `npc` are git submodules (`.gitmodules`);
`npc` and `client` point at the **same** repo (`resonantdust_client`). `pixijs`
is registered but retired/uninitialized. `view`, `shared`, `content`, `docs`,
and `bin` live in the **main repo**. Editing a file inside a submodule lands the
change in *that submodule's* repo — commit + push it, then bump the pointer in
the parent. Fresh clone: `git submodule update --init --recursive`.

## Cross-cutting conventions

- **Authority model.** The gate (+ SpacetimeDB) is authoritative for card
  identity, inventory membership, world-tile state, holds, and action lifecycle.
  The client owns inventory layout (stacking, ordering, pixel positions) and
  never reaches the wire until a state-changing event (recipe commit, world
  drop) triggers a reducer.
- **Shared code, not mirrored logic.** The recipe matcher and data hooks run
  from the one VM. Do **not** reintroduce a parallel TypeScript implementation —
  that drift is exactly what the rewrite removes.
- **Content is data, not code.** New cards/recipes/aspects are authored in
  `content/data/*.rd` against the DSL and loaded at runtime — they don't touch
  Rust. Extending the *language* (a new op) does.
