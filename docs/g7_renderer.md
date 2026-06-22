# G7 — Hot/cold prim merge on the rect composite

Status: **plan.** Forward plan for the **x/y rect-composite** renderer (the substrate that
replaced G4's q/r per-chunk storage). The composite substrate + its static (COLD) channels
are built and browser-verified — see **[rect_renderer.md](rect_renderer.md)** for the
as-built state and **[depth_layers.md](depth_layers.md)** for the depth key. G7 is the
**dynamic half**: giving moving prims (movers/souls) correct depth occlusion against the
cold world, plus finishing depth for stacked tiles. It is the rect-composite analogue of
G4's "depth buffer for dynamic-vs-static occlusion" — recast for the composite + the
modular layer key.

## Where we are (the floor G7 builds on)

- Fixed-slot torus composite, per-rect/per-prim bake, ≤4-quad seam-split display.
- COLD channels baked: **albedo, normal, lightmap (cold lights), depth** (`(R,G,B)` modular
  layer key, `depthFront` comparison).
- HOT **lights** apply live in the display shader (`lit = albedo × (lightmap + Σ hot)`).
- HOT **prims** do NOT exist yet: cards/souls draw in `cardLayer` *above* the composite with
  no depth interaction — a mover always covers the world, can't walk behind a tree/stack.

## Phase A — Hot prim G-buffer + depth merge (centerpiece)

Symmetric with how hot lights already layer onto the cold lightmap: don't bake movers into
the composite; render them to a **per-frame hot G-buffer** and merge against the cold world
by depth in one pass.

Chosen direction (the "separate hot map + merge" approach; the per-mover sample-and-discard
alternative is rejected — it spreads a depth-aware shader across every mover and forfeits a
uniform merge):

1. **Hot G-buffer.** Each frame, render all movers (currently `cardLayer`) to screen-sized
   RTs: **hot albedo** (+ alpha) and **hot depth** (the same `(R,G,B)` key, built from the
   mover's feet world-Y for R,G and its layer for B, e.g. `BLUE_OBJECT`). Normal only if
   movers need to be lit by the same hot/cold lights (likely yes → hot normal too).
2. **Merge pass** (extends `GroundShader`, or a final full-screen pass). Per pixel: sample
   cold composite (albedo/normal/lightmap/**cold depth**) and the hot G-buffer
   (albedo/**hot depth**/alpha). If the hot fragment is present AND `depthFront(hot, cold)`
   says hot is in front → output the (lit) hot prim; else output the cold world. Movers thus
   correctly slot **behind** taller/souther cold objects and stacks.
3. **Lighting parity.** Light movers with the same `lightmap + Σ hot` so a soul under a cold
   fixture is lit like the ground. Either sample the lightmap at the mover's world pos in the
   merge, or fold movers into the lit math before the merge.

Deliverable: a soul walks behind a tree / a hex stack and is occluded per pixel, while still
drawing in front of things it's souther than. Verify in-browser (`/showRT` hot channels +
the live scene); confirm the occlusion flips at the right ground line and across a stack.

### Risks / open
- **Cost**: an extra screen-sized hot buffer + merge each frame. Acceptable (movers are few),
  but the hot RTs should be viewport-sized, not world-sized.
- **Mover normals/shadows**: do movers cast/receive? G7-A does receive (lit); casting is out.
- **Self-overlap of movers**: hot depth resolves movers against each other too (sorted
  overwrite within the hot pass, same `depthFront`).

## Phase B — Depth for tiles + hex stacks (the layer key's consumer)

Make the cold depth correct for stacked cards so Phase A's merge occludes against them.

- Flip `bakeRect`'s `groundLayer` skip from "skip ALL tiles" to **"skip only the flat,
  unstacked base."** Raised stack members write depth.
- **The trap**: a raised card stamps the **tile's ground feet-Y** into R,G (NOT its raised
  sprite bottom-edge, which mis-tags it a row norther). Elevation lives in **B** only.
- Drive **B push-down** from the stack: lone tile = `BLUE_HEX_TILE` (30); each added card
  takes a slot toward 0, pushing the tile down; top card frontmost.
- **Bake sort**: once >1 band/blue is in play, sort the bake by the full `depthFront` key
  (today `zIndex` ≈ feet-Y is a correct proxy while everything is one band).

## Phase C — Polish / perf

- Per-prim **atlas sub-rect** copies (tighter than the current block scratch) if profiling
  asks.
- `emissive` channel (stubbed empty) if/when authored emissive prims exist.
- Revisit hot-buffer sizing + the 1px torus-seam bleed mitigation (deferred from M1).

## Sequencing

B unblocks A's correctness against stacks, but A is demonstrable against cold *objects*
(trees) before B lands. Recommended: **A (objects) → B (stacks) → A re-verify against
stacks → C**. Lock the Phase-A direction (hot G-buffer + merge) before building.
