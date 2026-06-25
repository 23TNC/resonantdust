import { Buffer, BufferUsage, Container, Geometry, Matrix, Mesh, RenderTexture, Sprite, Texture, earcut, type Renderer } from "pixi.js";
import type { GeometryStore } from "../../../assets/geometry/GeometryStore";
import type { Sidecar } from "../../../assets/geometry/geoTypes";
import {
  makeShadowMaskShader, makeShadowGeometry, MAX_SHADOW_VERTS, MAX_SHADOW_CASTERS,
  MAX_SHADOW_LIGHTS, SHADOW_MAPS, channelForLight, shadowMapOf, shadowHeightScale,
  SHADOW_DBL_CAP, SHADOW_NORTH_STRETCH, SHADOW_MAX_LEN, type ShadowMaskShader,
} from "./shadowMaskShader";
import { makeWarmCombineShader, makeWarmQuadGeometry, type WarmCombineShader } from "./warmCombineShader";
import { mod, rectH, rectOffX, rectOffY, rectsForAABB, rectW, rectWorldX, rectWorldY, type RectRange } from "./rectMath";
import { makeLightBakeShader, MAX_COLD_LIGHTS, type LightBakeShader } from "./rectLightBakeShader";
import { makeObjectDepthShader, makeDepthQuadGeometry, setQuadDepth, BLUE_OBJECT, BLUE_ROOT, type ObjectDepthShader } from "../../lighting/depthShaders";
import type { LightCore } from "../../lighting/lights";

/** A static (baked) light, in WORLD px. Contributes to the lightmap. The cold tier consumes
 *  only the core photometry; routing lives on {@link Light}. See docs/tiered_lighting.md. */
export type ColdLight = LightCore;

/** Rects of slack kept around the viewport on every side, so a pan reveals
 *  already-baked rectangles before they reach the screen edge. */
const OVERSCAN = 2;

/** A drawable the composite indexes + bakes: a `LitSprite` (its `albedoTexture` /
 *  `normalTexture` feed the channels) with an optional silhouette `stem`. Kept
 *  structural so the composite never depends on the prim hierarchy. */
export type IndexedSprite = Sprite & {
  stem?: string;
  albedoTexture?: Texture;
  normalTexture?: Texture | null;
  /** True for tessellating GROUND (bg / clippedHex fills) — excluded from the depth
   *  bake so a mover is never occluded by flat ground, only by standing objects. */
  groundLayer?: boolean;
};

/** A resolved shadow caster: the silhouette transform needed to project it onto the
 *  ground. WORLD px (`+pan` applied at projection). `footNY` = the silhouette's lowest
 *  contour point (normalized), the ground line; `feetX` its centre. */
interface ShadowCaster {
  feetX: number;
  groundY: number;
  left: number;
  w: number;
  h: number;
  footNY: number;
  stem: string;
  sidecar: Sidecar;
}

/** A pooled max-blend shadow mesh + its growable vertex buffer (shared by the hot mask and
 *  the cold-shadow bake). */
type ShadowMeshSlot = { mesh: Mesh<Geometry, ShadowMaskShader>; pos: Buffer; data: Float32Array; cap: number };

/** One mover to bake into the hot maps: its display `node` (a positioned PrimitiveLayer/marker
 *  Container — currently displaying albedo), its `lit` LitSprites (for the normal-channel swap),
 *  its WORLD-space AABB (which slots it covers), and `zIndex` (back-to-front sort within a slot). */
export interface HotEntry {
  node: Container;
  lit: IndexedSprite[];
  wx0: number;
  wy0: number;
  wx1: number;
  wy1: number;
  zIndex: number;
}

/** One G-buffer channel: a name + which texture of a primitive feeds it. The
 *  composite owns one fixed-slot RT (the "map", e.g. albedo or normal) per channel. */
export interface ChannelSpec {
  name: string;
  /** The primitive texture this channel bakes (albedo / normal / …), or `null` to
   *  SKIP the prim for this channel — its area falls through to {@link clearColor}
   *  (e.g. a prim with no normal map → the flat-up normal clear). */
  texOf: (sprite: IndexedSprite) => Texture | null;
  /** Per-rect bake clear `[r,g,b,a]` 0..1 (default transparent). Normal uses flat-up
   *  `[0.5,0.5,1,1]` so un-mapped/empty area reads as +Z. */
  clearColor?: number[];
  /** Force the prim's tint to white while baking (normal/data channels — the albedo
   *  tint must not skew the baked vector). Albedo leaves the tint as the colour. */
  whiteTint?: boolean;
}

interface ChannelState extends ChannelSpec {
  /** THE map — a fixed `cols × rows` grid of rectangle slots; never slides. The
   *  display/light passes sample this directly (no windowed copy). */
  composite: RenderTexture | null;
}

interface PrimEntry {
  sprite: IndexedSprite;
  range: RectRange;
}

/**
 * A **fixed-slot, multi-channel rectangle compositor**.
 *
 * Bookkeeping (the rectangle grid, the anchored window, the dirty set and the
 * data-rect→primitive index) is SHARED; each {@link ChannelSpec} adds one more
 * fixed-slot composite RT (the albedo map, the normal map, …) baked from that
 * primitive texture. So "the albedo" is just the `albedo` channel's composite —
 * a composite of every primitive's albedo — and adding `normal` is one more spec.
 *
 * The composite RTs are fixed: world rect `(wc, wr)` always lives at physical slot
 * `(mod(wc, cols), mod(wr, rows))`, never recopied. The **window** (resident rects)
 * moves DISCRETELY — its top-left `(winCol, winRow)` advances a whole rect at a
 * time as the anchor crosses a boundary, and only the column/row that just wrapped
 * onto the trailing edge is re-baked.
 *
 * **Primitives register into the rectangles they occupy.** Baking a dirty rectangle
 * gathers that rectangle's primitives and draws **the portion of each** that falls
 * inside it — for every channel — into the rect's fixed slot. The display copy is a
 * separate windowed view (it, not the composite, carries the smooth pan).
 */
export class RectComposite {
  // ── shared bookkeeping ───────────────────────────────────────────────────
  /** One-rectangle scratch: a dirty rect's prims bake here (clipped) per channel. */
  private scratchRT: RenderTexture | null = null;
  private scratchTex: Texture | null = null;
  private cols = 0;
  private rows = 0;
  private viewW = 0;
  private viewH = 0;
  /** Window top-left in world-rect coords (moves discretely with the anchor). */
  private winCol = 0;
  private winRow = 0;
  private aimed = false;

  private readonly channels: ChannelState[];
  /** prim id → its sprite + occupied rect range. */
  private readonly prims = new Map<number, PrimEntry>();
  /** data rectangles: `"wc,wr"` → the prim ids occupying it. */
  private readonly rectPrims = new Map<string, Set<number>>();
  /** World rect keys awaiting a re-bake. */
  private readonly dirty = new Set<string>();

  /** Stable per-sprite prim ids + per-tile grouping. */
  private nextId = 1;
  private readonly spriteIds = new Map<IndexedSprite, number>();
  private readonly tileGroups = new Map<number, Set<IndexedSprite>>();

  /** Reusable replace-blit sprite (`blendMode "none"` = exact RGBA copy). */
  private readonly blitSprite = new Sprite();
  /** Empty container for clear-only passes (an empty rect → transparent slot). */
  private readonly empty = new Container();
  /** A rect's prims are moved here (a real render root) to bake, then returned to
   *  {@link source} — PIXI v8 won't render a parented child standalone. */
  private readonly bakeContainer = new Container();

