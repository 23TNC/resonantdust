# Resonant Dust

Multiplayer card / hex-tile game. The repo is a thin shell over three
directories that each have their own `AGENT.md` (or `AGENTS.md`) — start
there for the actual contracts.

## Layout

| Path | Purpose |
| --- | --- |
| [pixijs/](pixijs/AGENT.md) | PixiJS v8 + TypeScript client. Renders the world / inventory, drives the game tick, talks to SpacetimeDB. |
| [spacetime/](spacetime/server/AGENTS.md) | SpacetimeDB module (Rust). Authoritative game state — cards, players, actions, zones, recipes. |
| [data/](data/AGENT.md) | Shared JSON game data — card definitions, aspects, recipes, biomes. **Read by both client and server**; symlinked into the pixijs project, embedded into the Rust module via `include_str!`. |

## Submodules

`pixijs/`, `spacetime/`, and `data/` are each tracked as a git submodule
(see `.gitmodules`). Editing files inside one of those directories from
this repo lands the change in the *submodule's* repo, not this one.
Cloning fresh? `git submodule update --init --recursive`.

## Where to start

- New to the project: read [pixijs/AGENT.md](pixijs/AGENT.md) and
  [spacetime/server/spacetimedb/AGENTS.md](spacetime/server/spacetimedb/AGENTS.md).
  They explain the client/server split.
- Adding a card or recipe: [data/AGENT.md](data/AGENT.md) plus
  [data/cards/AGENT.md](data/cards/AGENT.md) /
  [data/recipes/AGENT.md](data/recipes/AGENT.md).
- Working on the world board / hex grid: [pixijs/src/world/AGENT.md](pixijs/src/world/AGENT.md).
- Working on the action / recipe system: client side is
  [pixijs/src/actions/AGENT.md](pixijs/src/actions/AGENT.md), server side
  is `actions.rs` / `magnetic.rs` documented under the spacetime module.

## Cross-cutting conventions

- **Schema is shared, evaluation is mirrored.** The same `data/*.json`
  feeds both server (Rust, embedded at compile time) and client
  (TypeScript, bundled by Vite). Recipe priority evaluation runs on
  both sides — client as a pre-filter, server as the authoritative
  evaluator. Logic must be kept in lockstep manually; see
  [data/recipes/AGENT.md](data/recipes/AGENT.md) ("Where this is implemented").
- **Bindings are generated.** The client's `pixijs/src/server/bindings/`
  is regenerated from the server schema by
  `spacetime/server/generate-bindings.sh`. Never edit by hand.
- **Authority model.** The server is authoritative for card identity,
  inventory membership, world-tile state, and action lifecycle. The
  client is authoritative for inventory layout (stacking, ordering,
  pixel positions); inventory fiddling never reaches the wire until a
  state-changing event (recipe commit, world drop, etc.) triggers a
  reducer call.
