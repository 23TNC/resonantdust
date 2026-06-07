# Resonant Dust

Multiplayer card / hex-tile game. The repo is a shell over a few submodules plus
the shared Rust that ties them together. Each directory has its own `AGENTS.md`
— start there for the contracts.

## Layout

| Path | Repo | Purpose |
| --- | --- | --- |
| [pixijs/](pixijs/AGENTS.md) | submodule | PixiJS v8 + TypeScript client. Renders world / inventory, drives the game tick. Talks to the **gateway**, not SpacetimeDB directly. |
| gateway/ | submodule | The **gate** (Rust). The client's transport endpoint; validates + plans recipes, generates terrain, applies effects to SpacetimeDB. Links the shared VM as an rlib. |
| spacetime/ | submodule | SpacetimeDB modules (Rust) — authoritative *packed* card / zone / player state + hold arbitration. Being reshaped into dumb packed-state stores. (Per-module docs under `spacetime/server/modules/*/AGENTS.md`.) |
| [content/](content/AGENTS.md) | submodule | Game content. The **current** form is a stack-VM **DSL** under [`content/data/`](content/data/) (`*.rd`), spec in [`SYNTAX.txt`](content/data/SYNTAX.txt) / [`CONVENTIONS.txt`](content/data/CONVENTIONS.txt). The old JSON catalogs + `resonantdust-content` crate are legacy, being retired. |
| [shared/](shared/AGENTS.md) | **main repo** | The shared Rust: `resonantdust-data` (DSL parser / validator / resolver + VM + content loader + storage bridge) and `resonantdust-shared` (client bindings). The gate links the rlib; the client gets it built to wasm. |
| bin/ | main repo | Dockerized build/run wrappers — `bin/shared` (the VM crate), `bin/content` (legacy crate), `bin/st` / `bin/gate` / `bin/regions` / `bin/zones`, `bin/art` / `bin/cards`, and `bin/redeploy` (change-detecting rebuild+redeploy, see below). |

`shared/` is the one piece of Rust that is **not** a submodule — it's the shared
logic, kept in the main repo so it can't drift out of reach (a nested content
submodule once swallowed weeks of work).

## The shift: a DSL + one shared VM

The project is mid-migration, from "JSON schema with logic mirrored in Rust
**and** TypeScript" to a **stack-VM definition language** interpreted by **one
shared Rust VM**:

- Content is `*.rd` programs (cards / recipes / aspects / functions / assets),
  **loaded at runtime** — editing content needs no recompile.
- The VM (`shared/data/src/vm.rs`) evaluates them. The gate links it as an rlib;
  the client runs the *same code* compiled to wasm. **Evaluation is no longer
  mirrored** — server and client run identical logic, so there's no manual
  TS/Rust lockstep to keep.
- **Recompile boundary:** content change → none (reload the `.rd`); language
  change (new op / sigil) → rebuild `resonantdust-data`; storage-schema change →
  rebuild the modules.

Status: the shared **data + wasm layer is built and tested** (parser → VM →
loader → bridge → bindings). Gate / client / module integration is in progress —
see [shared/AGENTS.md](shared/AGENTS.md).

## Rebuild / redeploy

`bin/redeploy` encodes the recompile boundary above as a dependency graph and
acts only on what changed. It content-hashes each build unit's *source closure*
into a gitignored stamp dir (`spacetime/.build-state/`) — **not** mtime, **not**
`git diff` — so it catches uncommitted edits, means "since last build", and is
idempotent. The shared `resonantdust-data` crate is folded into every consumer's
inputs, so a DSL/VM edit automatically marks `shard` + `players` + `gate` dirty
(the fan-out a hand-typed build chain forgets). The unified **`shard`** module is
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

`pixijs`, `spacetime`, `content`, `gateway` are git submodules (`.gitmodules`).
Editing files inside one lands the change in *that submodule's* repo, not this
one. Fresh clone: `git submodule update --init --recursive`.

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
