# G4 — Baked-lightmap deferred renderer with dirty-rect amortization

Status: **building — Phases 1–3 landed & browser-verified (branch 0.7).** G4 is now
**the** renderer: the old screen-space deferred pipeline and the `?g4` flag are removed.
See **[Build log](#build-log-as-built)** for what's actually shipped (and where it diverged
from the plan below — notably **per-chunk storage, not the scrolled map**). Supersedes
**[G1](g1_renderer.md)** (the bespoke
cold/hot tiled *compositor*) and the D2/E baking approaches in
[shadow_lighting.md](shadow_lighting.md). G4 keeps G1's good half — the rectangular
cell grid, per-cell light/prim indexing, the static-light cache — and **drops G1's
hardest third**: the hot/cold per-prim overlay machinery (above/below context,
depth-split, cold↔hot prim graph). Those are replaced by three established, simpler
pieces: a **depth buffer** (for dynamic-vs-static occlusion), **dirty-rect recompute via
multiply** (for the lit composite), and a **budgeted amortized work queue** (for graceful
overload). G4 is a composition of standard techniques, not a bespoke engine.

## Build log (as-built)

What has actually shipped, and where it diverged from the [Implementation plan](#implementation-plan-from-the-d1b1b-i-checkpoint) below. The plan is the design intent; this section is the source of truth for the current code.

### Decision reversal: per-chunk storage, NOT the scrolled map

Phase-0 decision #2 (and the VRAM section) chose a **single viewport+overscan scrolled
map per channel** (~40 MB) over **per-chunk RTs** (called out as "hundreds of MB"). **The
build reversed this — storage is per-chunk.** Each loaded ground chunk (`GROUND_CHUNK = 8`
tiles, the D1b.1a unit) owns its own detached container and its own `albedo / normal / lit`
RTs, displayed via a plain `Sprite` at the chunk's world origin. Why the reversal:

- **Pan is free.** Chunks are detached containers shown at their world origin, so pan just
  moves the parent container — **no per-pan bake, no scroll-copy, no wrap/addressing math.**
  A chunk bakes once on load and is untouched until its geometry or an in-range light
  changes. The scrolled map's scroll-copy-overlap-+-bake-the-revealed-band was the plan's
  *riskiest* item (P0/P1); per-chunk deletes that subsystem outright.
- **Reuses a working lifecycle.** Build-on-enter / drop-on-exit + per-chunk containers
  (D1b.1a) and the per-chunk albedo+normal bake (D1b.1b-i) already existed and were
  verified. Per-chunk storage carries those forward instead of building new machinery.
- **Dirty is naturally localized.** Each chunk owns its `dirty` (geometry → re-bake
  albedo+normal+lit) and `lightDirty` (light only → re-bake lit from cached albedo+normal)
  flags. "Re-light the chunks the cursor disk overlaps" is a clean per-chunk op — no
  coalescing dirty cells inside one shared texture.
- **One less premultiply trap.** The scrolled map blits premultiplied *lit* texels on every
  pan — another place the scheme-C premultiply convention must be exact. Per-chunk never
  moves lit pixels; each chunk's lit RT is computed in place and displayed directly.

**Cost accepted: VRAM.** Per-chunk is 5 channels × N loaded chunks, each chunk rounding up
to its own RT (partial-chunk padding waste) vs one tight viewport map. But it is **not** the
worst-case "hundreds of MB": drop-on-exit bounds the live set to viewport + overscan chunks,
so it's that bounded set × padding overhead. Mitigated by the same levers the [VRAM
budget](#vram-budget) lists (dpr-cap, main-world-viewport-only, channel packing). With
drop-on-exit already bounding memory, trading the VRAM gap for "delete the riskiest
subsystem + reuse working code" was the better deal — and it matches the "implement whatever
the final form is, don't retain legacy code" directive (keep the lifecycle that worked, no
parallel scroll machinery).

Other plan divergences: there is **no `CellGrid` / render-rect grid yet** — the chunk is
currently the dirty unit, not sub-chunk cells. The cell grid + `cell→[lights]` culling
(Phase-0 #1, the substrate) is deferred until it's needed (Phase 5 budgeting / many static
lights); `packChunkLights` currently evaluates **all** lights per chunk (`TODO(perf)` in
code). `static.depth` and per-map tight bounds are not built yet (Phase 4 / gate work).

### Phases landed

- **Phase 1 — per-chunk static ground** (`3b6bdc8`, browser-verified). Ground prims grouped
  into per-chunk detached containers; baked to world-space `albedo` RTs at flat ambient and
  displayed as plain sprites. Idle = no work; pan = container move.
