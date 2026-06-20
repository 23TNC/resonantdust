# Shadow lighting + geometry sidecars

Status: **in progress** — Phases A, B, C done; **Phase D starting** (D1 two-layer
split). This is the source of truth for the build; it supersedes the earlier
per-light-RT sketch.

## Goal

Cast shadows in the deferred lighting pipeline: a shadow darkens **one light's**
contribution where an occluder blocks it, while other lights still illuminate the
pixel. Extruding/projecting shadows needs silhouette polygons we don't currently
have, so the work splits into geometry generation and a lighting rearchitecture
that the shadows plug into.

## Converged architecture

### Lighting: baked per-macro_zone, not per-frame screen-space
Today lighting is one screen-space pass summing ≤16 lights per pixel every frame
(`view/src/game/lighting/`). That caps lights at 16 and recomputes everything
every frame.

We move to a **persistent world-space light texture per macro_zone**, updated
**incrementally** only where lights/occluders changed. Rendering a zone becomes
one texture read (`albedo × zoneLight + emissive`); unchanged lights cost nothing
per frame. This fits the existing retained-mode world render (build on zone
enter, drop on exit, re-render only on data change) — the light texture is just
another per-zone resource with that lifecycle.

- **Bake by default.** Lights bake into the zone texture. Two opt-outs:
  `casts_shadow` (default on) disables a light's shadow; `can_bake` (default on)
  forces a light to stay in the **live screen-space pass** instead of baking —
  set for the cursor light and anything that moves every frame (baking a
  per-frame mover would re-dirty its region every frame, i.e. the old cost plus
  overhead).
- **Settle before baking.** A moving light isn't baked until it settles, so we
  don't bake lights mid-motion. Souls move in discrete tile steps → they bake and
  re-dirty per step.
- **Ambient** is the zone texture's init value — unshadowed by construction, no
  per-frame cost.

### Dirty model: regions, not lights (non-transitive)
The dirty unit is a **region** (a light's range), not a light. Recomputing a
region clears it and **re-accumulates every light overlapping it**. When light A
changes, its range is dirty; lights B, C overlapping A's range are *inputs* to
that re-accumulation — their own regions are untouched, and we do **not** chase
B's/C's other neighbours. Occluders are symmetric: a moved blocker dirties the
ranges of the lights whose radius covers it; each such region then re-accumulates
its own overlapping lights.

### Amortize + prioritize the dirty-region queue
- Re-bake **K regions per frame** by priority; clean regions never re-bake.
- **Priority order:** cursor (live, not baked) > souls (move often, focus) >
  static torches/campfires. **Age** waiting regions so high-frequency dirtiers
  (cursor/souls) can't starve a one-time-dirtied torch.
- Worst case (everything dirty) drains over `dirty / K` frames — bounded
  staleness, framerate preserved. The lag lands on low-priority/distant things
  by construction.

### Tile-unit radius + per-tile light index (the spatial backbone)
Light radius is stored in **hex-tile units** (float), with the photometric
falloff derived as `radius × hexSize` px so the smooth circle is unchanged.
Two distinct jobs, deliberately separated:
- **Index (discrete, tiles):** the affected set is a hex disk of `ceil(radius)+1`
  tiles — integer hex math, no per-pair distance. The `+1` covers object overhang
  (objects may extend past their tile by ≤1 tile — a **content constraint to
  enforce**) and the light's own sub-tile offset.
- **Photometric (continuous, px):** `radius × hexSize`, euclidean circle in the
  shader. Unchanged visually.

**Inverted index `tile → [lights]`** is the keystone structure:
- region re-bake participant set = union of the light-vectors over the region's
  tiles;
- occluder → affected lights = the moved blocker's tile light-vector;
- light move = remove from old disk's tiles, add to new disk's, dirty both.

`hexSize` (`hex_radius = 86`, content global) is content-space constant; zoom is
the camera container's job (retained-mode), so `tiles × hexSize` is zoom-stable.
Light is indexed by its **containing tile**; it is **shaded at its real sub-tile
pixel position**.

### Shadows: projected billboard, rasterized triangulation (no stencil)
Treat each caster as a card standing upright at its ground-contact line; project
its silhouette through the light onto the ground (z=0) — a shear: direction
`normalize(occluder.xy − light.xy)`, length ∝ `occluder_height / light.z`
(uses the same `z` the N·L term uses), anchored at the base. Rasterize the
**earcut triangulation** of the occluder into the light's region (holes excluded
by earcut, overlaps unioned by the rasterizer) — **no stencil/even-odd**.
Rejected: radial silhouette extrusion (mismatches the billboard/normal model;
it's really a vision/line-of-sight primitive — a separate future feature off the
same contours).

