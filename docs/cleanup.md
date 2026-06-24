# Renderer cleanup plan

Status: **plan.** Post-rect-composite-rebuild dead-code sweep, scoped to the `view/`
renderer (where the q/r→x/y churn left the most cruft). Grounded in an import-graph trace
(2026-06-21), corrected for two over-flags (see "Not dead" below). Builds on the clean
pushed state at commit `3ea22d8`. Related: [rect_renderer.md](rect_renderer.md),
[g7_renderer.md](g7_renderer.md), [depth_layers.md](depth_layers.md).

## Method (safety)

- **One category per commit**, `tsc --noEmit` clean + a browser smoke (`/showRT`, scene
  renders) after each — every step has a clean rollback point.
- Delete only **import-graph-verified** dead code (no live importer, or only imported by
  other dead code). Never delete on "looks unused."
- We are NOT touching the `gateway` submodule or Rust crates here (Phase 6 is a separate,
  careful pass — the "recovered cut features" are intentional, not dead).

## Not dead — do NOT remove (corrects the survey's over-flags)

- `DEPTH_ALPHA_THRESHOLD`, `DEPTH_PERIOD` — used inside `depthShaders.ts` (shader discard /
  encode / `depthFront`).
- `DEPTH_GROUP_SIZE`, `BLUE_HEX_TILE`, `BLUE_ROOT`, `depthFront` — G7 layer scaffolding,
  documented forward use ([depth_layers.md](depth_layers.md)).
- `LitSprite.normalTexture` — **live**: RectComposite's `normal` channel reads it
  (`WorldRenderer.ts` `texOf: s => s.normalTexture`).

## Confirmed dead (import-graph traced)

- `DepthCompositeShader` + `makeDepthCompositeShader` (`depthShaders.ts`) — defn only, never
  instantiated.
- `DeferredLighting` per-chunk bake methods: `bakeGround`, `bakeChunkLit`, `bakeChunkDepth`,
  `setCursorWorld`, `cursorDisk` — defn only.
- All of `deferredLightShader.ts` (`MAX_LIGHTS`, `makeDeferredLightShader`,
  `DeferredLightShader`) — only ever fed the now-dead `bakeChunkLit`.
- `DeferredLighting` sprite registry (`register`/`unregister` + the `sprites` set) —
  superseded by RectComposite's own prim index; `LitSprite` calls it but nothing reads the
  set.
- `xaa` (repo root) — 2-byte `split` artifact.

## Phases

### Phase 1 — junk (zero risk)
- `rm xaa`.

### Phase 2 — old depth-composite shader (dead, isolated)
- Delete `DepthCompositeShader` + `makeDepthCompositeShader` from `depthShaders.ts`. No call
  sites; self-contained.

### Phase 3 — gut DeferredLighting's dead per-chunk bakes
- Delete `bakeGround`, `bakeChunkLit`, `bakeChunkDepth`, `setCursorWorld`, `cursorDisk`.
- That orphans the whole `deferredLightShader.ts` + the `lightShader` / `lightUniforms` /
  bake-quad fields on `DeferredLighting` → delete the file and those fields.
- Net: `DeferredLighting` collapses to its registry role.

### Phase 4 — the registry (DECISION REQUIRED)
What remains of `DeferredLighting` after Phase 3 is two registries:
- **Sprite registry** (`register`/`unregister`) — truly dead (above). Remove it + the
  `LitSprite` calls that feed it.
- **Light registry** (`registerLight`/`unregisterLight` + `offline()`) — orphaned today, but
  it is the intended hook for wiring card `^light` prims into the rect **cold lights**
  (currently demo fixtures in `WorldRenderer.ensureColdLights`).

Finish one of two ways:
- **(A — recommended)** Drop the dead sprite registry; keep the light registry, renamed to
  something honest (`LightRegistry`, or fold onto `WorldRenderer`). Preserves the
  card-light seam we know we'll need; minimal to reverse.
- **(B)** Delete `DeferredLighting` entirely (incl. the `offline()` card-preview path) and
  reintroduce a light registry when card-light wiring actually lands.

### Phase 5 — dormant-but-intended (leave, annotate)
- `LitSprite.emissiveTexture` + plumbing — keep; add a one-line TODO pointing at the G7
  emissive-channel item. No emissive consumer exists yet.
- G7 depth scaffolding — keep (documented).

### Phase 6 — Rust / content (separate session, optional)
A careful audit, NOT a sweep. The recovered "cut features" (player dimensions,
character_creation, player-scope blueprints, `stacks.rs`) are intentionally cut and must not
be mistaken for dead code. Lean on `cargo` unused warnings + reference tracing; out of scope
here.

## Sequencing

Phases **1–3** are unambiguous and safe — do them first (a few small commits, typecheck +
smoke each). **Phase 4** waits on the A/B pick. **Phase 5** is annotation only. **Phase 6**
is a deliberate later pass.
