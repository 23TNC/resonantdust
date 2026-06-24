# Tiered lighting (cold / warm / hot dynamic pool)

Status: **planned** — design locked, Phase 0 starting. Supersedes the cold-uniform-array +
RGB-3-shadow path in the current renderer. Carries over the `Light` schema, the
projected-silhouette scatter (`projectCaster`/`gatherShadowCasters`), and geometry sidecars
from [shadow_lighting.md](shadow_lighting.md) / [g4_renderer.md](g4_renderer.md).

## Goal

Light a 2.5D board with **many** lights — static set effectively unlimited across the world,
plus up to 32 dynamic lights — at real-time framerate, with per-light shadows. The design
splits lights by how often they change, because the cost that dominates (rebuilding shadows)
is a *per-light* cost we can only afford for a few lights per frame.

## The tiers

| Tier | Count | Shadow build | Light data | Lightmap | Updates |
|---|---|---|---|---|---|
| **Cold** | ≤32 **per rect** (unlimited world) | CPU per-pixel active map (32-bit) | per-rect data/color textures (rgba8, rect-local) | pre-summed `cold_lightmap`, dirty-rect rebake | on settle / content change |
| **Dynamic** (warm+hot) | 32 **global** | 2 scatter maps (8 lights/frame) → 32-bit `warm_shadowmap` (ping-pong) | uniforms | recomputed every frame at display | every frame (position), shadow round-robin |

"Hot" and "warm" are **freshness states of one dynamic pool**, not separate tiers: each frame
8 of the 32 get a fresh scattered shadow, the other 24 carry a cached (≤3-frame-stale) shadow.

Display composite, per pixel:

```
lit = albedo × ( cold_lightmap                     // 1 texture read
               + Σ_32 dynamic[i] · falloff · N·L · gate(i) )   // gate from warm bit / scatter
```

## Why this shape — the constraints that force it

These are the load-bearing facts; the design is downstream of them.

- **A texture channel is 8 bits, a texel is 32.** Lights are quantization-tolerant (a smooth
  falloff shifted a few px is invisible — unlike depth, where a 1-unit error pops a sort), so
  rgba8 is enough for light *data* if positions snap to a grid. Depth's precision bar does
  **not** apply here.
- **The GPU can't merge a bitfield via blend.** Combining separate draws happens only at the
  fixed-function blend stage, which is arithmetic (max/add), never bitwise-OR. So you cannot
  rasterize N lights' shadows into one packed channel — `max` drops bits, `add` carries
  (two occluders of one light → `1+1=2` → wrong bit). Each scattered light needs its **own
  channel** → 4 per RGBA → the 3-light cap today, 8 with two maps.
- **Identity must survive.** A count of "how many lights reach here" is useless — removing a
  warm torch ≠ removing a cold blue. Every encoding (per-channel, per-bit, per-index) keeps
  light identity; that's non-negotiable.
- **Gather has no merge problem.** When all lights are in one shader invocation (uniforms,
  analytic, or read from a prebuilt map), you just sum — identity and summation are both free.
  The merge wall is purely a property of *building the shadow by rasterization* (scatter).
- **Cold can't subtract.** A baked lightmap is `Σ lights`; you can't remove one term (clamping),
  so a dirty cold region re-sums all its lights. That makes cold expensive to *move* a light
  through — which is why moving lights live in the dynamic pool, not cold.

## Data representation

### Light (unified)

One struct, replacing today's `ColdLight` and the hot uniform arrays:

```
Light { x, y, z, radius, r, g, b, brightness, castsShadow, tier }
```

`x,y` world px; `z` height (makes N·L 3D — without it flat ground never lights, and it's the
same `z` the shadow projection `h/(lightZ−h)` uses); `radius` falloff cutoff px; `rgb` colour;
`brightness` scalar (kept separate so colour is a normalized hue, intensity scales / HDRs
independently before the albedo multiply).

### Cold maps (per rect)

- **data map** rgba8, `32·rectsX × rectsY`: light `i` of a rect → `(x−128, y−128, z, radius)`,
  **rect-local** and biased (`−128`) so it pans for free and negatives fit 0..255. Grid-snapped;
  ~11px/step at a 149px rect — fine for a soft light.
- **color map** rgba8, same layout: `(r, g, b, brightness)`.
- **active map** 32-bit/pixel, **CPU-built**. The CPU has full occlusion knowledge, so it can be
  rect-aware (slot 3 means a different light in different rects) and handle shadows crossing rect
  boundaries — the thing GPU scatter can't do per-rect. Built once / on dirty, amortized.
- **`cold_lightmap`** pre-summed `ambient + Σ cold·N·falloff·(1−shadow)`, the existing
  `LightBakeShader` output, dirty-rect rebake (`bakeLightDirty`).