### Geometry sidecars (gate-generated, master-derived)
Per-sprite silhouette polygons from the master alpha, **size-independent** (not
per-LOD — silhouette fidelity tracks screen size, not texture mip; per-LOD would
7× a bundle we block on at login). Coordinates normalized to the sprite content
box. **Separate from the manifest** (a derived render artifact, not authored
content) but co-versioned and co-loaded.

Schema (per sprite frame):
```
{ "bbox":[w,h], "color":"#rrggbb",
  "contours":[[x,y,…],…], "holes":[[x,y,…],…], "triangles":[i0,i1,i2,…] }
```
Pipeline (Rust, in the gate, reusing the LOD path's master-fetch/lock/srchash/R2
write-back): decode alpha → threshold/downsample → marching-squares (incl. holes)
→ Visvalingam–Whyatt (protected extrema, hole preservation, max silhouette-error)
→ earcut → dominant colour. `triangles` also drive the placeholder (below).

- *Internal:* per-object cache `textures/geo/<stem>.json` (editor-friendly:
  one-card edit recomputes one piece).
- *External:* one `GET /geo/bundle.json?v=<content-hash>`, assembled from the
  cached pieces, co-versioned with the manifest, **blocked-on at login**. Size
  threshold → fall back to lazy per-object if the catalog outgrows it (log it).

### First-frame placeholder — SHIPPED (stable-frame model, supersedes the swap design)

The original sketch here (bake a triangulation blob as a throwaway no-normal
`LitSprite`, then **swap** to the real sprite once art lands, gated on a
`hasContent` check) was replaced during implementation by a single-frame model
that's strictly better and needs no swap:

- **One stable atlas frame per `stem@size`.** `LodTextureManager.getPair` allocates
  exactly one frame and the sprite binds it **once, for life**. The frame's pixels
  are rewritten in place across tiers — geo → preview → real LOD — so the upgrade is
  invisible to the sprite (no texture swap, no reconcile, no `hasContent` branch in
  `TexPrim`). `getPair` returns the transparent fallback only until the very first
  tier (geo/preview/real) exists.
- **Frame mechanism (`TextureManager.packResizable`).** A stable slot in the SHARED
  atlas (so all object sprites still batch into one draw — this must scale to
  thousands of objects). `rewrite(albedo, normal, emissive)` fills the slot per
  tier. Each fill is **clear-the-slot-then-draw**: the slot is zeroed with a
  `gl.scissor` + `glClear` (the minimal way to reset one atlas slot without
  touching its neighbours) so the new tier fully replaces the last instead of
  source-over compositing onto it. The geo tier renders the earcut triangulation
  (filled `color`) with a flat-up normal; preview/real overwrite it in place.
  - **Gotcha (cost us a long debug):** the `erase` blend mode is a **no-op when
    rendering to a RenderTexture** in this WebGL backend — it composites as an
    opaque white fill. The original rewrite used an erase-quad to clear the slot,
    which left every geo/preview frame sitting on a white block. `gl.scissor` is the
    reliable per-slot clear; freshly-created atlas pages are also cleared transparent
    on creation (uninitialised GPU memory is otherwise opaque-white garbage).
- **Still NOT a raw `Graphics`/`Mesh` in the world container** (the original finding
  holds): the geo fill is baked into the atlas frame and drawn as the same
  no-normal `LitSprite` as any fill — hidden in the normal pass, ambient+falloff lit
  — so it never writes its colour into the normal G-buffer.
- **Geometry preload still matters.** `GeometryStore` is threaded onto the game
  context + `PrimDeps`, wired to `LodTextureManager.setGeometry`, and its `onLoad`
  shares the `texturesDirty` redraw. The login bundle / `prewarm` is still the win
  for resident-before-render geometry (currently lazy per-object via `get`).

Verified in-browser: shared atlas (one source across 248 objects + tiles),
transparent slot backgrounds, geo→preview→real upgrades in place, no white. Phase C
is **done** (and improved over this sketch).

## Phasing (dependency- and risk-ordered)

- **A — Hex/tile radius + light schema (view).** Radius → float tile units, px via
  `×hexSize`; light fields `casts_shadow`/`can_bake` (default on), `dirty`,
  `priority`; settle-before-bake notion. Observable on current lighting (lights
  unchanged) → self-validating. *The per-tile index lands in D, where its consumer
  (region participant resolution) exists — building it now would be unvalidated.*
- **B — Geometry sidecars (gate).** **Start with the `earcutr` / `rust:slim` build
  spike** (can invalidate the approach). Then `geometry.rs`, per-object cache,
  `/geo/bundle.json` assembly.
