# G1 — Dirty-cell cold/hot tiled compositor

Status: **SUPERSEDED by [G4](g4_renderer.md)** (2026-06-20). G4 keeps G1's good half
(rectangular cell grid, per-cell light/prim indexing, static-light cache) and drops
G1's hardest third — the hot/cold per-prim **overlay machinery** (above/below context,
depth-split, cold↔hot graph) — replacing it with a depth buffer + dirty-rect recompute
+ a budgeted amortized work queue. Read G4 for the chosen plan; G1 is kept as the record
of the design exploration. Original status: design, iterating. Captures the renderer +
lighting architecture converged on 2026-06-20. Supersedes the D2/E *baking*
approaches explored in `shadow_lighting.md` (per-chunk baked-light buffer "scheme C",
the additive decomposition) — those fought the per-frame screen-space pipeline; G1
replaces that pipeline instead of patching it. The pieces that carry over from
`shadow_lighting.md`: the `Light` schema (`canBake`/`castsShadow`/tile-unit radius),
the geometry sidecars (Phase B — now also the source of G1's per-map bounds and
shadow occluders), and the projected-billboard shadow technique (Phase E → G1 Phase 4).

## Why (the constraints driving it)

The current lighting pipeline (`view/src/game/lighting/`) has no caching and a hard
light cap:

- Per render it does **~4 full-`panLayer` re-renders** (ground+object normal G-buffers,
  then ground+object albedo captures) + a screen-space light pass, **every frame it
  renders**, regardless of what changed. Pan, cursor move, or any tween triggers it.
- The light pass sums lights in **one shader with `MAX_LIGHTS = 16`** — a hard ceiling,
  recomputed continuously.