  // ── cold-light lightmap ──────────────────────────────────────────────────
  /** The baked static-light map: `ambient + Σ cold lights·N·falloff`, one fixed slot
   *  per rect (same layout as the channels). Display does `albedo × (lightmap + hot)`. */
  private lightmap: RenderTexture | null = null;
  /** Static lights baked into {@link lightmap} (world px). World-wide set is unbounded; each
   *  rect bakes only its nearest ≤{@link MAX_COLD_LIGHTS} (see {@link lightsForRect}). */
  private coldLights: ColdLight[] = [];
  private coldAmbient = 0.25;
  /** Reusable per-rect cold-light uniform buffers (filled by {@link packColdInto} per bake). */
  private readonly coldDataBuf = new Float32Array(MAX_COLD_LIGHTS * 4);
  private readonly coldColorBuf = new Float32Array(MAX_COLD_LIGHTS * 4);
  /** Rects whose lightmap slot needs re-baking (geometry/normal changed, or a cold
   *  light in range changed). The cold-light `dirty_light` set. */
  private readonly lightDirty = new Set<string>();
  private readonly lightBakeShader: LightBakeShader = makeLightBakeShader();
  private readonly lightBakePos = new Buffer({ data: new Float32Array(8), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
  private readonly lightBakeUv = new Buffer({ data: new Float32Array(8), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
  private readonly lightBakeMesh: Mesh<Geometry, LightBakeShader>;

  // ── depth (sort-Y for dynamic-vs-baked occlusion) ────────────────────────
  /** Per-pixel SORT-Y of the baked world (frontmost prim's base world-Y, encoded
   *  hex-row in R + sub-row in G; `rgba8`, `max`-blended). Lets dynamic movers
   *  (cards) `discard` where the static world is in front. Same slot grid. */
  private depthRT: RenderTexture | null = null;
  /** One container of per-prim depth quads, rendered ONCE per rect with `max` blend —
   *  a SECOND `renderer.render` into a depth RT in the same bake silently no-ops (the
   *  trap that sank the old two-pass attempt), so it must be a single pass. */
  private readonly depthBakeContainer = new Container();
  private readonly depthQuadPool: Mesh<Geometry, ObjectDepthShader>[] = [];

  // ── shadows (projected-silhouette mask) ──────────────────────────────────
  /** Panel-sized RGBA scatter maps: each dynamic light's projected-silhouette coverage in
   *  one lane. `SHADOW_MAPS` maps × 4 lanes = 8 fresh lights/frame; light `i` → map `i>>2`,
   *  lane `i&3`. The display samples them per fragment. See `buildShadowMask`. */
  private shadowRTs: (RenderTexture | null)[] = [];
  private shadowW = 0;
  private shadowH = 0;
  // ── warm field (32-bit dynamic occlusion, ping-pong) ─────────────────────
  /** Two panel-sized rgba8 buffers holding the 32-light occlusion bitfield (bit i = light i
   *  SHADOWED here). Each frame the combine folds the fresh 8-light batch into one channel,
   *  carrying the rest — round-robin 8/frame over 32 = 4-frame cycle. Display samples the
   *  current buffer. Panel-space for now (Phase 2a); pan-stability is Phase 2b. */
  private warmRTs: (RenderTexture | null)[] = [null, null];
  private warmCur = 0;
  private readonly warmShader: WarmCombineShader = makeWarmCombineShader();
  private warmMesh: Mesh<Geometry, WarmCombineShader> | null = null;
  private readonly warmContainer = new Container();
  /** One child mesh per hot light (tinted to its channel), all in one container rendered
   *  ONCE — a second render into the same RT no-ops (the depth saga's trap). `cap` = the
   *  mesh's current vertex capacity (doubles on demand). */
  private readonly shadowContainer = new Container();
  private readonly shadowMeshes: ShadowMeshSlot[] = [];
  /** Per-stem SOLID (hole-filled) silhouette triangulation, contour-only via earcut —
   *  shadows want a solid cast, not the sprite's internal alpha holes. Normalized coords;
   *  light-independent, so cached once per stem (keyed incl. `?v=` → re-mastered = new key). */
  private readonly shadowTriCache = new Map<string, { pts: Float32Array; tris: Uint32Array }[]>();
  /** Reused scratch for projected contour points (avoids per-poly allocation). */
  private readonly shadowScratch: number[] = [];

  // ── cold-light shadows (baked into the lightmap) ─────────────────────────
  /** Cold-shadow coverage, SAME slot layout as the lightmap (RGB = cold light 0/1/2). The
   *  lightmap bake samples it to remove each occluded cold light's term (ambient stays). */
  private coldShadowRT: RenderTexture | null = null;
  private readonly coldShadowContainer = new Container();
  private readonly coldShadowMeshes: ShadowMeshSlot[] = [];

  // ── hot prims (per-frame movers: cards/souls) ────────────────────────────
  /** Movers' albedo/normal, SAME slot layout as the static composites, but RE-BAKED every
   *  frame from the mover nodes (they tween constantly). The display merges these over the
   *  cold world by depth. Unlike the static bake, mover nodes are TRANSFORMED PrimitiveLayer
   *  trees, so we render the node in place (with a slot transform) rather than reparent leaves. */
  private hotAlbedo: RenderTexture | null = null;
  private hotNormal: RenderTexture | null = null;
  /** Per-frame mover DEPTH (feet-Y + card layer), same slot layout. The display merge
   *  compares it against the cold depth via `depthFront` to pick hot-vs-cold per pixel
   *  (a card behind an object is occluded; a card in front occludes the object). */
  private hotDepth: RenderTexture | null = null;

  /** Diagnostics (read by `?rectview`). */
  lastBaked = 0;

  constructor(
    /** Home parent of every registered primitive (moved into the bake container
     *  per rect and returned). */
    private readonly source: Container,
    private readonly geometry: GeometryStore,
    channels: ChannelSpec[],
  ) {
    this.blitSprite.blendMode = "none";
    this.channels = channels.map((c) => ({ ...c, composite: null }));
    // Light-bake quad: a rect-local (0..W,0..H) quad, transform-placed at each rect's
    // lightmap slot; `aUV` (the rect's normal slot) is set per bake.
    const geo = new Geometry({
      attributes: {
        aPosition: { buffer: this.lightBakePos, format: "float32x2" },
        aUV: { buffer: this.lightBakeUv, format: "float32x2" },
      },
      indexBuffer: new Buffer({ data: new Uint32Array([0, 1, 2, 0, 2, 3]), usage: BufferUsage.INDEX | BufferUsage.COPY_DST }),
    });
    this.lightBakeMesh = new Mesh({ geometry: geo, shader: this.lightBakeShader });
  }

  /** The fixed-slot composite RT for a channel (e.g. the albedo map) — sampled by
   *  the display shader, and shown raw in the debug panel. Never slides. */
  channelComposite(name: string): RenderTexture | null {
    return this.channels.find((c) => c.name === name)?.composite ?? null;
  }

  /** The baked cold-light lightmap RT (display samples it; debug panel `lit`). */
  get lightmapTexture(): RenderTexture | null {
    return this.lightmap;
  }

  /** The baked sort-Y depth RT (debug panel `depth`; consumed by dynamic movers). */
  get depthTexture(): RenderTexture | null {
    return this.depthRT;
  }

  /** The per-frame projected-silhouette scatter map `m` (0..SHADOW_MAPS-1), display samples
   *  it. Map `m` holds dynamic lights `m*4 .. m*4+3` in lanes R/G/B/A. */
  shadowMaskTextureAt(m: number): RenderTexture | null {
    return this.shadowRTs[m] ?? null;
  }

  /** The current 32-bit warm occlusion field (display samples it; bit i = light i shadowed). */
  get warmFieldTexture(): RenderTexture | null {
    return this.warmRTs[this.warmCur];
  }

  /** Replace the cold (static, baked) light set + ambient. Marks the whole window's
   *  lightmap dirty (cold lights change rarely — a torch lit, a day/night step). */
  setColdLights(lights: ColdLight[], ambient: number): void {
    this.coldLights = lights;
    this.coldAmbient = ambient;
    this.dirtyBlockLight(this.winCol, this.winRow, this.cols, this.rows);
  }

  /** Physical slot counts. */
  get gridCols(): number { return this.cols; }
  get gridRows(): number { return this.rows; }

  /** True once the window has been aimed + sized (geometry can be filled). */
  get ready(): boolean { return this.cols > 0 && this.channels[0]?.composite != null; }

  /**
   * Fill the display mesh: **up to 4 quads** that tile the resident window and
   * split it at the torus wrap, so each quad samples a CONTIGUOUS run of composite
   * slots (never across the seam — that's the smear fix). `pos`/`uv` are 16-vertex
   * (4 quads × 4) Float32Arrays; quads with no extent (no wrap on that axis) come
   * out degenerate (zero-area → nothing drawn). Indices are static (see
   * {@link DISPLAY_INDICES}).
   *
   * For each axis the window `[win, win+count)` splits at the first slot-0 rollover:
   * piece 0 = the slots from the window start up to the wrap, piece 1 = slots
   * `[0, s0)` after it. UVs sit in the VALID slot region (cols·W of the padded RT),
   * inset a half-texel at the composite's outer edges so bilinear can't reach the
   * unused padding.
   */
  fillDisplay(panX: number, panY: number, pos: Float32Array, uv: Float32Array): void {
    const W = rectW();
    const H = rectH();
    const cw = Math.ceil(this.cols * W);
    const chh = Math.ceil(this.rows * H);
    const s0 = mod(this.winCol, this.cols);
    const t0 = mod(this.winRow, this.rows);
    const hx = 0.5 / cw;
    const hy = 0.5 / chh;
    // axis pieces: world range [a0,a1) → slot range [s0,s1)
    const xs = [
      { a0: this.winCol, a1: this.winCol + (this.cols - s0), s0, s1: this.cols },
      { a0: this.winCol + (this.cols - s0), a1: this.winCol + this.cols, s0: 0, s1: s0 },
    ];
    const ys = [
      { a0: this.winRow, a1: this.winRow + (this.rows - t0), s0: t0, s1: this.rows },
      { a0: this.winRow + (this.rows - t0), a1: this.winRow + this.rows, s0: 0, s1: t0 },
    ];
    let v = 0;
    for (const x of xs) {
      for (const y of ys) {
        const x0 = x.a0 * W + panX, x1 = x.a1 * W + panX;
        const y0 = y.a0 * H + panY, y1 = y.a1 * H + panY;
        let u0 = (x.s0 * W) / cw, u1 = (x.s1 * W) / cw;
        let p0 = (y.s0 * H) / chh, p1 = (y.s1 * H) / chh;
        if (x.s0 === 0) u0 += hx;            // composite left edge
        if (x.s1 === this.cols) u1 -= hx;    // composite right edge (padding past here)
        if (y.s0 === 0) p0 += hy;            // composite top edge
        if (y.s1 === this.rows) p1 -= hy;    // composite bottom edge
        const b = v * 2;
        pos[b] = x0; pos[b + 1] = y0; pos[b + 2] = x1; pos[b + 3] = y0;
        pos[b + 4] = x1; pos[b + 5] = y1; pos[b + 6] = x0; pos[b + 7] = y1;
        uv[b] = u0; uv[b + 1] = p0; uv[b + 2] = u1; uv[b + 3] = p0;
        uv[b + 4] = u1; uv[b + 5] = p1; uv[b + 6] = u0; uv[b + 7] = p1;
        v += 4;
      }
    }
  }

  // ── sizing ──────────────────────────────────────────────────────────────────
  /** (Re)size to a panel. Re-allocates the one-rect scratch and, per channel, the
   *  composite (cols×rows slots) + display RT when the rect count changes, then
   *  re-aims the window (whole-window re-bake) on the next `recenter`. */
  resize(viewW: number, viewH: number, renderer: Renderer): void {
    if (viewW <= 0 || viewH <= 0) return;
    const cols = Math.ceil(viewW / rectW()) + 2 * OVERSCAN;
    const rows = Math.ceil(viewH / rectH()) + 2 * OVERSCAN;
    this.viewW = viewW;
    this.viewH = viewH;
    // Shadow mask is panel-px-sized (sampled by panel position), so it tracks viewW/viewH
    // — NOT the rect-slot grid — and must resize even when the rect count is unchanged.
    const pw = Math.ceil(viewW);
    const ph = Math.ceil(viewH);
    if (this.shadowRTs.length !== SHADOW_MAPS || this.shadowW !== pw || this.shadowH !== ph) {
      for (const rt of this.shadowRTs) rt?.destroy(true);
      this.shadowRTs = Array.from({ length: SHADOW_MAPS }, () =>
        RenderTexture.create({ width: pw, height: ph, resolution: renderer.resolution }));
      // Warm field: two panel-sized buffers (ping-pong), cleared to 0 (all-lit). Plus the
      // full-screen combine quad sized to the panel.
      for (const rt of this.warmRTs) rt?.destroy(true);
      this.warmRTs = [
        RenderTexture.create({ width: pw, height: ph, resolution: renderer.resolution }),
        RenderTexture.create({ width: pw, height: ph, resolution: renderer.resolution }),
      ];
      // NEAREST: the field is a bitfield — bilinear would interpolate bits into garbage. Also
      // quantizes the pan-scroll to whole texels so repeated shifts stay lossless.
      for (const rt of this.warmRTs) { rt!.source.scaleMode = "nearest"; renderer.render({ container: this.empty, target: rt!, clear: true, clearColor: [0, 0, 0, 0] }); }
      this.warmCur = 0;
      this.warmMesh?.geometry.destroy();
      const geom = makeWarmQuadGeometry(pw, ph);
      if (!this.warmMesh) {
        this.warmMesh = new Mesh({ geometry: geom, shader: this.warmShader });
        this.warmMesh.blendMode = "none"; // verbatim RGBA write — no premultiply (alpha survives)
        this.warmContainer.addChild(this.warmMesh);
      } else {
        this.warmMesh.geometry = geom;
      }
      this.shadowW = pw;
      this.shadowH = ph;
    }
    if (cols === this.cols && rows === this.rows && this.scratchRT) return;
    this.cols = cols;
    this.rows = rows;
    const res = renderer.resolution;
    const cw = Math.ceil(cols * rectW());
    const ch = Math.ceil(rows * rectH());
    this.scratchRT?.destroy(true);
    this.scratchTex?.destroy();
    this.scratchRT = RenderTexture.create({ width: Math.ceil(rectW()), height: Math.ceil(rectH()), resolution: res });
    this.scratchTex = new Texture({ source: this.scratchRT.source, dynamic: true });
    // Per channel: a fixed cols×rows-slot composite (the display shader samples it).
    for (const c of this.channels) {
      c.composite?.destroy(true);
      c.composite = RenderTexture.create({ width: cw, height: ch, resolution: res });
      renderer.render({ container: this.empty, target: c.composite, clear: true, clearColor: c.clearColor });
    }
    // Lightmap: same slot layout; cleared to ambient (un-baked slots read as ambient).
    this.lightmap?.destroy(true);
    this.lightmap = RenderTexture.create({ width: cw, height: ch, resolution: res });
    const a = this.coldAmbient;
    renderer.render({ container: this.empty, target: this.lightmap, clear: true, clearColor: [a, a, a, 1] });
    // Cold-shadow coverage: same slot layout; cleared to 0 (no shadow).
    this.coldShadowRT?.destroy(true);
    this.coldShadowRT = RenderTexture.create({ width: cw, height: ch, resolution: res });
    renderer.render({ container: this.empty, target: this.coldShadowRT, clear: true, clearColor: [0, 0, 0, 0] });
    // Hot prims (movers): albedo + normal, same slot layout; transparent (no mover) → cold shows.
    this.hotAlbedo?.destroy(true);
    this.hotNormal?.destroy(true);
    this.hotAlbedo = RenderTexture.create({ width: cw, height: ch, resolution: res });
    this.hotNormal = RenderTexture.create({ width: cw, height: ch, resolution: res });
    renderer.render({ container: this.empty, target: this.hotAlbedo, clear: true, clearColor: [0, 0, 0, 0] });
    renderer.render({ container: this.empty, target: this.hotNormal, clear: true, clearColor: [0.5, 0.5, 1, 1] });
    this.hotDepth?.destroy(true);
    this.hotDepth = RenderTexture.create({ width: cw, height: ch, resolution: res });
    renderer.render({ container: this.empty, target: this.hotDepth, clear: true, clearColor: [0, 0, 0, 1] });
    // Depth: same slot layout; cleared to 0 (empty = behind everything).
    this.depthRT?.destroy(true);
    this.depthRT = RenderTexture.create({ width: cw, height: ch, resolution: res });
    renderer.render({ container: this.empty, target: this.depthRT, clear: true, clearColor: [0, 0, 0, 1] });
    // Light-bake quad is rect-local (0..W,0..H); placed at each slot by a transform.
    const W = rectW();
    const H = rectH();
    (this.lightBakePos.data as Float32Array).set([0, 0, W, 0, W, H, 0, H]);
    this.lightBakePos.update();
    this.aimed = false; // recenter re-aims + dirties the whole window
    this.dirty.clear();
    this.lightDirty.clear();
  }

  // ── window (discrete anchor) ─────────────────────────────────────────────────
  /** Move the window so it stays centred on the anchor's world position. The window
   *  top-left advances in whole-rect steps; the first aim (or a jump beyond the
   *  window) dirties the whole window, an incremental step dirties only the
   *  column/row strip(s) that just wrapped onto the trailing edge. */
  recenter(anchorWorldX: number, anchorWorldY: number): void {
    if (!this.scratchRT) return;
    const newCol = Math.floor((anchorWorldX - this.viewW / 2 - rectOffX()) / rectW()) - OVERSCAN;
    const newRow = Math.floor((anchorWorldY - this.viewH / 2 - rectOffY()) / rectH()) - OVERSCAN;
    if (!this.aimed) {
      this.winCol = newCol;
      this.winRow = newRow;
      this.aimed = true;
      this.dirtyBlock(newCol, newRow, this.cols, this.rows);
      return;
    }
    const dCol = newCol - this.winCol;
    const dRow = newRow - this.winRow;
    if (dCol === 0 && dRow === 0) return;
    if (Math.abs(dCol) >= this.cols || Math.abs(dRow) >= this.rows) {
      this.winCol = newCol;
      this.winRow = newRow;
      this.dirtyBlock(newCol, newRow, this.cols, this.rows);
      return;
    }
    if (dCol > 0) this.dirtyBlock(this.winCol + this.cols, newRow, dCol, this.rows);
    else if (dCol < 0) this.dirtyBlock(newCol, newRow, -dCol, this.rows);
    if (dRow > 0) this.dirtyBlock(newCol, this.winRow + this.rows, this.cols, dRow);
    else if (dRow < 0) this.dirtyBlock(newCol, newRow, this.cols, -dRow);
    this.winCol = newCol;
    this.winRow = newRow;
  }

  // ── tile grouping (stable per-sprite ids) ────────────────────────────────────
  /** Set the full primitive set a tile contributes. Adds new sprites, refreshes
   *  existing (footprint + content), and drops any the tile no longer has. */
  setTilePrims(tileId: number, sprites: IndexedSprite[]): void {
    const prev = this.tileGroups.get(tileId);
    const next = new Set(sprites);
    if (prev) for (const s of prev) if (!next.has(s)) this.dropSprite(s);
    for (const s of sprites) {
      const id = this.spriteIds.get(s);
      if (id === undefined) {
        const nid = this.nextId++;
        this.spriteIds.set(s, nid);
        this.addPrim(nid, s);
      } else {
        this.refreshPrim(id, s);
      }
    }
    this.tileGroups.set(tileId, next);
  }

  /** Drop every primitive a tile contributed (dirties their rects → re-bake without them). */
  removeTile(tileId: number): void {
    const set = this.tileGroups.get(tileId);
    if (!set) return;
    for (const s of set) this.dropSprite(s);
    this.tileGroups.delete(tileId);
  }

  /** Rebuild the projected-silhouette scatter maps for the dynamic `lights` (panel px:
   *  `{x,y,z,radius}`), up to {@link MAX_SHADOW_LIGHTS}. Each light's nearby casters are
   *  projected through it onto the ground and rasterized into its lane (light `i` → map
   *  `i>>2`, lane `i&3`); `panX/panY` map caster world px → panel. One container per map,
   *  ONE `max`-blend render each (a second render into the same RT no-ops — the depth trap). */
  buildShadowMask(renderer: Renderer, lights: { x: number; y: number; z: number; radius: number }[], panX: number, panY: number): void {
    if (this.shadowRTs.length !== SHADOW_MAPS) return;
    const n = Math.min(lights.length, MAX_SHADOW_LIGHTS);
    // Shadows are GROUND-only (the display never darkens object pixels), so no per-caster
    // identity / self-exclusion is needed — objects always sit on top.
    for (let map = 0; map < SHADOW_MAPS; map++) {
      this.shadowContainer.removeChildren();
      for (let i = map * 4; i < n && shadowMapOf(i) === map; i++) {
        const casters = this.gatherShadowCasters(lights[i].x - panX, lights[i].y - panY, lights[i].radius);
        let need = 0; // total projected verts this light needs (3 per solid triangle)
        for (const c of casters) for (const pg of this.shadowTris(c.stem, c.sidecar)) need += pg.tris.length;
        const slot = this.ensureShadowMesh(this.shadowMeshes, i, need);
        let v = 0;
        const Lz = Math.max(lights[i].z, 1);
        for (const c of casters) v = this.projectCaster(slot.data, v, c, lights[i].x, lights[i].y, Lz, panX, panY);
        slot.data.fill(0, v * 2); // zero the tail → degenerate (no-area) triangles
        slot.pos.update();
        this.shadowContainer.addChild(slot.mesh);
      }
      renderer.render({ container: this.shadowContainer, target: this.shadowRTs[map]!, clear: true, clearColor: [0, 0, 0, 0] });
    }
  }

  /** Ping-pong the warm field: read the previous buffer (scrolled by the UV pan delta so carried
   *  channels track the world) + the fresh scatter maps, fold this frame's 8-light batch into
   *  channel `freshChannel` (0..3), write the other buffer. Call after {@link buildShadowMask}
   *  (which must hold the batch's 8 lights in lanes 0..7). */
  buildWarmField(renderer: Renderer, freshChannel: number, panDeltaU: number, panDeltaV: number): void {
    if (!this.warmRTs[0] || !this.warmRTs[1] || !this.warmMesh || this.shadowRTs.length !== SHADOW_MAPS) return;
    const prevIdx = this.warmCur;
    const curIdx = 1 - this.warmCur;
    this.warmShader.prevWarm = this.warmRTs[prevIdx]!;
    this.warmShader.scatter0 = this.shadowRTs[0]!;
    this.warmShader.scatter1 = this.shadowRTs[1]!;
    this.warmShader.setFresh(freshChannel);
    this.warmShader.setPanDelta(panDeltaU, panDeltaV);
    // Full-screen quad, blendMode "none" → overwrites every pixel; no clear needed.
    renderer.render({ container: this.warmContainer, target: this.warmRTs[curIdx]!, clear: false });
    this.warmCur = curIdx;
  }

  /** The `pool`'s coverage mesh at index `i`, its vertex buffer grown (DOUBLING) to hold
   *  `need` vertices. Tinted once to the light's channel (R/G/B). */
  private ensureShadowMesh(pool: ShadowMeshSlot[], i: number, need: number): ShadowMeshSlot {
    let slot = pool[i];
    if (!slot) {
      const { geometry, pos } = makeShadowGeometry();
      const shader = makeShadowMaskShader();
      shader.setChannel(channelForLight(i)); // lane = i & 3 (R/G/B/A); map = i >> 2
      const mesh = new Mesh({ geometry, shader });
      mesh.blendMode = "max";
      slot = { mesh, pos, data: pos.data as Float32Array, cap: MAX_SHADOW_VERTS };
      pool[i] = slot;
    }
    if (need > slot.cap) {
      let cap = slot.cap;
      while (cap < need) cap *= 2;
      const { geometry, pos } = makeShadowGeometry(cap);
      slot.mesh.geometry.destroy();
      slot.mesh.geometry = geometry;
      slot.pos = pos;
      slot.data = pos.data as Float32Array;
      slot.cap = cap;
    }
    return slot;
  }

  /** The SOLID (hole-filled) triangulation of a stem's silhouette — earcut over the
   *  CONTOUR ONLY (holes ignored: a shadow casts a solid shape, not the sprite's internal
   *  alpha gaps). Normalized coords; cached per stem (light-independent). */
  private shadowTris(stem: string, sidecar: Sidecar): { pts: Float32Array; tris: Uint32Array }[] {
    let cached = this.shadowTriCache.get(stem);
    if (cached) return cached;
    cached = sidecar.polygons.map((poly) => {
      const flat: number[] = [];
      for (const [x, y] of poly.contour) flat.push(x, y);
      const tris = earcut(flat, undefined, 2); // contour only → solid (holes filled)
      return { pts: new Float32Array(flat), tris: new Uint32Array(tris) };
    });
    this.shadowTriCache.set(stem, cached);
    return cached;
  }

  /** Project ONE caster's SOLID silhouette through a light (panel px) onto the ground,
   *  writing triangle-list vertices into `out` starting at vertex `vStart`; returns the new
   *  vertex count. Shared by the coverage + caster-row passes. Billboard shear: ONE direction
   *  per caster (feet centre → away from light, avoids per-vertex fold); a point at height
   *  `hUp` lays out by `hUp/(lightZ−hUp)·min(dist,cap)`, clamped to {@link SHADOW_MAX_LEN};
   *  north-going offsets are stretched ({@link SHADOW_NORTH_STRETCH}) to fight foreshorten. */
  private projectCaster(out: Float32Array, vStart: number, c: ShadowCaster, Lx: number, Ly: number, Lz: number, panX: number, panY: number): number {
    const baseX = c.feetX + panX;
    const baseY = c.groundY + panY;
    const toLx = Lx - baseX;
    const toLy = Ly - baseY;
    const dBL = Math.hypot(toLx, toLy) || 1;
    const dirx = -toLx / dBL; // away from the light (one direction for the whole caster)
    const diry = -toLy / dBL;
    const dBLc = Math.min(dBL, SHADOW_DBL_CAP);
    const polys = this.shadowTris(c.stem, c.sidecar);
    // Height scale DIMINISHES with caster height (taller → smaller), so tall casters don't
    // ride the steep part of the hUp/(Lz−hUp) perspective curve and elongate their tips.
    const occScale = shadowHeightScale(c.h);
    // Bound the WHOLE shadow by uniformly scaling so its TIP (the projection of the
    // silhouette's highest point, smallest ny) lands at SHADOW_MAX_LEN — this keeps the tip
    // POINTED. (Per-vertex clamping instead collapses every over-long vertex onto one arc,
    // slicing the tip flat.) `hCap` only guards `Lz − hUp → 0`; set high so it doesn't shape.
    const hCap = Lz * 0.95;
    let minNy = 1.0;
    for (const pg of polys) { const pts = pg.pts; for (let p = 1; p < pts.length; p += 2) if (pts[p] < minNy) minNy = pts[p]; }
    let topHUp = Math.max(c.footNY - minNy, 0) * c.h * occScale;
    if (topHUp > hCap) topHUp = hCap;
    const tipD = (topHUp / (Lz - topHUp)) * dBLc;
    // The north stretch (below) scales the Y offset AFTER `d`, so a north-going shadow's ACTUAL
    // extent is up to SHADOW_NORTH_STRETCH × `d`. Cap the STRETCHED tip extent, not raw `d` —
    // otherwise low lights (a soul `^light` at height 20 sits right at the cap) overshoot
    // SHADOW_MAX_LEN by 1.8× while high lights (cursor, h110) stay under it. South/E/W unchanged.
    const stretchY = diry < 0 ? SHADOW_NORTH_STRETCH : 1.0;
    const tipExtent = tipD * Math.hypot(dirx, diry * stretchY);
    const scale = tipExtent > SHADOW_MAX_LEN ? SHADOW_MAX_LEN / tipExtent : 1.0;
    const proj = this.shadowScratch;
    let v = vStart;
    for (const pg of polys) {
      const pts = pg.pts;
      proj.length = 0;
      for (let p = 0; p < pts.length; p += 2) {
        const nx = pts[p];
        const ny = pts[p + 1];
        let hUp = Math.max(c.footNY - ny, 0) * c.h * occScale;
        if (hUp > hCap) hUp = hCap; // safety only — keep Lz−hUp positive
        const d = (hUp / (Lz - hUp)) * dBLc * scale; // length along the shadow dir (uniform-scaled tip)
        let oy = diry * d;
        if (oy < 0) oy *= SHADOW_NORTH_STRETCH; // stretch the north-going length only
        // SHEAR (stretch/lean): WIDTH stays horizontal (nx·w), only the height shears toward the
        // away-from-light dir. N/S looks good; E/W goes thin (height lays horizontal) — the
        // accepted trade vs the rotated version that swept the whole silhouette around the feet.
        proj.push(c.left + nx * c.w + panX + dirx * d, baseY + oy);
      }
      const tris = pg.tris;
      for (let t = 0; t + 2 < tris.length; t += 3) {
        if (v + 3 > out.length / 2) return v;
        for (let k = 0; k < 3; k++) {
          const idx = tris[t + k] * 2;
          out[v * 2] = proj[idx];
          out[v * 2 + 1] = proj[idx + 1];
          v++;
        }
      }
    }
    return v;
  }

  /** Standing objects (not ground) with silhouette geometry within `radius` of WORLD
   *  `(cx,cy)`, NEAREST-first (so the visually-relevant casters always win), capped at
   *  {@link MAX_SHADOW_CASTERS}. Carries feet centre + ground line + size + foot line +
   *  stem/sidecar — enough to project the silhouette. */
  private gatherShadowCasters(cx: number, cy: number, radius: number): ShadowCaster[] {
    const hits: { c: ShadowCaster; d2: number }[] = [];
    const r2 = radius * radius;
    for (const e of this.prims.values()) {
      const s = e.sprite;
      if (s.groundLayer || !s.albedoTexture || !s.stem) continue; // flat ground doesn't occlude
      const sidecar = this.geometry.get(s.stem);
      if (!sidecar || !sidecar.polygons.length) continue;
      const w = s.width;
      const h = s.height;
      const left = s.x - s.anchor.x * w;
      const top = s.y - s.anchor.y * h;
      let footNY = 0; // silhouette's lowest contour point → the ground line
      for (const poly of sidecar.polygons) for (const [, ny] of poly.contour) if (ny > footNY) footNY = ny;
      const groundY = top + footNY * h;
      const feetX = s.x + (0.5 - s.anchor.x) * w;
      const dx = feetX - cx;
      const dy = groundY - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      hits.push({ c: { feetX, groundY, left, w, h, footNY, stem: s.stem, sidecar }, d2 });
    }
    hits.sort((a, b) => a.d2 - b.d2);
    if (hits.length > MAX_SHADOW_CASTERS) hits.length = MAX_SHADOW_CASTERS;
    return hits.map((x) => x.c);
  }

  private dropSprite(s: IndexedSprite): void {
    const id = this.spriteIds.get(s);
    if (id === undefined) return;
    this.removePrim(id);
    this.spriteIds.delete(s);
  }

  /** Drop the whole index + re-bake the window (content hot-swap / rebuild). */
  reset(): void {
    this.prims.clear();
    this.rectPrims.clear();
    this.spriteIds.clear();
    this.tileGroups.clear();
    this.dirty.clear();
    this.lightDirty.clear();
    if (this.scratchRT) {
      this.dirtyBlock(this.winCol, this.winRow, this.cols, this.rows);
      this.dirtyBlockLight(this.winCol, this.winRow, this.cols, this.rows);
    }
  }

  // ── prim index ───────────────────────────────────────────────────────────────
  private addPrim(id: number, sprite: IndexedSprite): void {
    const range = this.tightRange(sprite);
    this.prims.set(id, { sprite, range });
    this.linkRange(id, range);
    this.dirtyRange(range);
  }

  private removePrim(id: number): void {
    const e = this.prims.get(id);
    if (!e) return;
    this.unlinkRange(id, e.range);
    this.dirtyRange(e.range);
    this.prims.delete(id);
  }

  private refreshPrim(id: number, sprite: IndexedSprite): void {
    const e = this.prims.get(id);
    if (!e) {
      this.addPrim(id, sprite);
      return;
    }
    const range = this.tightRange(sprite);
    if (!sameRange(range, e.range)) {
      this.unlinkRange(id, e.range);
      this.dirtyRange(e.range);
      e.range = range;
      this.linkRange(id, range);
    }
    this.dirtyRange(e.range); // always re-dirty: the prim's art/tint may have changed
  }

  /** The prim's tight non-transparent world AABB → rect range. Uses the silhouette
   *  `Sidecar` contour when available for the sprite's stem; else the full quad. */
  private tightRange(sprite: IndexedSprite): RectRange {
    const w = sprite.width;
    const h = sprite.height;
    const left = sprite.x - sprite.anchor.x * w;
    const top = sprite.y - sprite.anchor.y * h;
    let nx0 = 0, ny0 = 0, nx1 = 1, ny1 = 1;
    const side = sprite.stem ? this.geometry.get(sprite.stem) : null;
    if (side && side.polygons.length) {
      nx0 = 1; ny0 = 1; nx1 = 0; ny1 = 0;
      for (const poly of side.polygons) {
        for (const [px, py] of poly.contour) {
          if (px < nx0) nx0 = px;
          if (py < ny0) ny0 = py;
          if (px > nx1) nx1 = px;
          if (py > ny1) ny1 = py;
        }
      }
    }
    return rectsForAABB(left + nx0 * w, top + ny0 * h, left + nx1 * w, top + ny1 * h);
  }

  private linkRange(id: number, r: RectRange): void {
    for (let c = r.col0; c <= r.col1; c++)
      for (let row = r.row0; row <= r.row1; row++) {
        const k = `${c},${row}`;
        let s = this.rectPrims.get(k);
        if (!s) this.rectPrims.set(k, (s = new Set()));
        s.add(id);
      }
  }

  private unlinkRange(id: number, r: RectRange): void {
    for (let c = r.col0; c <= r.col1; c++)
      for (let row = r.row0; row <= r.row1; row++) {
        const k = `${c},${row}`;
        const s = this.rectPrims.get(k);
        if (s) { s.delete(id); if (s.size === 0) this.rectPrims.delete(k); }
      }
  }

  private dirtyRange(r: RectRange): void {
    for (let c = r.col0; c <= r.col1; c++)
      for (let row = r.row0; row <= r.row1; row++) this.dirty.add(`${c},${row}`);
  }

  private dirtyBlock(col: number, row: number, cols: number, rows: number): void {
    for (let c = col; c < col + cols; c++)
      for (let r = row; r < row + rows; r++) this.dirty.add(`${c},${r}`);
  }

  /** Mark a block of rects' LIGHTMAP slots dirty (re-bake the cold-light sum). */
  private dirtyBlockLight(col: number, row: number, cols: number, rows: number): void {
    for (let c = col; c < col + cols; c++)
      for (let r = row; r < row + rows; r++) this.lightDirty.add(`${c},${r}`);
  }

  // ── bake ───────────────────────────────────────────────────────────────────
  /** Re-bake up to `budget` dirty in-window rectangles (all channels each). */
  bakeDirty(renderer: Renderer, budget: number): void {
    this.lastBaked = 0;
    if (!this.scratchRT || this.dirty.size === 0) return;
    let baked = 0;
    const done: string[] = [];
    for (const key of this.dirty) {
      if (baked >= budget) break;
      done.push(key);
      const ci = key.indexOf(",");
      const wc = +key.slice(0, ci);
      const wr = +key.slice(ci + 1);
      if (!this.inWindow(wc, wr)) continue; // owned by a different world rect now
      this.bakeRect(renderer, wc, wr);
      baked++;
    }
    for (const k of done) this.dirty.delete(k);
    this.lastBaked = baked;
  }

  /** Bake ONE world rectangle into every channel: move its prims into the bake
   *  container (z-sorted), then per channel set each prim's texture/tint (or hide it
   *  when the channel has no texture for it — its area falls through to the channel's
   *  clear, e.g. flat-up normal), render translated to rect-local (scratch bounds clip
   *  to the portion), and replace-copy the scratch into that channel's fixed slot. */
  private bakeRect(renderer: Renderer, wc: number, wr: number): void {
    const W = rectW();
    const H = rectH();
    const slotX = mod(wc, this.cols) * W;
    const slotY = mod(wr, this.rows) * H;
    this.lightDirty.add(`${wc},${wr}`); // geometry/normal changed → this slot's lightmap is stale
    const ids = this.rectPrims.get(`${wc},${wr}`);
    if (!ids || ids.size === 0) {
      // Empty rect: clear the slot in every channel (+ depth) to its clear value.
      for (const c of this.channels) {
        renderer.render({ container: this.empty, target: this.scratchRT!, clear: true, clearColor: c.clearColor });
        this.blit(renderer, this.scratchTex!, 0, 0, W, H, c.composite!, slotX, slotY, false);
      }
      renderer.render({ container: this.empty, target: this.scratchRT!, clear: true, clearColor: [0, 0, 0, 1] });
      this.blit(renderer, this.scratchTex!, 0, 0, W, H, this.depthRT!, slotX, slotY, false);
      return;
    }
    const list: PrimEntry[] = [];
    for (const id of ids) {
      const e = this.prims.get(id);
      if (e) list.push(e);
    }
    list.sort((a, b) => a.sprite.zIndex - b.sprite.zIndex);
    const tints = list.map((e) => e.sprite.tint); // restore after (normal forces white)
    for (const e of list) this.bakeContainer.addChild(e.sprite);
    const m = new Matrix().translate(-rectWorldX(wc), -rectWorldY(wr));
    for (const c of this.channels) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i].sprite;
        const tex = c.texOf(s);
        if (tex) {
          s.renderable = true;
          s.texture = tex;
          s.tint = c.whiteTint ? 0xffffff : tints[i];
        } else {
          s.renderable = false; // no texture for this channel → clear shows through
        }
      }
      renderer.render({ container: this.bakeContainer, target: this.scratchRT!, clear: true, clearColor: c.clearColor, transform: m });
      this.blit(renderer, this.scratchTex!, 0, 0, W, H, c.composite!, slotX, slotY, false);
    }
    // DEPTH: each STANDING object (not ground) writes its feet world-Y (modular sort
    // key, see encodeDepthTint) across its silhouette. `list` is sorted ascending zIndex
    // (≈ feet-Y) = back-to-front, so adding quads in order + OVERWRITE (normal blend,
    // discard transparent) lets the frontmost (souther, last-drawn) stamp its exact bytes.
    this.depthBakeContainer.removeChildren();
    let q = 0;
    for (let i = 0; i < list.length; i++) {
      const s = list[i].sprite;
      if (s.groundLayer || !s.albedoTexture) continue; // ground never occludes
      const w = s.width;
      const h = s.height;
      const x0 = s.x - s.anchor.x * w;
      const y0 = s.y - s.anchor.y * h;
      const baseY = y0 + h; // sprite bottom edge = the object's ground contact (feet)
      let quad = this.depthQuadPool[q];
      if (!quad) {
        quad = new Mesh({ geometry: makeDepthQuadGeometry(), shader: makeObjectDepthShader() });
        quad.blendMode = "normal";
        this.depthQuadPool[q] = quad;
      }
      const pb = quad.geometry.attributes.aPosition.buffer;
      (pb.data as Float32Array).set([x0, y0, x0 + w, y0, x0 + w, y0 + h, x0, y0 + h]);
      pb.update();
      // Standing objects (band 1). Tiles/stacks (band 0) are still omitted below until
      // hex-card stacks render — see docs/depth_layers.md "Deferred".
      setQuadDepth(quad.geometry, baseY, H, BLUE_OBJECT);
      (quad.shader as ObjectDepthShader).texture = s.albedoTexture;
      this.depthBakeContainer.addChild(quad);
      q++;
    }
    // Single render (a 2nd render into a depth RT in one bake silently no-ops); clear to
    // 0 = no object (R=G=0; a true row-0 object is a negligible world-edge case), then
    // overwrite back-to-front so the frontmost object's bytes land.
    renderer.render({ container: this.depthBakeContainer, target: this.scratchRT!, clear: true, clearColor: [0, 0, 0, 1], transform: m });
    this.blit(renderer, this.scratchTex!, 0, 0, W, H, this.depthRT!, slotX, slotY, false);
    // Restore each prim (albedo texture, original tint, renderable) + return it home.
    for (let i = 0; i < list.length; i++) {
      const s = list[i].sprite;
      s.renderable = true;
      if (s.albedoTexture) s.texture = s.albedoTexture;
      s.tint = tints[i];
      this.source.addChild(s);
    }
  }

  private inWindow(wc: number, wr: number): boolean {
    return wc >= this.winCol && wc < this.winCol + this.cols && wr >= this.winRow && wr < this.winRow + this.rows;
  }

  // ── hot prims (per-frame mover bake) ─────────────────────────────────────
  /** The hot mover maps (display samples + merges them over the cold world by depth). */
  get hotAlbedoTexture(): RenderTexture | null { return this.hotAlbedo; }
  get hotNormalTexture(): RenderTexture | null { return this.hotNormal; }
  get hotDepthTexture(): RenderTexture | null { return this.hotDepth; }

  /** Re-bake the mover albedo+normal maps from `entries` every frame: stamp each slot a mover
   *  covers (the overlapping nodes rendered in place with a slot transform), and clear slots
   *  movers just left. Slot layout matches the cold composites, so the display merges at the
   *  same UV. Mover nodes are reparented into the bake container (preserving world position),
   *  rendered, and returned — like the static bake, but on whole nodes, not leaf sprites. */
  bakeHotPrims(renderer: Renderer, entries: HotEntry[]): void {
    if (!this.hotAlbedo || !this.hotNormal || !this.scratchRT || !this.scratchTex) return;
    // The hot map is per-frame and the movers move, so rebuild from scratch: clear the WHOLE
    // map, then stamp each covered slot. (An incremental vacate-track would ghost — the blit
    // alpha-blends, so a cleared scratch can't overwrite a vacated slot's stale mover pixels.)
    renderer.render({ container: this.empty, target: this.hotAlbedo, clear: true, clearColor: [0, 0, 0, 0] });
    renderer.render({ container: this.empty, target: this.hotNormal, clear: true, clearColor: [0.5, 0.5, 1, 1] });
    if (this.hotDepth) renderer.render({ container: this.empty, target: this.hotDepth, clear: true, clearColor: [0, 0, 0, 1] });
    if (entries.length === 0) return;
    const rectMap = new Map<string, HotEntry[]>();
    for (const e of entries) {
      const r = rectsForAABB(e.wx0, e.wy0, e.wx1, e.wy1);
      for (let c = r.col0; c <= r.col1; c++)
        for (let row = r.row0; row <= r.row1; row++) {
          if (!this.inWindow(c, row)) continue;
          const k = `${c},${row}`;
          let s = rectMap.get(k);
          if (!s) rectMap.set(k, (s = []));
          s.push(e);
        }
    }
    for (const [k, es] of rectMap) {
      es.sort((a, b) => a.zIndex - b.zIndex);
      this.bakeHotRect(renderer, k, es);
    }
  }

  private slotXY(key: string): [number, number, number, number] {
    const ci = key.indexOf(",");
    const wc = +key.slice(0, ci);
    const wr = +key.slice(ci + 1);
    return [wc, wr, mod(wc, this.cols) * rectW(), mod(wr, this.rows) * rectH()];
  }

  private bakeHotRect(renderer: Renderer, key: string, entries: HotEntry[]): void {
    const W = rectW(), H = rectH();
    const [wc, wr, slotX, slotY] = this.slotXY(key);
    const m = new Matrix().translate(-rectWorldX(wc), -rectWorldY(wr));
    const parents = entries.map((e) => e.node.parent);
    const saved = entries.map((e) => e.lit.map((s) => ({ s, tint: s.tint, tex: s.texture })));
    for (const e of entries) this.bakeContainer.addChild(e.node);
    // ALBEDO: nodes already display their albedo → render as-is.
    renderer.render({ container: this.bakeContainer, target: this.scratchRT!, clear: true, clearColor: [0, 0, 0, 0], transform: m });
    this.blit(renderer, this.scratchTex!, 0, 0, W, H, this.hotAlbedo!, slotX, slotY, false);
    // NORMAL: ONLY real-normal LitSprites draw (their normal map, white-tinted so the
    // albedo tint can't skew the vector). Everything else — no-normal LitSprites
    // (solid-fill rects) AND non-LitSprite leaves (title text, bars) — is hidden so
    // it falls through to the OPAQUE flat-up clear (the facing-user normal
    // #8080ff), never writing albedo/white into the normal buffer.
    const litSet = new Set<unknown>();
    for (const e of entries) for (const s of e.lit) litSet.add(s);
    const hiddenLeaves: Container[] = [];
    const hideLeaves = (c: Container): void => {
      for (const ch of c.children as Container[]) {
        if (ch.children && ch.children.length) hideLeaves(ch);
        else if (!litSet.has(ch) && ch.renderable) { ch.renderable = false; hiddenLeaves.push(ch); }
      }
    };
    for (const e of entries) hideLeaves(e.node);
    // Real-normal sprites → their normal map (white tint). No-normal LitSprites (the
    // solid-fill rects, a WHITE-atlas texture) → tint flat-up #8080ff so they RENDER
    // flat-up (white×#8080ff) — occluding a back card's normal under the painter's
    // z-sort (stacked-card normal ordering), not just falling to the clear (which
    // would let the back show through a front card's rect).
    for (const e of entries) for (const s of e.lit) { if (s.normalTexture) { s.texture = s.normalTexture; s.tint = 0xffffff; } else { s.tint = 0x8080ff; } }
    renderer.render({ container: this.bakeContainer, target: this.scratchRT!, clear: true, clearColor: [0.5, 0.5, 1, 1], transform: m });
    this.blit(renderer, this.scratchTex!, 0, 0, W, H, this.hotNormal!, slotX, slotY, false);
    // DEPTH: one solid quad per mover covering its AABB, tinted by its feet-Y + card
    // layer (BLUE_ROOT, band 0). Entries are z-sorted (back-to-front) + OVERWRITE, so the
    // front mover's depth survives. The display merge picks hot-vs-cold via `depthFront`.
    // (Over-covers transparent card margins, but the merge masks on the hot albedo alpha.)
    if (this.hotDepth) {
      this.depthBakeContainer.removeChildren();
      for (let qi = 0; qi < entries.length; qi++) {
        const e = entries[qi];
        let quad = this.depthQuadPool[qi];
        if (!quad) { quad = new Mesh({ geometry: makeDepthQuadGeometry(), shader: makeObjectDepthShader() }); quad.blendMode = "normal"; this.depthQuadPool[qi] = quad; }
        const pb = quad.geometry.attributes.aPosition.buffer;
        (pb.data as Float32Array).set([e.wx0, e.wy0, e.wx1, e.wy0, e.wx1, e.wy1, e.wx0, e.wy1]);
        pb.update();
        setQuadDepth(quad.geometry, e.wy1, H, BLUE_ROOT);
        (quad.shader as ObjectDepthShader).texture = Texture.WHITE;
        this.depthBakeContainer.addChild(quad);
      }
      renderer.render({ container: this.depthBakeContainer, target: this.scratchRT!, clear: true, clearColor: [0, 0, 0, 1], transform: m });
      this.blit(renderer, this.scratchTex!, 0, 0, W, H, this.hotDepth, slotX, slotY, false);
    }
    // Restore textures/tints/renderable, then return the nodes to their parents.
    for (const group of saved) for (const r of group) { r.s.renderable = true; r.s.texture = r.tex; r.s.tint = r.tint; }
    for (const ch of hiddenLeaves) ch.renderable = true;
    for (let i = 0; i < entries.length; i++) parents[i]?.addChild(entries[i].node);
  }

  // ── cold-light lightmap bake ─────────────────────────────────────────────
  /** Re-bake up to `budget` light-dirty in-window rectangles' lightmap slots from the
   *  normal composite + cold lights. Cold lights packed once per call. */
  bakeLightDirty(renderer: Renderer, budget: number): void {
    const normal = this.channelComposite("normal");
    if (!this.lightmap || !normal || this.lightDirty.size === 0) return;
    this.lightBakeShader.normal = normal;
    // Cold lights + shadows are now bound PER RECT (binned) inside bakeLightRect — not once here.
    if (this.coldShadowRT) this.lightBakeShader.coldShadow = this.coldShadowRT;
    if (this.depthRT) this.lightBakeShader.depth = this.depthRT; // object gate + backlight, like hot
    let baked = 0;
    const done: string[] = [];
    for (const key of this.lightDirty) {
      if (baked >= budget) break;
      done.push(key);
      const ci = key.indexOf(",");
      const wc = +key.slice(0, ci);
      const wr = +key.slice(ci + 1);
      if (!this.inWindow(wc, wr)) continue;
      this.bakeLightRect(renderer, wc, wr, normal);
      baked++;
    }
    for (const k of done) this.lightDirty.delete(k);
  }

  /** Bake one rect's lightmap slot: the rect-local quad samples this rect's normal
   *  slot, the shader sums the cold lights at `rectWorld + local`, output → the slot
   *  (placed by a translate; the quad is rect-local). */
  private bakeLightRect(renderer: Renderer, wc: number, wr: number, normal: RenderTexture): void {
    const W = rectW();
    const H = rectH();
    const cw = normal.width;
    const chh = normal.height;
    const slotX = mod(wc, this.cols) * W;
    const slotY = mod(wr, this.rows) * H;
    const hx = 0.5 / cw;
    const hy = 0.5 / chh;
    const u0 = slotX / cw + hx, v0 = slotY / chh + hy;
    const u1 = (slotX + W) / cw - hx, v1 = (slotY + H) / chh - hy;
    (this.lightBakeUv.data as Float32Array).set([u0, v0, u1, v0, u1, v1, u0, v1]);
    this.lightBakeUv.update();
    // Per-rect cold lights: bin the world set to this rect's nearest ≤32, set the uniforms, and
    // rebuild the nearest-3 cold shadows. (Was a global set in bakeLightDirty — this scales the
    // world-wide cold count past 32 and makes shadows per-rect.)
    const binned = this.lightsForRect(wc, wr);
    this.lightBakeShader.setColdLights(this.coldDataBuf, this.coldColorBuf, this.packColdInto(binned), this.coldAmbient);
    this.buildColdShadows(binned);
    this.lightBakeShader.setRect(rectWorldX(wc), rectWorldY(wr));
    // First stamp this rect's COLD-SHADOW slot: render the projected cold silhouettes (world
    // px) into the scratch (clipped to the rect), then blit into the cold-shadow slot — the
    // lightmap shader below samples it at the same slot UV. (Must precede the lightmap render.)
    if (this.coldShadowRT && this.scratchRT && this.scratchTex) {
      const cm = new Matrix().translate(-rectWorldX(wc), -rectWorldY(wr));
      renderer.render({ container: this.coldShadowContainer, target: this.scratchRT, clear: true, clearColor: [0, 0, 0, 0], transform: cm });
      this.blit(renderer, this.scratchTex, 0, 0, W, H, this.coldShadowRT, slotX, slotY, false);
    }
    const m = new Matrix().translate(slotX, slotY);
    renderer.render({ container: this.lightBakeMesh, target: this.lightmap!, clear: false, transform: m });
  }

  /** Project `lights`' shadow casters (world px) into per-light meshes (R/G/B), for the current
   *  rect's cold-shadow slot stamp in {@link bakeLightRect}. Up to 3 cast (one per channel); with
   *  per-rect binning these are the rect's NEAREST 3, so cold shadows scale across the world. */
  private buildColdShadows(lights: ColdLight[]): void {
    const n = Math.min(lights.length, 3); // cold shadow is one RGB map (lightBake reads csh.rgb)
    this.coldShadowContainer.removeChildren();
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      const casters = this.gatherShadowCasters(l.x, l.y, l.radius); // world px (no pan)
      let need = 0;
      for (const c of casters) for (const pg of this.shadowTris(c.stem, c.sidecar)) need += pg.tris.length;
      const slot = this.ensureShadowMesh(this.coldShadowMeshes, i, need);
      let v = 0;
      const Lz = Math.max(l.height, 1);
      for (const c of casters) v = this.projectCaster(slot.data, v, c, l.x, l.y, Lz, 0, 0); // pan 0 → world
      slot.data.fill(0, v * 2);
      slot.pos.update();
      this.coldShadowContainer.addChild(slot.mesh);
    }
  }