- **C — Block-on-load + placeholder (view). ✅ DONE.** Shipped as the stable-frame
  model (see "First-frame placeholder" above) — geo→preview→real rewritten in one
  atlas slot, no swap. Geometry still fetched lazily per-object (login bundle =
  later optimization). **Decision gate passed: pursuing D+E (full relight).**
- **D — Baked per-macro_zone lighting (view).** The heavy rearchitecture, split:
  - **D1** baked zone textures reproducing *today's output* (incremental bake, no
    shadows) — "looks identical + perf holds" checkpoint;
  - **D2** dirty-region queue + priority/aging + hybrid live pass + per-tile index.
- **E — Shadows (view).** Projected-billboard shadows from B's geometry, masked
  into D's regions.

## Complexity & performance budget (per phase)

- **A:** trivial, low-risk; radius-unit change is observable, index deferred.
- **B:** server CPU (one-time, cached); risk is in-house geometry correctness +
  the pure-Rust earcut dep (`rust:slim`).
- **C:** one small blocked-on bundle at login (CDN-cached after); transient
  placeholder `Graphics`. Low.
- **D:** the invasive change. New cost moves from per-frame fill (**gone**) to
  **VRAM of resident zone light textures** + **re-bake cost of dense dirty
  regions** — both bounded by viewport and local light density, not total light
  count. Open decisions: bake resolution (hard shadow edges want resolution);
  store world-normal per zone vs re-render the region's normals on demand;
  cross-zone writes for border lights.
- **E:** projected-triangle build per dirty caster-region (CPU) + raster (GPU),
  amortized by the dirty queue. Bounded by tier-1 (close/important) caster count,
  not total lights.

## Open questions
- `earcutr` (or equivalent) pure-Rust + builds in `rust:slim`?
- PIXI v8 cheapest path for the region re-bake (sub-rect render-texture writes,
  blend for the zero-the-texels shadow draw).
- `occluder_height` source: derived sprite-px-height × scale, or explicit
  `:visuals` value? (also decide if `height` moves to tile units for designer
  consistency — currently px).
- Bake resolution vs shadow-edge sharpness; world-normal store vs re-render.
- Does mask/region invalidation ride existing card-move / zone-dirty signals or
  need new bookkeeping?
- Surface `casts_shadow`/`can_bake` through the `^light` DSL when light authoring
  actually lands (no `^light` content exists yet).

---

## Handoff — 2026-06-19

### RESOLVED (for real): the bright "ambient line" tracing every hex
**The line was a literal stroked outline, not a lighting artifact.** `buildTile`
drew a per-tile hex `Graphics().poly(…, worldHexRadius()).stroke({ color:
TILE_OUTLINE_COLOR /* 0x2a3038 */, width: 1, alpha: 0.6 })` at full cell radius —
"viewport chrome" so the empty grid read as cells. `0x2a3038` is *lighter* than the
tile fills once the ambient multiply crushes those toward the `0.12` floor, so it
popped as a light hairline on near-black tiles. It tracked every hex regardless of
tile size and survived a 10px mask inset (it's drawn at full radius, independent of
the mask) — which is what finally identified it.

**Fix (applied this session):** delete the outline in `buildTile`
(`view/src/game/viewport/WorldRenderer.ts`) → `root.addChild(bg)` only.
`TILE_OUTLINE_COLOR` is now unused.

### Misdiagnoses from the 2026-06-18 chat — REVERTED, do not re-add
The previous handoff claimed the line was the deferred overlay using the albedo's
**AA alpha ramp** as coverage, "fixed" by `coverage = ceil(...)`. That was wrong;
all of it has been reverted:
- `deferredLightShader.ts` — `ceil` coverage **reverted** to `coverage = texture(uAlbedo, vUV).a`. The `ceil` did not fix the line (it was the outline) and broke tile lighting.
- `TextureManager.ts` + `DeferredLighting.ts` — **NEAREST** normal-page / G-buffer
  filtering **reverted** to linear. It fixed nothing and introduced visible jaggies
  on lit sprites. (If normal-map bilinear bleed is ever a *real* problem, revisit
  deliberately — but it was not the cause here.)
- `content/visuals/functions/01.rd` — `hex_radius` 86 → 87 is **committed** (`7a6f192`)
  and **kept** as an independent ~1px tile-overlap anti-seam measure. Keep synced with
  `WORLD_HEX_RADIUS` in `hexSize.ts`. Not related to the outline line.

Lesson for the next session: when a "lighting line" tracks geometry exactly and is
scale-invariant, **rule out a literal drawn stroke/outline before theorizing about
the shader.** Grep the tile build path for `.stroke(`/`Graphics` first.