### Dynamic pool (global)

- **32 lights in uniforms** (`32 × 2 vec4 = 64` — within limits). Global, because GPU scatter
  writes a light's shadow into a fixed channel across the whole map, so the channel↔light map
  is global; you can't make it per-rect (shadows cross boundaries → collision).
- **2 scatter shadow maps** (RGBA each = 8 lanes), **panel-space**, built every frame for this
  frame's 8-light batch via the existing `projectCaster` scatter + `max`-blend. The lane is a
  `uChannel` uniform output (NOT the premultiplied tint — that couples rgb↔alpha and was why the
  cap was 3). Panel-space is fine for the *fresh* scatter because it's rebuilt every frame; only
  the *warm accumulation* needs pan-stability, so the **panel→world transform happens in the
  Phase 2 ping-pong combine** (avoids per-frame per-rect blits into the torus-wrapped layout).
- **`warm_shadowmap`** 32-bit/pixel, world/rect-space, **double-buffered**. Each frame a
  ping-pong combine pass reads `prev warm + the 8 fresh scatter channels` and writes `next warm`
  with those 8 bits updated (round-robin: 32 / 8 = **4-frame cycle**, ≤3-frame shadow lag; lag
  scales down with fewer active dynamic lights). Writing the bitfield in a *shader* (ping-pong
  RMW) is fine — the blend-merge wall only applies to combining separate *draws*.

## Display + cross-fade

Recompute the dynamic contribution every frame (no `warm_lightmap` cache — the 32-light ALU loop
over uniforms is ~1G ALU/frame at 1080p, a fraction of any modern GPU; cache is a deferred
optimization, see Phase 4). Per pixel:

1. `cold_lightmap` read (ambient + baked cold).
2. Loop 32 dynamic lights — **structured as 4 channels × 8 bits** to avoid ES-1.00 dynamic
   vector indexing. For each: falloff·N·L, gate by the warm bit.
3. For the 8 lights in this frame's scatter batch, **cross-fade** `gate = 0.5·(warmBit + freshBit)`
   — reads stale warm + fresh scatter, which the deferred writeback hands you for free. This turns
   the shadow's catch-up snap into a 1-frame fade. A dynamic light's bit only changes on its
   refresh frame (when it's in the batch), so every flip is caught by the fade; nothing pops.

### Bit extraction — float-mod, GLSL ES 1.00 (decided)

We stay on ES 1.00 and extract bits with float math rather than `#version 300 es` + `uint`:
- Zero risk to PIXI's stock high-shader bits (no program-wide version migration under the
  most-touched shader); keeps all lighting shaders on one version.
- Lossless: rgba8 stores `n/255` exactly, so `floor(ch*255 + 0.5)` recovers the byte and
  `mod(floor(byte / exp2(b)), 2.0)` is exact in float32. Matches how `depthShaders.ts` already
  unpacks bytes.
- Cost is trivial. 300 es stays a fallback only if real integer ops are needed elsewhere.

Rule: loop `c = 0..3` (channel, constant — select `.r/.g/.b/.a` by ladder), inner `b = 0..7`
(`exp2(b)`), `i = c*8 + b`. Uniform-array `uLightData[i]` with the loop index is allowed (the
current display loop already does it).

## Locked decisions

1. **2 scatter maps → 8 fresh shadows/frame**, no cursor reservation (cursor is real-time light,
   ≤3-frame shadow lag). Cursor-pin (slot 0 fixed, rotate 7) kept as a fallback flag if the lag
   reads badly on fast flicks.
2. **Bit extraction = float-mod, ES 1.00** (above).
3. **No `warm_lightmap` cache** initially — recompute 32 at display. Add dirty-disk caching only
   if profiling proves the loop is a bottleneck (Phase 4).

## Phased implementation

### Phase 0 — foundation + de-risk *(low risk, first)*
- Unify `ColdLight` + hot uniform arrays into one `Light`; one enumerator bucketing cold vs
  dynamic.
- **Spike** the 32-bit bitfield: write a known pattern into an rgba8 RT, sample it, extract bit
  `i` with the float-mod 4×8 helper, confirm all 32 read back. De-risks Phases 2–3.
- Verify in browser.

### Phase 1 — dynamic scatter (2 maps, 8 lights) ✅ DONE (e6a136e)
- `shadowMaskShader`: second RGBA map (8 lanes); lane via `uChannel` uniform (decoupled from
  the premultiplied tint — the real reason the cap was 3). Stays **panel-space** (world transform
  deferred to the Phase 2 combine — see above).