- **Phase 2 — per-chunk static lightmap** (`b19e8a2`, browser-verified). Each chunk's
  displayed map is `albedo × (ambient + Σ static lights)`, baked once. `deferredLightShader`
  repurposed to **output lit albedo** (was a screen-space light buffer); `DeferredLighting`
  stripped of the dead screen-space passes (`renderNormals/renderLights/renderEmissive/
  LayerBuf/resize/packLightUniforms`), gained `bakeChunkLit` + `packChunkLights` (lights
  summed in **chunk-local** px, zoom 1). Verified: a fixture light casts a static radial
  lit pool that costs zero per frame and survives pan.
- **Phase 3 — dynamic cursor light** (`73bc267`, browser-verified). Chunk dirtiness split
  into `dirty` vs `lightDirty`; `markCursorChunks()` flags the chunks the cursor's disk
  (`cursorDisk()`) overlaps `lightDirty` **only on cursor move** (a still cursor re-bakes
  nothing), plus the chunks it just *left* (restore). Verified: the cursor light tracks the
  pointer, re-lighting only its disk of chunks, while a separate static fixture light stays
  put and free — the static-baked + dynamic-live split working end to end.

### Known temporaries / loose ends in the shipped code

- **Temp fixture light** (`WorldRenderer.g4Fixture`, placed at the anchor) stands in until
  real authored `^light` cards exist; it also lights the **inventory** viewport (the
  renderer runs per-`WorldRenderer`). Both temporary.
- **Objects are flat-dimmed** via `sortLayer.tint` (an ambient-gray stopgap) until Phase 4
  lights them properly; restoring real object lighting is a Phase-4 task.
- **Dev gotcha:** after large edits / file deletions, stale vite HMR once falsely broke pan
  — cache-bust the reload (`?cb=N`) when behavior looks wrong post-edit.
- Remaining dead code in `DeferredLighting` to finish extracting per the legacy-removal
  directive; `>16` lights/cell accumulation and the `cell→[lights]` index still TODO.

## Why (unchanged from G1)

Current pipeline (`view/src/game/lighting/`): no caching — ~4 full-`panLayer` re-renders
+ a screen-space light pass **every frame**, with a hard **`MAX_LIGHTS = 16`**. The game
needs **dynamic lighting as a core mechanic with a large number of lights, most of them
static** (and most content static), plus a **handful dynamic** at any moment. Workload
shape: ~64 lights and ~64 prims *may* move, but typically only a **handful actually
move** at once. The current pipeline can't do many lights, and recomputes everything
every frame regardless of what changed.

## The established techniques G4 composes

- **Deferred shading** — albedo + normal G-buffer → light pass. (Already present.)
- **Baked lightmap** — all *static* lights collapsed into **one** summed light buffer;
  sampled once per frame, independent of static-light count. The enabling mechanism for
  "a ton of static lights."
- **Tiled light culling** — `cell → [lights]`; a cell evaluates only its overlapping
  lights (the 2D form of tiled/clustered deferred). Handles many *dynamic* lights too.
- **Depth-buffer occlusion** — dynamic prims depth-test against the static world's
  sort-Y. Replaces G1's above/below overlays for "soul walks behind tree."
- **Dirty-rect recompute** — only regions a dynamic light/prim touches are recomputed;
  the rest is a cached blit. Done by **multiply** (`albedo × light`), never additive —
  sidesteps the premultiplied-alpha trap that broke "scheme C."
- **Amortized dirty-region queue** — a per-frame work budget with priority + aging;
  overload degrades to *staleness*, not frame drops.

## The render-rect grid (the dirty/cache substrate)

Bookkeeping is on a uniform **axis-aligned cell grid** ("render_rects") deterministic
from `(q,r)`, NOT on hexagons. **Hexagons stay the gameplay/coordinate system; cells are
the rendering + dirty system.** Convert at the boundary (a tile, or a light's hex-disk →
the cells it covers → coalesced dirty rects). Rationale:
- GPU **scissor / clear / blit are axis-aligned** — you can't scissor a hexagon; every
  dirty op is a rectangle.
- **Coalescing** adjacent dirty cells into a bounding rect (one batched pass) is trivial
  on a rect grid — needed because the dominant cost is draw-call/RT-switch overhead, not
  fill. Merge cells when `area(union) < area(a)+area(b)+K` (K = overhead-equivalent fill);
  redrawing a few clean cells inside a bounding rect beats many small draws.