### Working-tree state at handoff
Committed (branch `0.7`):
- `7a6f192` — NEAREST normal sampling (now reverted in-tree) + `hex_radius` 87 +
  doc/version bumps. (The NEAREST part is superseded by the revert above.)
- `cfedc06` — stable-frame LOD placeholders (geo→preview→real in one shared-atlas
  slot; the `erase`-blend-to-RenderTexture gotcha is in §First-frame placeholder).
- `3a0906b` — hex-clip re-bakes on content-tier advance.

### Agreed forward design (the one useful thing from the prior chat — don't relose it)
For Phase D (incremental, scalable lighting), we converged on:

1. **Two layers, not one combined G-buffer.** Tile layer and object layer get
   separate albedo/normal(/emissive); light each separately; composite object-lit
   **over** tile-lit by object coverage. A single combined normal re-merges them and
   re-creates edge contamination. (With the `ceil` coverage fix the *current* single
   buffer is acceptable for now; two-layer is the clean target.)
2. **Z-ordering is solved by the hexagon clip, for free.** Grounds never overlap
   (no z-order). Clip every object to the hexagons it covers → each pixel is owned by
   exactly one hex, which sorts its own bounded overlap set by world-Y; hexes
   tessellate so an incrementally redrawn hex can't conflict with un-redrawn ones.
   So the object layer is the only thing that sorts, and it sorts locally.
3. **Per visible macro_zone, pooled RTs, world-space @ zoom 1**, composited to screen
   by the `panLayer` transform → pan/zoom are free; only changed hexes re-bake. (Not
   a literal world RT — unbounded. Not per-hex RTs — too many textures.)
4. **Per-hex, per-channel dirty bitmask**: `albedo`/`normal`/`emissive` (geometry
   changed → redraw that channel for the dirtied hex + its 6 neighbours, since
   objects overflow ≤1 ring) and `light` (the set of lights covering the hex changed
   → re-run the light pass only, against the stored normal — the cheap common case).
   Lights carry a tile-unit radius; the inverted `tile → [lights]` index drives the
   `light`-dirty set (symmetric difference of old/new disks on a move).
5. **Dynamic lights (cursor, fast movers, `canBake:false`)** stay in a small per-frame
   live pass over the baked zones; everything else bakes.

### Next steps
- **D1a — two-layer split in screen-space/per-frame. IMPLEMENTED 2026-06-19,
  in-tree, NOT yet browser-verified.** `LitSprite.groundLayer` tags hex-clipped
  grounds (`HexTileVisual` + `TexPrim` `clippedHex`) vs standing objects;
  `DeferredLighting` now renders GROUND and OBJECT normals + albedos into separate
  buffers, lights each, and `WorldRenderer` stacks two multiply overlays. Coverage
  is disjoint: object overlay = `objA`; ground overlay = `groundA × (1 − objA)`
  (new `uOther`/`uSuppress` in `deferredLightShader`), so nothing double-dims. The
  live `panLayer` display path is unchanged. **Verification target: looks identical
  to single-layer** (the split's payoff is clean object/ground normal edges, not a
  visible change). Cost: 6 screen passes/frame vs 3 — acceptable pre-bake; D1b
  removes the per-frame cost.
- **D1b.1a — per-zone ground containers. IMPLEMENTED 2026-06-19, in-tree, NOT yet
  browser-verified.** Each world tile's GROUND (its `bg` fill + `clippedHex` art
  prims) now routes into a per-macro_zone `Container` (`WorldRenderer.zoneContainers`,
  keyed `chunkQ,chunkR` via `zoneKey`, parented under `tileLayer` so it sorts below
  objects); OBJECT prims stay in the shared `sortLayer`. `PrimitiveLayer` gained an
  optional `groundTarget` and routes per-prim by `LitSprite.groundLayer`; the
  per-tile `root` Container is gone (`bg` carries absolute world px). This gives the
  bake a clean per-zone unit to render with no registry-hiding. **Verification: looks
  identical** (pure reparent — grounds tessellate, render below objects as before).
- **D1b.1b**: bake each zone container into a world-space RT (albedo + stored
  normal), light it zone-locally, composite the lit result by the pan transform;
  ground leaves the screen-space overlay path. Checkpoint: looks identical + panning
  triggers zero re-bakes.
- **D1b.1c**: fold the object layer into the same bake (or keep per-frame if perf is
  fine — decide at the checkpoint).
- **D2**: dirty-region queue (K hexes/frame, priority/aging) + the per-tile light index.
- **E**: projected-billboard shadows from the geometry sidecars, masked into D's regions.