- Display reads all 8 lanes directly (no warm field yet).
- VERIFIED: 8 world lights over the forest — all 8 lanes incl. both alpha lanes carry independent
  coverage, RGB not zeroed, 8 distinct coloured pools with per-light shadows. Premultiply cleared.

### Phase 2a — dynamic pool (warm field + 32 lights) ✅ DONE (6fa424f)
- `warmCombineShader` ping-pong: packs the 8 fresh scatter lanes into one warm channel (the
  round-robin batch = exactly one byte), carries the rest, `blendMode "none"` (verbatim → alpha
  lane survives). `warm_shadowmap` double-buffered, **panel-space** (Phase 2a).
- 32 lights in uniforms; display flat loop deriving c=i/8,b=i-c*8 (valid array index) + bf_byte/
  bf_bit gate + cross-fade the fresh batch with live scatter. Round-robin ceil(count/8) batches.
- VERIFIED: 32 world lights → all 4 warm channels fill incl. alpha (91k/198k/205k/137k px); every
  light lit + shadowed; cursor (1 light) unchanged. Gotchas hit: `packed` is a GLSL reserved word;
  computed uniform-array index is illegal in ES 1.00; backticks in GLSL comments close the literal.
- Not yet visually confirmed: the 1-frame cross-fade smoothing a *moving* light (mechanism in
  place); possible faint 4-frame shadow-edge shimmer from the rotating cross-fade (polish, watch).

### Phase 2b — pan-stability ✅ DONE (f49522c)
- The combine **scrolls** the carried channels by the UV pan delta (read uPrevWarm at
  `vUV − uPanDelta`; revealed edges → 0/lit), so accumulated bits track the world. Warm buffers
  are NEAREST (bitfield — bilinear corrupts bits; also quantizes the scroll to whole texels).
  WorldRenderer passes `(pan − lastPan)/size`. Chosen over a world/rect-space field to avoid
  per-frame per-rect blits into the torus layout — keeps everything panel-space.
- VERIFIED: a controlled +0.10 pan shifts channel 0 by +152px (expected ~177, shortfall = right-
  edge clipping; correct direction + magnitude); uPanDelta reaches the shader; static unchanged.
- Caveat: screen lights (the cursor) scroll with the world too, but re-scatter each batch-0 frame
  so the live cross-fade masks it. Cursor-pin remains an option if it ever reads badly.
- Still open (carried from 2a): cross-fade no-pop on a *moving* light + possible rotating shimmer
  are eyeball-unconfirmed; no perf measurement; only tested with injected lights.

### Debug notes (gotchas that cost time)
- `extract.pixels` returns the **DPR-scaled physical** buffer — address it by the returned
  `.width`, NOT `RenderTexture.width` (CSS). Using the CSS width scrambled a centroid measurement
  into a false "scroll doesn't work."
- GLSL/PIXI failures are **silent** (compile error → mesh skipped → black/zero, logged only to
  `console.error`). `packed` is a reserved word; computed uniform-array indices are illegal in
  ES 1.00; backticks in GLSL comments close the template literal. `tsc` catches none of these.

### Phase 3 — cold scaling (per-rect lights) ✅ DONE (d4a07da)
- **Simpler than the spec:** the bake already renders per-rect (`bakeLightRect`), so per-rect
  *uniforms* beat per-rect *textures* — no new maps, no CPU per-pixel active map. Each rect bins
  the world-wide cold set to its nearest ≤32 (`lightsForRect`: disk-overlaps-rect, nearest-first)
  and sets the bake uniforms per rect; the nearest 3 cast shadows (so cold shadows scale per-rect
  too, vs the old global 3). Falloff stays analytic; occlusion stays the 3-channel scatter.
- The per-rect data/color *textures* from the original design are only needed for a future
  **single-pass** bake (collapse the per-rect renders into one) — deferred, not required for scale.
- VERIFIED: 50 cold lights across the window all bake (old global-32 cap would leave 18 dark) —
  full grid lit to the corners; 2-demo-light scene unchanged; tree shadows intact.

### Phase 4 — integration
- Tier migration: a dynamic light that **settles** → CPU-bake into cold (one rebake); a cold light
  that starts moving → promote to dynamic.
- Round-robin scheduler + priority (recently-moved first, age to avoid starvation).
- **Optional** `warm_lightmap` cache + dirty disks — only if profiling demands it.

## Preserved / superseded

- **Preserved** (load-bearing — do not strip): per-rect culling, bit-packing, incremental
  `bakeLightDirty`, retained-mode build-on-enter.
- **Supersedes**: the cold uniform-array path, the RGB-3 shadow cap. `DeferredLighting.ts`
  (dormant) can be deleted once Phase 2 lands.
