# Surface bands — the `macro_zone` container model

How every row picks the container it lives in. The single source of truth is the
band table and helpers in `shared/codec/src/packed.rs`; this doc is the prose
version plus the open seams we'll expand later.

## `macro_zone` layout

```
macro_zone : u64 = [ owner: u32 | surface: u8 | zone_q: i12 | zone_r: i12 ]
                     bits 63..32   bits 31..24   bits 23..12   bits 11..0
```

A row's container is the `(surface, macro_zone)` tuple. The `surface` byte selects
a **band**, and the band decides what the `owner` u32 *means*. The two signed
12-bit coords are read as `(q, r)` or `(x, y)` per surface; inventory-like bands
force them to `(0, 0)` and address items via `micro_location` instead.

Helpers: `owner_of(v)`, `surface_of(v)`, `unpack_macro_zone(v)`,
`pack_macro_zone_full(owner, surface, q, r)`.

## The bands

| const | val | `owner` field means | purpose |
|-------|-----|---------------------|---------|
| `INVENTORY_LAYER`        | 1  | owning soul's **card_id** | per-soul hand / bag / inventory grid |
| `PLAYER_INVENTORY_LAYER` | 2  | owning **player_id**      | player-scoped inventory shared across that player's souls (account-level items) |
| `POCKET_DIMENSION_LAYER` | 32 | anchor card's **card_id** | private interior carried by an anchor card |
| `MINI_ZONE_LAYER`        | 63 | — (reserved) | stripped; band held so the map isn't renumbered |
| `WORLD_LAYER`            | 64 | `0` (WORLD); coords are `(chunkQ, chunkR)` | shared world hex grid |

Two structural splits key off these numbers:

- **`< WORLD_LAYER`** → "stack layout" + inventory-like behavior (personal containers).
- **`>= WORLD_LAYER`** → world-vs-personal query partitioning.

## Surface 1 vs surface 2 — the only real difference

Both bands are **single-zone-per-owner** buckets: `(q, r)` is always `(0, 0)`,
item positions live in `micro_location`. They are identical *bucket conventions*.
The only difference is what the `owner` u32 holds:

- **Surface 1** — owner is a **card_id** (the soul that holds the inventory).
- **Surface 2** — owner is a **player_id** (`players::FIRST_PLAYER_ID = 512`).

`player_id` and `card_id` are **separate id spaces** that can numerically overlap.
The surface byte is the *only* thing keeping a surface-1 zone from colliding with a
surface-2 zone that happens to share an owner number. So "all of surface 2 is
player inventory" is exactly right — the band, not a reserved id range, is what
guarantees no collision with cards.

## Owner → player resolution

Placement permission walks the *card* chain, not the zone owner: `owning_player`
(`shared/state/src/recipe_state.rs`) climbs each card's `owner_id` until it hits a
**player_soul** card — identified by definition via `is_player_soul`
(reserved range `0xFFF0..=0xFFFF`) — whose `owner_id` field *is* the player_id.
A chain bottoming out at owner `0` resolves to `WORLD_PLAYER_ID`.

A loose drop into a container (`resolve_loose`, `shared/state/src/stack.rs`)
requires `owning_player(owner) == caller_player_id`; the world (owner `0`) is open.

## Open seams (expand here later)

Surface 2 is **declared, not yet wired** — the constant and its semantics exist,
but the runtime paths only handle surface 1:

- **Region sizing.** `region_distance` (`gateway/src/gather.rs`) sizes an
  inventory's disk by `fetch_card_def(owner)` → read the `inventory` aspect. That
  assumes `owner` is a card_id. For surface 2 the owner is a *player_id*, so the
  fetch misses and it falls back to `0` (single home tile). A surface-2 branch
  needs to source the radius from somewhere other than a card def.
- **Zone creation.** Nothing currently *creates* surface-2 zones; the DSL `place`
  path (`shared/rules/src/dsl_recipe.rs`) resolves an owner card, which is the
  card-id convention. Player-scoped placement will need its own owner resolution
  (player_id, not a card handle).
- **mini_zone (band 63)** is reserved but empty — re-implementation slots in just
  below `WORLD_LAYER` so stack-layout rules apply and world-only queries skip it.