  /** The cold lights reaching rect `(wc,wr)`, nearest-first, capped at {@link MAX_COLD_LIGHTS}.
   *  Per-rect culling → the world-wide cold set is unbounded; each rect sums only its own ≤32.
   *  The nearest 3 also cast shadows (R/G/B), so shadows scale per-rect too (vs the old global 3). */
  private lightsForRect(wc: number, wr: number): ColdLight[] {
    const rx0 = rectWorldX(wc), ry0 = rectWorldY(wr);
    const rx1 = rx0 + rectW(), ry1 = ry0 + rectH();
    const hits: { l: ColdLight; d2: number }[] = [];
    for (const l of this.coldLights) {
      const cx = Math.max(rx0, Math.min(l.x, rx1)); // closest point on the rect to the light
      const cy = Math.max(ry0, Math.min(l.y, ry1));
      const dx = l.x - cx, dy = l.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < l.radius * l.radius) hits.push({ l, d2 });
    }
    hits.sort((a, b) => a.d2 - b.d2);
    if (hits.length > MAX_COLD_LIGHTS) hits.length = MAX_COLD_LIGHTS;
    return hits.map((h) => h.l);
  }

  /** Fill the reusable cold-light uniform buffers from `lights` (xy world, z height, w radius;
   *  rgb + brightness). Returns the count. The shader loop breaks on it, so the tail is ignored. */
  private packColdInto(lights: ColdLight[]): number {
    const n = Math.min(lights.length, MAX_COLD_LIGHTS);
    const data = this.coldDataBuf, color = this.coldColorBuf;
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      data[i * 4] = l.x; data[i * 4 + 1] = l.y; data[i * 4 + 2] = l.height; data[i * 4 + 3] = l.radius;
      color[i * 4] = ((l.color >> 16) & 0xff) / 255;
      color[i * 4 + 1] = ((l.color >> 8) & 0xff) / 255;
      color[i * 4 + 2] = (l.color & 0xff) / 255;
      color[i * 4 + 3] = l.brightness;
    }
    return n;
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  /** Replace-copy a sub-frame of `srcTex` into `dst` at `(dx, dy)`. `clear` clears
   *  the whole target first. `blendMode "none"` writes RGBA verbatim (incl. alpha). */
  private blit(renderer: Renderer, srcTex: Texture, sx: number, sy: number, sw: number, sh: number, dst: RenderTexture, dx: number, dy: number, clear: boolean): void {
    const f = srcTex.frame;
    f.x = sx; f.y = sy; f.width = sw; f.height = sh;
    srcTex.updateUvs();
    this.blitSprite.texture = srcTex;
    this.blitSprite.position.set(dx, dy);
    renderer.render({ container: this.blitSprite, target: dst, clear });
  }

  destroy(): void {
    this.scratchRT?.destroy(true);
    this.scratchTex?.destroy();
    for (const c of this.channels) {
      c.composite?.destroy(true);
    }
    this.lightmap?.destroy(true);
    this.lightBakeMesh.destroy();
    this.depthRT?.destroy(true);
    this.hotAlbedo?.destroy(true);
    this.hotNormal?.destroy(true);
    this.hotDepth?.destroy(true);
    for (const quad of this.depthQuadPool) quad.destroy();
    this.depthBakeContainer.destroy();
    this.blitSprite.destroy();
    this.empty.destroy();
    this.bakeContainer.destroy();
    this.prims.clear();
    this.rectPrims.clear();
    this.spriteIds.clear();
    this.tileGroups.clear();
    this.dirty.clear();
    this.lightDirty.clear();
  }
}

function sameRange(a: RectRange, b: RectRange): boolean {
  return a.col0 === b.col0 && a.row0 === b.row0 && a.col1 === b.col1 && a.row1 === b.row1;
}

/** Static index buffer for the 4-quad display mesh ({@link RectComposite.fillDisplay}):
 *  4 quads × 2 triangles × 3 verts, over the 16 vertices (4 per quad). */
export const DISPLAY_INDICES = new Uint32Array([
  0, 1, 2, 0, 2, 3,
  4, 5, 6, 4, 6, 7,
  8, 9, 10, 8, 10, 11,
  12, 13, 14, 12, 14, 15,
]);
