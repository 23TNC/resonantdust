# World renderer — current state (x/y rect composite)

Status snapshot of the rect-composite world renderer. The old q/r per-chunk renderer was
stripped; this is the intended **x/y rectangle composite** substrate. Planning artifact:
`~/.claude/plans/squishy-stargazing-valiant.md`. Depth detail: `docs/depth_layers.md`.

## Architecture

- **Rect lattice** (`viewport/rects/rectMath.ts`): world-px grid, **W = √3·R (hex_width),
  H = R (hex_radius)**, offset 0,0 — aligns exactly to pointy-top (a hex = 1 col × 2 rows).
- **`RectComposite`** (`viewport/rects/RectComposite.ts`): a **multi-channel fixed-slot
  torus compositor**. Constructed with `ChannelSpec[]`; each channel owns a fixed
  `cols×rows`-slot RT that IS that channel's map (never slides). World rect `(wc,wr)` →
  slot `(mod(wc,cols), mod(wr,rows))`. The window moves DISCRETELY (anchor crosses a rect →
  only the wrapped trailing row/col re-bakes).
- **Bake** = per-rectangle, per-primitive. A dirty rect gathers its registered prims
  (`rectPrims` index), reparents them into a bake container, and for each channel renders
  each prim's portion (texture swapped per channel) into a 1-rect scratch, then
  `blendMode "none"` blits the scratch → the fixed slot. Objects span multiple rects; a
  change dirties all of them and each re-bakes every overlapping prim. Per-rect z-sort by
  `zIndex` (≈ feet-Y).
- **Display** (`viewport/rects/rectDisplayShader.ts` `GroundShader` + `fillDisplay`): the
  visible window is drawn as **≤4 quads** split at the torus seam (so no quad samples across
  the wrap — the seam-smear fix), per-vertex `aUV` carrying composite coords.

## Channels & lighting — LANDED

- **albedo** — every ground/tile prim + standing object's albedo, baked into the composite.
- **normal** — each prim's normal map (white-tinted), clears to flat-up `[.5,.5,1,1]`.
- **lightmap** (cold) — `ambient + Σ cold lights · N·L · falloff²`, baked PER-RECT in WORLD
  space (`rectLightBakeShader.ts`), so it pans for free. `dirty_light` set (`lightDirty`)
  re-bakes a slot when its normal re-bakes OR a cold light changes (`MAX_COLD_LIGHTS=32`).
- **depth** — per-object modular sort key `(R,G,B)`. See `docs/depth_layers.md`.

Lighting model: **cold** lights bake into the lightmap; **hot** (dynamic) lights apply
LIVE in the display shader each frame — `lit = albedo × (lightmap + Σ hot)`,
`MAX_HOT_LIGHTS=8`, `hotLights[0]` follows the cursor. Ambient lives in the lightmap.

## COLD vs HOT — the split (and the open edge)

The composite is the **COLD** world: static tiles + objects, baked once, re-baked only on
data change or reveal. **HOT** = dynamic things that change every frame.

- **Hot LIGHTS**: done — summed live in the display shader, no re-bake.
- **Hot PRIMS (movers)**: NOT done. Cards/souls live in `cardLayer`, drawn **above** the
  composite with **no depth interaction** — a mover always draws over the world, so it
  can't walk *behind* a tree/stack yet. This is the open piece.

### Open question — how hot prims get depth occlusion

The depth RT (`depthRT`, the cold key) exists; the consumer does not. Two shapes on the
table (no decision yet):

1. **Per-mover sample + discard.** Each mover sprite samples `depthRT` at its screen pos in
   its own shader and `discard`s fragments where the cold key is in front of the mover's key
   (mirroring `depthFront`). Simple, but every mover needs the depth-aware shader and its
   own per-fragment key.

2. **Hot G-buffer + merge pass (the user's framing).** Render all hot prims to a SEPARATE
   per-frame map each frame (hot albedo + hot depth, maybe normal). Then a final composite
   pass walks each screen pixel and, comparing **hot depth vs cold depth**, writes either the
   hot prim or the cold composite. This keeps movers out of the bake entirely and makes the
   hot/cold merge a single uniform pass — symmetric with how hot *lights* already layer onto
   cold lightmap. Cost: an extra full-screen hot buffer + merge each frame.

Either way the comparison is `depthFront` (band → primary key, wraparound R, etc.) and the
mover builds its own `(R,G,B)` (R,G from feet world-Y; B = its layer, e.g. `BLUE_OBJECT`).
Direction 2 is the cleaner fit with the deferred-shading structure already in place, but
it's unchosen — pick before building.

## Deferred work

Forward plan: **[G7](g7_renderer.md)** (hot/cold prim merge + stacked-tile depth).

- **Hot prims / mover depth occlusion** — the open question above (next big piece; G7-A).
- **Depth: tiles + hex stacks** — `bakeRect` still skips all `groundLayer`; flip to "skip
  only flat unstacked base" so raised stack members occlude. Raised cards stamp the TILE's
  ground feet-Y in R,G; elevation → B. Drive B push-down from the stack. Bake sort by the
  full `depthFront` key once >1 band/blue is in play. (`docs/depth_layers.md`.)
- **Tighter prim footprints** — per-prim atlas sub-rect copies (perf refinement).
- `emissive` channel — stubbed, empty.

## Verifying

`?rectview` draws the red rect grid. `/showRT` (chat command) opens the RT debug panel for
the ACTIVE viewport (click the World viewport first). Notes: the depth RT only re-bakes
DIRTY rects, so after a code change it shows STALE bytes until a re-bake — **reload** for a
full fresh bake. Canvas pixel-readback is blocked (`preserveDrawingBuffer:false`, no
`window` renderer handle) — `/showRT` is eyeball-only.