- Deterministic `(q,r) → cells`, and a prim's square bounds → cells, both direct.

Cells carry two things only (G4 sheds G1's per-cell compositing logic):
1. **Dirty-rect quantization** for every recompute/transition/pan/restore.
2. **Indices:** `cell → [static prims]` (z-ordered — re-baking a cell's static albedo/
   normal reads exactly what's in it, overhang included) and `cell → [lights]` (the
   lightmap bake + a hot light's disk re-bake know which lights apply).

### Per-map tight bounds
Each prim's texture is a base-2 square with transparent padding; bucketing by the full
square over-dirties. So each prim carries a **per-map occupancy box** — the minimum bounds
of non-zero pixels, separate from the graphics — computed in the **gate geometry pipeline**
(extend the sidecar's `bbox` to per-channel) and versioned/scaled like geo/LOD. In
practice two boxes: **silhouette** (albedo+normal share it; normals are flat-up across the
silhouette) and **emissive** (sparse — the real win).

## The static cache (persistent; updated on transition/content change)

Per the **main world viewport** (not every viewport — see VRAM):
- `static.albedo`, `static.normal` — cached static geometry G-buffer (normal needed to
  re-bake the lightmap).
- `static.lightmap` — **one** summed buffer of all static lights' contribution
  (`Σ static-light_i · N(static.normal) · atten`), ambient as its base/clear value.
- `static.lit` — `static.albedo × (ambient + static.lightmap) + static.emissive`. The
  **display/restore background** — makes static display a *blit*, not a calculation.
- `static.depth` — the static world's sort-Y, for dynamic-prim occlusion.
- Emissive packed into a spare channel (e.g. `normal.b`, XY-only normals reconstruct Z),
  lazy-allocated.

Sizing: **viewport + ~1 overscan ring**, NOT full-world. Pan scroll-copies the overlap to
its new offset and bakes only the revealed band (terminal-scroll style) → memory stays
viewport-bounded, pan cost is the edge band.

## Lighting model — four combinations, ONE lit buffer

There are four geometry×light combinations:

| | static lights | dynamic lights |
|---|---|---|
| **static geo** | `static.lightmap` (cached, free) | recompute (dynamic on static) |
| **dynamic geo** | recompute (live) | recompute (live) |

But they are **not** four full-viewport buffers summed every frame. There is **one** lit
buffer = the cached `static.lit` background, with **dirty-rect recompute via multiply** in
place:

- **Whole viewport:** blit `static.lit` — a copy, not a calculation (the only
  viewport-wide cost). Idle ⇒ this is all that happens.
- **Dynamic-light disk cells (static geo under a dynamic light):**
  `static.albedo × (ambient + static.lightmap + Σ dynamic) + static.emissive`.
  **Sample the cached lightmap, add only the few dynamic lights** — static lights are
  never re-evaluated, so even inside a dynamic light's disk a thousand static lights stay
  free.
- **Dynamic-prim footprint cells:** render the prim (albedo/normal/depth), light it
  **fully live** — all in-range lights × the prim's normal, because the lightmap baked the
  *static* normal and doesn't apply to a moving prim — and **depth-test against
  `static.depth`** so it's occluded correctly (soul behind tree). No overlays.
- **Restore:** where a dynamic light/prim *left*, restore those cells from `static.lit`
  (the cached background) — the last-rect/new-rect damage pattern.

Recompute-by-multiply (overwrite the dirty cells with `albedo × (ambient+lightmap+dynamic)`)
instead of additively blending an overlay is what avoids the premultiplied-alpha trap; the
lightmap being separate from albedo is what lets you add dynamic lights *before* the albedo
multiply.

A cell can be covered by **> `MAX_LIGHTS`** static lights; the **lightmap bake** (and a hot
light's disk re-bake) then accumulates in batches (sum 16, add the next 16…). Bake-time
cost only, never per-frame.

## Transitions (cold↔hot) — cost scales with churn, not the pool

"May move" is free; only what's *actually moving now* costs.
- **Light starts moving:** re-bake its **disk** in `static.lightmap` summing the
  *remaining* static lights (from `cell → [lights]`), update `static.lit` there. It joins
  the per-frame dynamic set. Settles → re-bake it back in. Cost ∝ radius.
- **Prim starts moving:** re-bake its **footprint** out of `static.{albedo,normal,lightmap,
  lit,depth}` (revert to what's behind it). It's drawn live + depth-tested while moving.
  Settles → re-bake it back in. Cost ∝ footprint.
- Worst case (all 64 move at once) degrades to **ordinary tiled-deferred many-lights** —
  bounded per-pixel by lights-per-cell, real-time, no cliff. Typical (handful) is nearly
  free. The pool only sets a comfortable ceiling.

## Budgeted amortized work queue (graceful overload)

**One** priority queue of dirty regions — cold re-bakes (transitions, content edits) AND
dynamic recomputes (moving lights/prims) — drained up to **N per frame** by priority +
aging. Over budget ⇒ low-priority work **goes stale**, not the framerate. Self-throttling
⇒ guaranteed frame budget. Rules:
- **Budget the *recompute* (re-light / advance render state — expensive), not the
  *recomposite* (blit the cached lit sprite at current position — cheap).** A skipped
  thing keeps its last cached lit sprite and is still composited; choose its failure mode:
  skip-recompute-only ⇒ moves smoothly with stale lighting (usually nicer); skip-entirely
  ⇒ freezes a frame.
- **Track each dynamic thing's last-*rendered* rect** (not last-frame position), so the
  damage/restore is correct after skips (else smears).
- **Overlap rule:** restoring a damage rect must redraw **every dynamic thing intersecting
  it** (z-ordered, at last-known state), not just `static.lit` — else overlapping stale
  dynamics get half-erased. Rare for sparse movers, but mandatory.
- **Priority + aging:** focal first (cursor, dragged card, screen-centre); age skipped
  ones so nothing starves. Peripheral/distant dynamics go stale first — least noticeable.
- **Budget the *render*, never the *sim*.** Game state (authoritative positions,
  collisions) advances every tick; only the visual update is budgeted. Render lag must
  never become gameplay lag.

## Per-frame loop

```
blit static.lit over the whole window                              # free background
drain the dirty-region queue up to the frame budget, by priority+age:
  static geo under a dynamic light:
      static.albedo × (ambient + static.lightmap + Σ dynamic) + static.emissive
  dynamic prim footprint:
      render prim (albedo/normal/depth); light fully live; depth-test vs static.depth
  restore vacated cells from static.lit (+ redraw any overlapping dynamics)
# transitions (prim/light start/stop) enqueue static-cache + lightmap re-bakes,
# also drained under the same budget
```

## Performance model

| Scenario | Work |
|---|---|
| **Idle** | blit `static.lit` (a copy) |
| **Dynamic light moves** | recompute its disk (sample lightmap + add the few dynamic) |
| **Dynamic prim moves** | live draw + depth + live light over its footprint |
| **Transition (start/stop)** | re-bake the disk/footprint into/out of the static cache |
| **Content edit** | re-bake affected cells from `cell→[prims]` (coalesced) |
| **Pan** | scroll-copy `static.*` + bake the revealed band |
| **Overload** | low-priority dynamics go stale (budget), framerate held |

Dominant cost is **draw-call / RT-switch overhead**, not fill → **coalesce dirty cells
into bounding rects**; budget = draw-batches/frame. Nothing is computed viewport-wide; the
viewport-wide op is a memcpy.

## VRAM budget

Failure mode is **WebGL context loss** (black screen), not slowdown. Targets: **<256 MB**
mobile/integrated, **<512 MB** desktop-safe, **~1 GB redline**. The **static set is ~5
viewport maps** (`albedo, normal, lightmap, lit, depth` + packed emissive). One 1080p
texture = 8 MB (dpr1) / 33 MB (dpr2). The **atlas competes** (67 MB / 4096² page). Levers:
1. **Cap the static maps at ~dpr 1 (–1.5)** even on retina — lighting is low-frequency,
   sprite detail comes from the atlas. ~quarters the framebuffer memory; biggest safe win.
2. **Full pipeline only for the main world viewport;** inventory/editor use flat lighting
   (kills the ×viewports multiplier).
3. Pack emissive into a spare channel; lazy-allocate.
4. Bound overscan to ~1 ring.
With (1)+(2): ~5 × 8 MB ≈ **~40 MB** for the main viewport — comfortable.

## Reused vs replaced

- **Reused:** retained-mode build-on-enter/drop-on-exit; per-chunk containers (D1b.1a) as
  the static-map storage/scroll unit; the per-chunk albedo+normal bake (D1b.1b-i) seeds
  the static cache; the `Light` schema (`canBake`/`castsShadow`/tile-radius); geometry
  sidecars (→ per-map bounds + shadow occluders).
- **Replaced:** the per-frame screen-space normal/albedo capture + 16-light screen pass +
  multiply overlays (current); and from **G1**, the entire hot/cold prim overlay
  machinery (above/below, depth-split, cold↔hot graph) → depth buffer + dirty-rect
  recompute + budgeted queue.

## Phasing (verifiable cuts)

1. **Substrate.** render_rect grid + `cell→[prims]` index + per-map bounds; bake static
   `albedo/normal/depth`; `static.lit` = ambient only; display the window; re-bake dirty
   cells on content change; pan scroll-copies + bakes the revealed band. Dynamic stuff
   renders live-on-top simply (no depth yet). Checkpoint: looks identical (flat ambient),
   idle = blit, pan under budget.
2. **Static lightmap.** Place static lights → bake `static.lightmap` (`cell→[lights]`,
   additive accumulation for >16/cell) → `static.lit` includes them. Checkpoint: static
   torches light their area and cost **zero** per frame / on pan.
3. **Dynamic lights.** Dirty-rect recompute over a dynamic light's disk (sample lightmap +
   add dynamic) + damage restore. Cursor as a dynamic light. Checkpoint: cursor lights the
   ground (looks like today); only its disk recomputes; static lights stay free.
4. **Dynamic prims + depth.** Live draw + `static.depth` test + full live lighting +
   damage rects. Checkpoint: a soul walks behind a tree correctly; dragging recomputes only
   damage rects.
5. **Budgeted queue.** Unify cold + dynamic into one priority+aging queue with a per-frame
   budget. Checkpoint: under synthetic overload, peripheral dynamics go stale; framerate
   holds; sim unaffected.
6. **Shadows.** Static-light shadows raster into the lightmap (free per frame); dynamic-light
   shadows raster per frame in the dirty recompute. Projected-billboard from the sidecars.

## Implementation plan (from the D1b.1b-i checkpoint)

Concrete, sequenced build. Strategy: **build behind a `g4` flag alongside the live
pipeline; verify each phase; reach visual parity at Phase 3 (the cutover candidate),
then delete the old path.** The app stays usable throughout — and note that in Phases
1–2 the cursor light is temporarily absent (G4 is rebuilding lighting bottom-up), so the
old pipeline remains the default until Phase 3 catches up. The conceptual "Phasing"
section above is the summary; this is the executable version.

### Phase 0 — decisions + spike (small, blocks everything)
1. **Cell dimensions.** Pick `cell = √3R × R` (or the variant that tiles the hex vertical
   period `3R` cleanly); pin exact `(q,r)→cells` and `worldPx→cell`. Pure geometry, unit-
   testable — the literal first code (`CellGrid`).
2. **Storage model — RESOLVE the doc's ambiguity.** Per-chunk RTs (8-tile chunks × 5
   channels) aggregate to hundreds of MB; a single **viewport+overscan scrolled map per
   channel** is ~40 MB. VRAM is binding → **use the scrolled map** (scroll-copy the
   overlap + bake the revealed band on pan). What we reuse from D1b.1a/b-i is the **bake
   logic** (`bakeGround`-style render-prims-into-a-world-space-target-with-offset) and the
   build-on-enter/drop-on-exit *concept*, NOT the chunk RTs as storage.
   > **REVERSED IN BUILD → per-chunk RTs.** drop-on-exit bounds the live set to viewport +
   > overscan (so not "hundreds of MB"), and per-chunk makes pan a free container-move while
   > deleting the riskiest subsystem (scroll-copy). See [Build log](#build-log-as-built).
3. **Premultiply/blend convention**, written once for the whole chain (bake → cache →
   dirty-recompute → restore). The scheme-C killer — prove it with a ~30-line throwaway:
   bake one cell, recomposite it, assert pixel-identical, before anything depends on it.
4. **Single vs double buffer** for `static.lit` (in-place dirty recompute can't read+write
   the same texels mid-pass).
5. **Per-map bounds in the gate.** Extend `shared/geometry`'s sidecar `bbox` to per-channel
   (silhouette + emissive). Stub with the existing silhouette bbox for Phases 1–3; tighten
   later.

### Phase 1 — substrate + static geometry cache (no new lighting)
- Build: `CellGrid`; the bidirectional `cell↔[static prim]` index; `StaticCache` holding
  `static.albedo/normal/depth` (scrolled viewport+overscan maps) + `static.lit =
  albedo×ambient`. Re-bake only dirty cells from `cell→[prims]`, coalesced into bounding
  rects. Pan = scroll-copy + bake the revealed band.
- Reuse: D1b.1b-i's bake, extended to also write `depth` (= sort-Y) and `lit`.
- Wire (flagged): `g4` on ⇒ display `static.lit` instead of the screen-space pass.
- **Checkpoint:** ground renders at flat ambient correctly (matches the *un-hovered* dark
  scene); idle = a blit; pan scrolls + bakes only the revealed band; a content edit re-bakes
  only its dirty cells. (Risk: scroll-on-pan addressing + dirty-cell coalescing.)

### Phase 2 — static lightmap
- Build: `cell→[lights]` index; lightmap bake (reuse the Lambert+falloff light shader per
  cell into `static.lightmap`, additive accumulation for >16 lights/cell); `static.lit =
  albedo × (ambient + lightmap) + emissive`.
- Need: a couple of static test lights (a debug `^light` placement) to see anything.
- **Checkpoint:** static lights light their area, cost zero per frame and on pan; moving a
  static light re-bakes only its disk.

### Phase 3 — dynamic lights (cursor returns) — PARITY / cutover candidate
- Build: the dynamic-light dirty-rect recompute — over a dynamic light's disk,
  `static.albedo × (ambient + sample(static.lightmap) + Σ dynamic) + emissive` into the lit
  buffer; damage-rect restore from `static.lit`. Cursor becomes a dynamic light.
- **Checkpoint:** cursor lights the ground exactly like today's hover; only its disk
  recomputes; static stays free. **Visual parity** — A/B against the old pipeline. If it
  holds, `g4` can become the default (old path stays one more phase as a safety net).

### Phase 4 — dynamic prims + depth
- Build: composite `static.depth` into a screen depth buffer at display; draw dynamic prims
  (cards/souls) live, depth-tested, lit fully live, with damage rects.
- **Checkpoint:** a soul walks behind a tree correctly; dragging recomputes only damage
  rects. (Resolve depth-vs-soft-alpha here.)

### Phase 5 — budgeted amortized queue
- Build: `DirtyQueue` — one priority+aging queue for cold re-bakes AND dynamic recomputes,
  drained to a per-frame budget. (Phases 1–4 just "process all dirty each frame"; this adds
  the budget.) Implement the three rules (budget recompute not composite; track last-
  *rendered* rect; redraw overlapping dynamics on restore). Budget render, never sim.
- **Checkpoint:** synthetic overload (force 64 movers) → peripheral dynamics go stale,
  framerate holds, sim unaffected.

### Cutover
After Phase 3 parity confirmed and 4–5 land: flip `g4` to default, then DELETE the old
`DeferredLighting` screen-space path + the D1b.1b-i chunk-display LitSprite path. Keep the
chunk lifecycle concept, the `Light` schema, the sidecars.

### Phase 6 — shadows (the original goal)
Static-light shadows raster into the lightmap bake (free per frame); dynamic-light shadows
raster per frame in the dirty recompute. Projected-billboard from the sidecars;
`cell→[lights]` answers "which lights does this occluder affect."

### Critical path & first task
- Critical path: **Phase 0 → 1 → 2 → 3** (parity). 4–5 harden; 6 is the payoff.
- Riskiest: the **scroll-on-pan cache (P1)** and the **premultiply convention (P0/P3)** —
  both de-riskable with the Phase-0 spikes first.
- **First concrete task:** the Phase-0 spike — `CellGrid` geometry (unit-tested) + the
  premultiply one-cell recomposite prototype. Lowest integration risk, proves the
  foundation + the correctness convention.

## Open questions ("think more")

- Exact **cell dimensions** so the grid tiles the hex period `3R` cleanly (the "~4 cells/
  hex" is approximate).
- Whether `static.lit` and the final display can share a buffer, or need double-buffering
  for the in-place dirty recompute.
- **Depth + soft sprite alpha:** alpha-test threshold for the depth write (hard silhouette)
  vs blended edges — confirm occlusion looks right at tree/soul silhouettes.
- Skip-recompute-only vs skip-entirely as the default overload failure (stale-lighting
  smooth-motion is the lean, but confirm it reads acceptably).
- The **overlap-redraw rule** (#3 of the queue) cost under pathological clustering of
  dynamics.
- `>16` lights/cell accumulation details + practical max lights-per-cell.
- Multi-viewport policy (which get full pipeline) and the total atlas+LOD+framebuffer
  budget per device tier.
- Premultiplied-alpha convention nailed once across the static-cache + dirty-recompute +
  restore chain (the thing that bit scheme C).