Dynamic lighting is central to the game, and the game wants **a large number of lights,
most of them static** (torches, campfires, etc.) plus a few dynamic (cursor, a moving
soul's lantern). The current pipeline fundamentally can't do that: 16 lights, per frame.
G1's whole point is to make **static lights effectively unbounded and free per frame**
(bake once per cell, never recompute until something in range changes) while keeping
the few dynamic lights cheap (relight only the cells in their radius).

Anticipated content mix: **more static (flora, trees, terrain) than dynamic** — exactly
the regime a cold/hot cache wins in.

## Core model

### Rectangular cell grid over the hex grid
Bookkeeping is done on a **uniform axis-aligned cell grid**, deterministic from `(q,r)`,
NOT on hexagons. A cell is `√3·R` wide × `R` tall (R = hex radius); a hex maps onto a
small constant number of cells (~4–6 depending on alignment — pin the exact dimensions
so the grid tiles the hex grid's vertical period `3R` cleanly; the "4" is approximate).
Hexagons stay a gameplay/coordinate concept; **the renderer never does hex math or hex
masking** in the bake path. Axis-aligned cells mean world updates are scissored
clear+draw directly into the target RT — **no scratch texture, no mask, no copy-back.**

### Every primitive held individually + bidirectional index
Prims are NOT pre-flattened. We hold:
- `cell → [prims]` (z-ordered) and `prim → [cells]`, so dirty propagation is O(1):
  a changed prim marks its cells dirty; a dirty cell re-composites from its prim list.
- **The per-cell z-ordered prim list is the key correctness device.** Re-compositing a
  cell from its full list automatically includes neighbour overhang in correct z-order
  and handles removal (cut a tree → drop it from its cells' lists → those cells rebuild
  from what remains). No runtime neighbour-gathering, no "affected hex" computation, no
  stale ghosts. This is what killed the earlier hex/neighbour-sim complexity.
- A cell on a tile boundary holds **both** tiles' ground prims, so the 1%-overscale
  overlap composites correctly inside the cell — the D1b.1b seam problem evaporates.
- A prim spanning cells A and B draws at the same world position in both (each clipped
  to its cell) → continuity across cell boundaries is free, no seams.

### Per-map tight bounds (mask ≠ graphics)
Every primitive's texture is a base-2 square with transparent padding; bucketing by the
full square would over-dirty huge swaths. So each prim carries a **per-map occupancy
box** — the minimum bounds of non-zero pixels, separate from the graphics texture —
computed in the **gate geometry pipeline** (we already do silhouette analysis there for
the sidecar; extend `bbox` to per-channel) and versioned/scaled like geo/LOD. Stored as
`{x, y, w, h}` relative to the master-square centre.
- Nuance: normal maps are flat-up (`#8080ff`) across the whole silhouette, so the normal
  box ≈ the albedo box ≈ the silhouette. In practice it's **two** boxes: silhouette
  (albedo+normal) and **emissive** (sparse — the real win; a torch's emissive is just
  the flame).

### Coarse z-sort by cell row
z = `floor(origin.y / R)` (the cell row the prim's origin sits in), NOT exact pixel-Y.
A prim only changes z-bucket on a **cell-row crossing**, not every sub-pixel — so a
moving prim doesn't churn the sort (or rebuild its overlays) every frame. Movers get
`floor(y/R) + 0.5` → above their own row and everything north, below everything south.
Caveat: collapses intra-row ordering for two prims whose origins land in the same R-tall
band; rare (band ≈ half a hex). If it ever flickers, fix with a *stable* secondary
tiebreak (exact-y or id) — consistency matters more than exactness.

### Cold vs hot
- **Cold = static AND settled.** Baked into the world maps; never redrawn per frame.
- **Hot = moving OR animating.** Tweening position/tint, a ticking progress bar, a card
  mid-drag, a soul mid-hop. Held individually so *just the animating prim* is hot while
  the rest of its tile stays cold (a static ground hex + a hot progress bar on top).
- Settle-then-bake: a hot prim/light bakes to cold when its animation settles (same rule
  as lights). Cold↔hot transitions are spiky (re-bake the prim's cells without it + build
  overlays) but bounded by count.

## World maps (the cold cache)

Per the **main world viewport** (see VRAM — not every viewport gets this):
- `world.albedo`, `world.normal` — content-dirty (re-composited from cell prim lists).
- `world.lit` — the lit cold world; light-dirty + content-dirty.
- Emissive packed into `normal.b` (XY-only normals reconstruct Z), lazy (unallocated
  until something emits).
- **Sizing: viewport + ~1 overscan ring, NOT full-world.** Pan scroll-copies the overlap
  to its new offset and bakes only the revealed band (terminal-scroll style) → memory
  stays viewport-bounded, pan cost is the edge band.

`display = lit only` — the final frame is `world.lit` (windowed/panned) + hot prims' lit
composited on top. **No `display.{albedo,normal,emissive}` full set** (dropped — big
memory save).

## Hot primitives

A hot prim is an object: `{ object[map], above[map], below[map], cellRow, set }`.
- `object[map]` — its own albedo/normal graphics.
- `above[map]` / `below[map]` — the **cold context** (albedo+normal) in the prim's cells,
  split at the prim's z. Footprint-sized (small). **Rebuilt only on cell-cross / when the
  underlying cold cell goes dirty — NOT per frame.** Lets the hot prim self-relight.
- Why both above and below: `world` is flattened (holds the cold prims that should be
  under AND over the hot prim with no way to insert between) — irreducible. The split is
  the floor.
- Per-frame composite (cheap, cached overlays): old rect ← restore `world.lit`; new rect
  ← `below → object → above`, lit. A few blits.
- **Cards/souls as prim SETS** (a card = a handful of prims acting as one unit). Group
  per-card now; group whole stacks only if stack-drags profile hot (deferred).
- Cost scales with **count of simultaneous hot prims** (overlay memory + per-prim
  composite), NOT with animation. Few movers → big win; ~everything moving → worse than
  today's flat full-redraw (treat that regime with a separate optimization if it arises).

## Lighting

- **Cold (the bulk):** each cell sums only the lights whose radius covers it, **once**,
  into `world.lit`; re-baked only when a light in range changes (or the cell's geometry
  changes). Static lights are therefore **effectively unbounded and free per frame** — a
  cell only ever sums its local handful. `cell → [lights]` index. Light radius in hex
  tiles → disk → cells.
  - A cell covered by **> `MAX_LIGHTS`** lights (radii pile up) bakes in **additive
    accumulation passes** (sum 16, add the next 16…). Cheap because it's a bake, not
    per-frame; the bake path must assume `lights-per-cell > MAX_LIGHTS` rather than clamp.
- **Dynamic (the few):** relight the moving light's disk cells per frame from
  `world.albedo/normal`. Bounded by `disk × dynamic-light-count`. This is the irreducible
  per-frame floor.
- Hot prims self-relight from their `above/below` albedo+normal context.

## Performance model

| Scenario | Work |
|---|---|
| **Idle** | ~0 — display the cached `world.lit` window |
| **Dynamic light moves** | relight its disk cells (irreducible floor) |
| **Hot prim moves** | restore old rect + composite new rect from cached overlays (few blits) |
| **Content change** | re-bake affected cells (coalesced), prim lists give correct z + removal |
| **Pan** | scroll-copy world maps + bake the revealed band (budgeted) |

- **Dominant cost is draw-call / RT-switch overhead, not fill-rate.** Many tiny updates
  = overhead-bound. **Coalesce dirty cells into bounding rects** and draw per-RT in one
  pass; merge rects when `area(union) < area(a)+area(b)+K` (K = overhead-equivalent
  fill). Budget = draw-batches per frame, not cells. Redrawing a few clean cells inside a
  bounding rect is cheaper than many small draws.
- **The lit flatten must also be dirty-rect** (only `display-dirty ∪ light-dirty` cells),
  or a full-screen pass sneaks back in and the win evaporates.

## VRAM budget

Failure mode is **WebGL context loss** (black screen / forced recreation), not a gentle
slowdown — budget against the tab's GPU allotment, not the card's total.
- Mobile / integrated: assume ~**256 MB**. Desktop-safe: under ~**512 MB**. ~**1 GB =
  redline** where weak machines lose context.
- One 1080p viewport texture: **8 MB (dpr1) / 33 MB (dpr2)**. Three world maps + overscan
  ≈ **~30 MB (dpr1) / ~130 MB (dpr2)** per viewport.
- The **atlas competes**: a 4096² RGBA page is **67 MB**; albedo+normal pages ≈ 134 MB+,
  plus the LOD cache. The texture working set is already large.

Levers, by payoff:
1. **Full pipeline only for the main world viewport.** Inventory/editor use flat/simple
   lighting — kills the ×viewports multiplier (the thing that blows the budget).
2. **Cap world-map resolution at ~dpr 1 (–1.5)** even on retina. Lighting is
   low-frequency; sprite detail comes from the atlas at full res. ~quarters map memory
   on a dpr-2 display for ~no visible cost. Probably the biggest safe win.
3. Drop the `display.*` set (done); pack emissive into `normal.b` + lazy-allocate.
4. Bound overscan to ~1 ring.
With (1)+(2): main viewport ≈ **~30–45 MB** of framebuffers, leaving the budget for atlas
+ LOD.

## Phasing (verifiable cuts — build in this order)

1. **Cold geometry.** Cell grid + prim/cell index + per-map bounds; bake **static** prims
   into cell-addressed `world.albedo`/`world.normal`; display the window; re-bake only
   dirty cells on content change; pan scroll-copies + bakes the revealed band. Cards/souls
   render in the existing live layer on top (temporarily always-on-top OK). **No hot, no
   new lighting yet.** Checkpoint: looks identical, idle does nothing, pan stays under
   budget.
2. **Cold lighting.** Per-cell light bake → `world.lit` (static lights, `cell→lights`
   index, additive accumulation for >16/cell), dirty-rect. Cursor as a dynamic dirty-disk
   relight. Checkpoint: cursor lights the ground (looks like today), only its disk
   re-lights; a static torch lights its area and never re-bakes on pan/idle.
3. **Hot prims.** Move cards/souls onto the hot path with `above/below` overlays →
   depth-correct movers (soul walks behind a tree). Checkpoint: dragging re-bakes only
   damage rects; depth is correct.
4. **Shadows.** Projected-billboard occluders rasterised into the affected cells' light
   bake (from the geometry sidecars). The `cell→lights` index already answers "which lights
   does this occluder affect."

## What's reused vs replaced

- **Reused:** retained-mode build-on-enter/drop-on-exit; the per-chunk containers
  (D1b.1a) are the natural storage/scroll unit for the cell-addressed world maps; the
  per-chunk albedo+normal bake (D1b.1b-i) is the seed of Phase 1; the `Light` schema; the
  geometry sidecars (→ per-map bounds + shadow occluders).
- **Replaced:** the per-frame screen-space normal/albedo capture + 16-light screen pass +
  multiply overlays. The two-layer split (D1a) folds into the cold/hot + cell model.

## Open questions ("think more")

- Exact **cell dimensions** so the grid tiles the hex period `3R` cleanly and the
  per-hex cell count is stable (the "~4" is approximate).
- Can `display` avoid being a stored RT (draw `world.lit`+hot straight to the
  framebuffer), or is a lit texture needed for post (bloom from emissive, etc.)?
- **Overlap of `world.lit` cold relight vs hot-prim self-relight** — exact division of
  labour and the premultiplied-alpha convention across the whole copy/composite chain
  (`scratch?/world → display`, `below→object→above`). **Nail the blend convention once,
  up front** — this is what bit "scheme C."
- **Large moving prims** (large AND dynamic) — the one case the overlay model is
  inefficient for. Rule of thumb "keep big things static, let small things move"; design
  a special path only if a real need appears.
- **Cold↔hot transition** cost and the settle-then-bake trigger for prims (not just
  lights).
- **Multi-viewport** policy — which viewports get the full pipeline vs flat lighting.
- **>16 lights/cell** accumulation-pass details (and the practical max lights-per-cell).
- Total **atlas + LOD + framebuffer** budget as one number per target device tier.
- Hot-prim count measurement deferred — game incomplete; design for the general case
  (more static than dynamic).
