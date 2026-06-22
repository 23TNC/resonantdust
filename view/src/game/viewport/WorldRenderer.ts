import { Buffer, BufferUsage, Container, Geometry, Graphics, Mesh, Point, Text, type FederatedPointerEvent, type Renderer, type RenderTexture } from "pixi.js";
import type { GameContext } from "../../GameContext";
import { DeferredLighting } from "../lighting/DeferredLighting";
import { RectComposite, DISPLAY_INDICES } from "./rects/RectComposite";
import { makeGroundShader, GroundShader, MAX_HOT_LIGHTS } from "./rects/rectDisplayShader";
import { MAX_SHADOW_LIGHTS } from "./rects/shadowMaskShader";
import { rectW, rectH, rectOffX, rectOffY, rectWorldX, rectWorldY } from "./rects/rectMath";
import { debug } from "../../debug";
import { LayoutNode } from "../layout/LayoutNode";
import { HexMath } from "./hexMath";
import { worldHexRadius, worldHexWidth, worldHexHeight } from "./hex/hexSize";
import { HexTileVisual, hexPoints } from "./hex/HexTileVisual";
import { PrimitiveLayer } from "../cards/generic/PrimitiveLayer";
import type { PrimDeps } from "../cards/generic/primitives";
import { atlasWhite, atlasHex } from "../cards/generic/atlasFills";
import { cardBox } from "../cards/generic/cardBox";
import { drawVisuals, tilePrims, type HostValue } from "../cards/generic/drawVisuals";
import { global } from "../definitions/globals";
import { onContentReloaded, sharedContent } from "../definitions/contentBoot";
import { microIsCard, stackBranch, stackIndex, STACK_DIR_UP, STACK_DIR_DOWN } from "../../server/data/packing";
import type { RenderRegion, RenderBatch, Renderable, ViewportFeed } from "../../client/render";

/** Faint hex outline so the empty/fallback grid reads as cells and a pan is
 *  visibly moving — viewport chrome, not game data. */
const TILE_OUTLINE_COLOR = 0x2a3038;
/** Tiles built per `tick` — bounds the per-frame DSL + Graphics cost so a big
 *  region streams in over a few frames instead of hitching on one. */
const BUILD_BUDGET = 24;
/** Extra rings of tiles built just outside the display, so a pan reveals
 *  already-drawn cells instead of blank space. */
const OVERSCAN_MARGIN = 1;

/** Cheap stable per-cell hash → the tile's `^seed` (deterministic variant
 *  scatter that survives leaving + re-entering the viewport). Exported so the
 *  card editor can rebuild a tile's synthetic prims with the SAME seed the
 *  on-screen tile drew with (otherwise the scatter re-rolls in the preview). */
export function cellHash(q: number, r: number): number {
  let h = (q * 73856093) ^ (r * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  return h;
}

/** Max rect-area baked into the ground composite per frame — bounds the per-frame
 *  bake cost so a big reveal (or first paint) streams over a few frames. Whole
 *  coalesced blocks are baked, so this is a soft cap. */
const BAKE_BUDGET = 96;

/** Dev: `?rectview` logs the ground composite's per-frame bake/display work
 *  (rects baked + display blocks) so a pan can be confirmed to re-bake only the
 *  revealed row/column strip, never the whole composite. */
const RECTVIEW = typeof location !== "undefined" && location.search.includes("rectview");

/** zIndex of a tile's `bg` underlay within its ground chunk — below every fill
 *  prim (which `PrimitiveLayer` floors at ≈ −1e7 + worldY), so the textured
 *  clippedHex ground always draws over the flat tint. */
const TILE_BG_Z = -2e7;

/** A retained world tile. All its prims — `bg` underlay, `clippedHex`/fill ground,
 *  and standing `sprite` objects — live in the shared detached `primSource` and bake
 *  into the rect composite (keyed by `primId`). `sig` gates rebuilds. */
interface TileNode {
  /** Stable numeric id used to key this tile's ground in the rect composite's
   *  prim↔rect index (so a drop/rebuild can address it). */
  primId: number;
  bg: HexTileVisual;
  prims: PrimitiveLayer;
  sig: number;
}

interface TileSpec {
  q: number;
  r: number;
  packed: number;
  stock0: number;
  stock1: number;
  sig: number;
}

/** A retained card. `node` is its visual: a `PrimitiveLayer` driven by the DSL
 *  `drawVisuals` when the content resolves the packed def, else a fallback marker
 *  (a tinted hex + id) for cards with no generic visuals — soul instances, whose
 *  server-stored packed isn't a content card def. `layer` is set only in the
 *  prim case (needs per-frame `settle`). */
interface CardNode {
  node: Container;
  layer: PrimitiveLayer | null;
  /** Content sig (visual identity, NOT position) — see {@link cardContentSig}. */
  sig: string;
  /** Node origin offset from the cell centre: `node.position = cellToPixel(q,r)
   *  + (ox, oy)`. Differs for the prims layer (top-left of the body) vs the
   *  fallback marker (centred). The tween eases `node.position` toward
   *  `cellToPixel(target) + (ox, oy)`. */
  ox: number;
  oy: number;
  /** Stack depth bias folded into `zIndex` (`round(centerY) + stackZ`). */
  stackZ: number;
}

/** Fallback marker palette — distinct hues so def-less cards (e.g. two players'
 *  souls) read apart. Keyed by `cardId % len`. */
const CARD_COLORS = [0x4fc3f7, 0xff8a65, 0x81c784, 0xba68c8, 0xffd54f, 0xe57373];

interface CardSpec {
  q: number;
  r: number;
  offsetX: number;
  offsetY: number;
  packed: number;
  stock: number;
  flags: number;
  sig: string;
}

function tileSig(item: Extract<Renderable, { layer: "tile" }>): number {
  return (((item.packed & 0xffff) | ((item.stock0 & 0xff) << 16) | ((item.stock1 & 0xff) << 24)) >>> 0);
}
/** VISUAL identity of a card — everything except its cell. A change here rebuilds
 *  the node; a change in `(q, r)` alone keeps the node and glides it (see the
 *  position tween in `tick`), so a move reads as motion instead of a teleport. */
function cardContentSig(item: Extract<Renderable, { layer: "card" }>): string {
  return `${item.packed}|${item.stock}|${item.flags}|${item.offsetX},${item.offsetY}`;
}

/** Per-frame easing factor for the card position tween (fraction of the
 *  remaining distance covered each tick). ~0.25 ≈ a few-frame glide at 60fps. */
const CARD_TWEEN_EASE = 0.25;

/** Alpha of a card while it's being dragged — the ghost (in the scene overlay)
 *  carries the live visual; the source card stays dimmed in place. */
const DRAG_ALPHA = 0.3;

/** The stack fan y-offset (px) the DSL applies to a member's face — mirrors
 *  `functions/01.rd` `stack_layout`: a member's whole face shifts `units * dir *
 *  title_height`, where `units = index` (top member) or `index - 1` (bottom),
 *  `index = slot + 1`, `dir = -1` up / `+1` down / `0` loose. Used by `cardAt`
 *  so a click lands on the SAME fanned face the user sees (the node sits at the
 *  cell; the DSL fans the prims inside it). */
function stackFan(flags: number): { dir: number; index: number } {
  if (!microIsCard(flags)) return { dir: 0, index: 0 };
  const branch = stackBranch(flags);
  const slot = stackIndex(flags);
  const dir = branch === STACK_DIR_UP ? -1 : branch === STACK_DIR_DOWN ? 1 : 0;
  return { dir, index: slot + 1 };
}

/**
 * The dumb world display. Given an anchor `(q, r)` + surface and a display rect,
 * it subscribes to the client's render feed for the cells that fit, streams in
 * the reported renderables, and draws each via the DSL (`tilePrims` /
 * `drawVisuals` → `PrimitiveLayer`). It knows no game rules — only how to turn a
 * `Renderable` into pixels and where to put it. Panning moves one container; the
 * world is built on enter and dropped on exit (retained-mode).
 *
 * Streaming model: every feed generation (`gen`, bumped on each pan/resize) is
 * accumulated into a "present" set; the trailing `final` batch drops any retained
 * cell the generation didn't mention. Stale lower-`gen` batches are ignored, so a
 * fast pan can't interleave old tiles.
 */
export class WorldRenderer extends LayoutNode {
  private readonly panLayer = new Container();
  private readonly cardLayer = new Container();
  /** The detached, world-positioned container holding every visible tile's prims —
   *  the `bg`, the `clippedHex`/fill GROUND, AND standing `sprite` OBJECTS (trees,
   *  bushes). Never in the scene: it's the bake SOURCE the rect composite renders
   *  dirty rectangles from (per-rect, z-sorted there, so child order is irrelevant).
   *  Objects span several rectangles; a change dirties all of them. */
  private readonly primSource = new Container();
  /** The wrap-around ground composite (albedo, no lighting in M1). Bakes dirty
   *  rectangles once and pans for free; produces the display RT shown by
   *  {@link groundMesh}. Assigned in the constructor (needs `gctx.geometry`). */
  private readonly albedo: RectComposite;
  /** The ground display: ≤4 seam-split quads whose shader samples the albedo + normal
   *  composites and applies the HOT (dynamic) lights live each frame. BELOW `panLayer`
   *  so objects/cards draw over it. */
  private readonly groundShader: GroundShader = makeGroundShader();
  /** Display mesh: up to 4 quads (16 verts) splitting the window at the torus wrap,
   *  so no quad samples across the seam. `fillDisplay` rewrites pos/uv each frame. */
  private readonly groundPosBuf = new Buffer({ data: new Float32Array(32), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
  private readonly groundUvBuf = new Buffer({ data: new Float32Array(32), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
  private readonly groundGeo = new Geometry({
    attributes: {
      aPosition: { buffer: this.groundPosBuf, format: "float32x2" },
      aUV: { buffer: this.groundUvBuf, format: "float32x2" },
    },
    indexBuffer: new Buffer({ data: DISPLAY_INDICES.slice(), usage: BufferUsage.INDEX | BufferUsage.COPY_DST }),
  });
  private readonly groundMesh = new Mesh({ geometry: this.groundGeo, shader: this.groundShader });
  /** HOT (dynamic) lights packed into the ground shader each frame. [0] is the cursor
   *  light (`screen` = panel px, follows the pointer); `screen:false` lights are world
   *  px (+pan at pack). Up to {@link MAX_HOT_LIGHTS}. */
  private readonly hotLights: { x: number; y: number; height: number; radius: number; color: number; brightness: number; screen: boolean }[] = [
    { x: 0, y: 0, height: 110, radius: 480, color: 0xffffff, brightness: 2.0, screen: true },
  ];
  /** Cursor light positioned by a real pointer move yet? (else centre it). */
  private cursorMoved = false;
  /** Cold (static, baked) light fixtures placed yet? (placed once the composite is ready). */
  private coldSet = false;
  private readonly onCursorMove: (e: FederatedPointerEvent) => void;
  private readonly grid = new HexMath(worldHexRadius());
  private readonly deps: PrimDeps;
  /** This viewport's deferred lighting (world-space, scoped here). Owns the lit-sprite
   *  registry every `LitSprite` registers with; the light/normal passes are dormant in
   *  M1 (ground composite is flat albedo) and re-wired at the lighting milestone. */
  private readonly deferred = new DeferredLighting();
  /** Set when any LOD texture finishes loading; the next `tick` re-resolves
   *  present tiles/cards so substitutes (64px) swap up to the ideal LOD. Many
   *  load events coalesce into one re-resolve per frame. */
  private texturesDirty = false;
  private readonly unsubLod: () => void;

  private anchorQ: number;
  private anchorR: number;
  private readonly surface: number;
  private readonly owner: number;

  /** Selection highlight, drawn over the selected card's footprint. */
  private readonly selectionGfx = new Graphics();
  /** `?rectview` debug overlay: the x/y rectangle grid (red), drawn in world space
   *  so it pans with the world — to eyeball rect alignment against the hexes. */
  private readonly rectGrid = new Graphics();
  private selectedCardId: number | null = null;
  /** Selected world tile cell, or null. Mutually exclusive with a card
   *  selection (the scene clears one when it sets the other). Stored as the cell
   *  key — `desiredTiles` carries its live packed/stock. */
  private selectedTile: { q: number; r: number } | null = null;

  private feed: ViewportFeed | null = null;
  private lastRegion: RenderRegion | null = null;
  /** Unsubscribe from content reloads (a gate hot-swap → rebuild retained nodes). */
  private readonly unsubContent: () => void;

  private latestGen = 0;
  private readonly tiles = new Map<string, TileNode>();
  private readonly cards = new Map<number, CardNode>();
  private readonly desiredTiles = new Map<string, TileSpec>();
  private readonly desiredCards = new Map<number, CardSpec>();
  private readonly presentTiles = new Set<string>();
  private readonly presentCards = new Set<number>();
  private readonly tileQueue: string[] = [];
  private readonly cardQueue: number[] = [];
  private readonly queuedTiles = new Set<string>();
  private readonly queuedCards = new Set<number>();
  private animating = false;
  /** Monotonic id source for tile ground entries in the rect composite's index. */
  private nextPrimId = 1;

  /** Cards currently being dragged (dimmed in place; the ghost shows the move). */
  private readonly draggingCards = new Set<number>();
  /** Pending start positions (panLayer-local) for cards not yet built — a card
   *  dropped into THIS surface starts at the drop point, then tweens to its cell. */
  private readonly dropSeed = new Map<number, { x: number; y: number }>();

  constructor(
    private readonly gctx: GameContext,
    surface: number,
    owner: number,
    anchor: { q: number; r: number },
  ) {
    super();
    this.setContext(gctx);
    this.surface = surface;
    this.owner = owner;
    this.anchorQ = anchor.q;
    this.anchorR = anchor.r;

    this.cardLayer.sortableChildren = true;
    // One composite, the ALBEDO channel (a composite of every tile prim's albedo —
    // ground AND objects). Generalized: a `normal` (and lit/emissive/depth) channel
    // is one more spec here at the lighting milestone — same slots/anchor/dirty index.
    this.albedo = new RectComposite(this.primSource, gctx.geometry, [
      // ALBEDO: each prim's colour, transparent where there's no geometry.
      { name: "albedo", texOf: (s) => s.albedoTexture ?? s.texture, clearColor: [0, 0, 0, 0] },
      // NORMAL: each prim's normal map (white-tinted so the albedo colour can't skew
      // the vector), skipped where a prim has none so the flat-up clear (+Z) shows.
      { name: "normal", texOf: (s) => s.normalTexture ?? null, clearColor: [0.5, 0.5, 1, 1], whiteTint: true },
    ]);
    this.panLayer.addChild(this.cardLayer, this.selectionGfx, this.rectGrid);
    // Ground is the shader-displayed albedo composite, BELOW `panLayer` so
    // objects/cards draw over it.
    this.container.addChild(this.groundMesh, this.panLayer);

    this.deps = {
      lod: gctx.lodTextures,
      deferred: this.deferred,
      whiteTexture: atlasWhite(gctx.textures, gctx.app.renderer),
      hexTexture: atlasHex(gctx.textures, gctx.app.renderer),
      seed: 0,
      progress: () => -1,
      queue: () => -1,
    };

    // Cursor light: project the global pointer into this panel's local px (the space
    // the shader sums hot lights in) and move light[0] there. `globalpointermove`
    // fires regardless of hit-testing; a pointer over another viewport lands off this
    // panel so the light naturally leaves. Stage must be event-enabled.
    gctx.app.stage.eventMode = "static";
    this.onCursorMove = (e: FederatedPointerEvent) => {
      const p = this.container.toLocal(e.global);
      this.hotLights[0].x = p.x;
      this.hotLights[0].y = p.y;
      this.cursorMoved = true;
    };
    gctx.app.stage.on("globalpointermove", this.onCursorMove);

    // LOD upgrade: prims resolve a 64px substitute while the ideal LOD loads;
    // when it lands, re-resolve so they swap up (the resolver now returns the
    // cached upgrade). Coalesced to one pass per frame in `tick`.
    this.unsubLod = gctx.lodTextures.onLoad(() => { this.texturesDirty = true; });
    // Gate content hot-swap: drop + rebuild retained nodes against the new defs.
    this.unsubContent = onContentReloaded(() => this.reload());

    // Eagerly warm the low-res preview atlas for every stem the content can
    // produce (content is loaded by the time we're in the world). Fire-and-forget
    // — the full-res buckets still stream lazily per-tile, but their placeholders
    // are ready so streaming art shows colour/shape, not white.
    this.prewarmPreviews();
  }

  /** Kick the preview prewarm for the whole content stem set (see
   *  {@link LodTextureManager.prewarmPreviews}). Re-run on reload — the swapped
   *  content may add objects/variations. */
  private prewarmPreviews(): void {
    void this.gctx.lodTextures.prewarmPreviews(sharedContent().previewStems());
    // NB: geometry is NOT prewarmed here — an all-stems prewarm floods the browser
    // connection pool + the gate (each cold sidecar = a gate generation + R2 master
    // read), starving the texture loads. It's fetched lazily on-demand instead (the
    // placeholder's `geometry.get(stem)`), which only touches the visible set; the
    // tiny JSON still lands before that card's texture. Bulk delivery is the future
    // login BUNDLE (one request), not an N-fetch prewarm.
  }

  /** Rebuild every retained tile/card against freshly-reloaded content. A def's
   *  visuals or label can change with no data-row change, so the signature
   *  reconcile in {@link applyBatch} won't catch it — we drop all nodes and
   *  re-aim the feed so the next emit rebuilds them with the new `Content`.
   *  Driven by {@link onContentReloaded} (after `Content`/`Locales` are swapped). */
  reload(): void {
    for (const t of this.tiles.values()) {
      t.prims.destroy();
      t.bg.destroy();
    }
    this.albedo.reset(); // drop the prim index + re-bake the window for new defs
    for (const c of this.cards.values()) c.node.destroy({ children: true });
    this.tiles.clear();
    this.cards.clear();
    this.desiredTiles.clear();
    this.desiredCards.clear();
    this.presentTiles.clear();
    this.presentCards.clear();
    this.queuedTiles.clear();
    this.queuedCards.clear();
    this.tileQueue.length = 0;
    this.cardQueue.length = 0;
    // Force a fresh region aim so the worker re-emits the current view; the
    // cleared maps make every reported item rebuild from scratch.
    this.lastRegion = null;
    this.syncRegion();
    // Swapped content may have added objects/variations — warm their previews.
    this.prewarmPreviews();
  }

  /** The current anchor cell (fractional). */
  anchor(): { q: number; r: number } {
    return { q: this.anchorQ, r: this.anchorR };
  }

  /** Convert a pixel displacement to a cell displacement (linear hex inverse) —
   *  the pan controller's pixel-drag → anchor-delta conversion. */
  pixelDeltaToCell(dx: number, dy: number): { q: number; r: number } {
    return this.grid.pixelToCellFractional(dx, dy);
  }

  /** Recenter the world on a fractional cell (drag-pan or programmatic). */
  setAnchor(q: number, r: number): void {
    if (this.anchorQ === q && this.anchorR === r) return;
    this.anchorQ = q;
    this.anchorR = r;
    this.invalidate();
  }

  /** The card_id whose footprint contains the global (canvas-local CSS px) point,
   *  topmost first, or `null`. Used by the scene to resolve a click to a card. */
  cardAt(globalX: number, globalY: number): number | null {
    const p = this.panLayer.toLocal(new Point(globalX, globalY));
    const cw = global("card_width");
    const bh = global("body_height");
    const th = global("title_height");
    const ch = th + bh; // full card face = title strip + body
    let best: number | null = null;
    let bestZ = -Infinity;
    for (const [id, node] of this.cards) {
      const spec = this.desiredCards.get(id);
      if (!spec) continue;
      const c = this.grid.cellToPixel(spec.q, spec.r);
      // Hit-test the FULL fanned face (title + body), not just the body box at
      // the cell, so a click on a stack member's exposed title strip selects
      // THAT member instead of always the topmost-z root. Mirror the DSL fan
      // (`stack_layout`): face shifts `units*dir*th`; the title sits above the
      // body for top/loose members, below for bottom members.
      const { dir, index } = stackFan(spec.flags);
      const units = dir > 0 ? index - 1 : index;
      const fanDy = units * dir * th;
      const x0 = c.x - cw / 2 + spec.offsetX;
      // Face top: body-top + fan, minus the title for top/loose (title above).
      const faceTop = c.y - bh / 2 + spec.offsetY + fanDy - (dir > 0 ? 0 : th);
      if (p.x >= x0 && p.x < x0 + cw && p.y >= faceTop && p.y < faceTop + ch) {
        const z = node.node.zIndex;
        if (z >= bestZ) {
          bestZ = z;
          best = id;
        }
      }
    }
    return best;
  }

  /** The tile at the global (canvas-local CSS px) point — its packed def + stock
   *  + cell — or `null` if no tile is rendered there. Used by the scene to route
   *  a click that missed all cards to the underlying tile (for details). */
  tileAt(globalX: number, globalY: number): { packed: number; q: number; r: number; stock0: number; stock1: number } | null {
    const p = this.panLayer.toLocal(new Point(globalX, globalY));
    const f = this.grid.pixelToCellFractional(p.x, p.y);
    const cell = this.grid.roundCell(f.q, f.r);
    const spec = this.desiredTiles.get(`${cell.q},${cell.r}`);
    if (!spec) return null;
    return { packed: spec.packed, q: cell.q, r: cell.r, stock0: spec.stock0, stock1: spec.stock1 };
  }

  /** The cell `(q, r)` under a global (canvas-local CSS px) point — the drop
   *  target. Returns the nearest hex even if no tile is rendered there. */
  cellAt(globalX: number, globalY: number): { q: number; r: number } {
    const p = this.panLayer.toLocal(new Point(globalX, globalY));
    const f = this.grid.pixelToCellFractional(p.x, p.y);
    return this.grid.roundCell(f.q, f.r);
  }

  /** Dim/undim a card in place while it's dragged (the overlay ghost carries the
   *  live move). Survives a rebuild via `draggingCards`. */
  setCardDragging(id: number, on: boolean): void {
    if (on) this.draggingCards.add(id);
    else this.draggingCards.delete(id);
    const c = this.cards.get(id);
    if (c) c.node.alpha = on ? DRAG_ALPHA : 1;
  }

  /** Seed a card's start position to a global drop point: if it's rendered here
   *  now, move it there immediately; otherwise stash it so its next build starts
   *  there. Either way the position tween then glides it to its data cell. */
  seedDropPosition(id: number, globalX: number, globalY: number): void {
    const p = this.panLayer.toLocal(new Point(globalX, globalY));
    const c = this.cards.get(id);
    if (c) c.node.position.set(p.x, p.y);
    else this.dropSeed.set(id, { x: p.x, y: p.y });
  }

  /** Highlight `id` (or clear with `null`). The outline tracks the card each
   *  frame in `tick`. */
  selectCard(id: number | null): void {
    this.selectedCardId = id;
    if (id === null) this.selectionGfx.clear();
  }

  selectedCard(): number | null {
    return this.selectedCardId;
  }

  /** Highlight a world tile cell (or clear with `null`). Like {@link selectCard}
   *  the outline tracks the cell each frame in `tick`. */
  selectTile(cell: { q: number; r: number } | null): void {
    this.selectedTile = cell;
    if (cell === null) this.selectionGfx.clear();
  }

  /** The selected tile's display info — packed def + cell + raw stock slots — or
   *  null. Mirrors {@link cardInfo}; feeds the `/edit` tile path. */
  selectedTileInfo(): { packed: number; q: number; r: number; stock0: number; stock1: number } | null {
    if (!this.selectedTile) return null;
    const spec = this.desiredTiles.get(`${this.selectedTile.q},${this.selectedTile.r}`);
    if (!spec) return null;
    return { packed: spec.packed, q: spec.q, r: spec.r, stock0: spec.stock0, stock1: spec.stock1 };
  }

  /** The packed definition of a known card (for an aspect lookup), or null. */
  cardPacked(id: number): number | null {
    return this.desiredCards.get(id)?.packed ?? null;
  }

  /** Full display info for a known card — packed def, absolute world hex,
   *  and the raw stock/flags words — or null. Feeds the details panel. */
  cardInfo(id: number): { packed: number; q: number; r: number; stock: number; flags: number } | null {
    const s = this.desiredCards.get(id);
    if (!s) return null;
    return { packed: s.packed, q: s.q, r: s.r, stock: s.stock, flags: s.flags };
  }

  /** Named render-texture channels for the `/showRT` dev preview. M1 produces only
   *  the ground composite's albedo display RT; the normal/depth/lit/emissive
   *  G-buffers are dormant (the lighting passes are re-wired at the lighting
   *  milestone — see {@link DeferredLighting}) and report `null` until their
   *  composites come online. Stable order so the preview tiles don't reshuffle as
   *  channels light up. The textures are LIVE (re-rendered each frame), so a sprite
   *  pointing at one shows the current frame for free. */
  renderTextures(): { name: string; texture: RenderTexture | null }[] {
    return [
      // The FIXED-slot composites (the maps themselves) — not the sliding display
      // copies. `albedo` is a composite of every ground prim's albedo.
      { name: "albedo",   texture: this.albedo.channelComposite("albedo") },
      { name: "normal",   texture: this.albedo.channelComposite("normal") },
      { name: "depth",    texture: this.albedo.depthTexture }, // baked sort-Y (objects only)
      { name: "lit",      texture: this.albedo.lightmapTexture }, // the baked cold-light map
      { name: "shadow",   texture: this.albedo.shadowMaskTexture }, // hot-light shadow mask (RGB = light 0/1/2)
      { name: "emissive", texture: null },
    ];
  }

  /** This viewport's display aspect ratio (width / height), so the `/showRT`
   *  preview tiles can match the viewport's shape (including dormant channels with
   *  no texture to read it from). 0 before the first layout. */
  aspect(): number {
    return this.height > 0 ? this.width / this.height : 0;
  }

  // ── layout: reposition the pan container + re-aim the region ────────
  protected override layout(): boolean {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const c = this.grid.cellToPixel(this.anchorQ, this.anchorR);
    this.panLayer.position.set(cx - c.x, cy - c.y);
    this.syncRegion();
    return false;
  }

  /** (Re)compute the region for the current anchor + size; open the feed on first
   *  sizing, re-aim it when the covered cell rect changes. */
  private syncRegion(): void {
    if (this.width <= 0 || this.height <= 0) return;
    const { halfCols, halfRows } = this.grid.coverHalfExtents(this.width, this.height, OVERSCAN_MARGIN);
    const region: RenderRegion = {
      surface: this.surface,
      owner: this.owner,
      q: Math.round(this.anchorQ),
      r: Math.round(this.anchorR),
      halfCols,
      halfRows,
    };
    if (this.sameRegion(region, this.lastRegion)) return;
    this.lastRegion = region;
    if (this.feed) this.feed.update(region);
    else this.feed = this.gctx.client.openViewport(region, (b) => this.applyBatch(b));
  }

  private sameRegion(a: RenderRegion, b: RenderRegion | null): boolean {
    return (
      b !== null &&
      a.surface === b.surface &&
      a.q === b.q &&
      a.r === b.r &&
      a.halfCols === b.halfCols &&
      a.halfRows === b.halfRows
    );
  }

  // ── streaming ingest ───────────────────────────────────────────────
  private applyBatch(b: RenderBatch): void {
    if (b.gen < this.latestGen) return; // stale generation — a newer pan superseded it
    if (b.gen > this.latestGen) {
      this.latestGen = b.gen;
      this.presentTiles.clear();
      this.presentCards.clear();
    }
    for (const item of b.items) {
      if (item.layer === "tile") {
        const key = `${item.q},${item.r}`;
        this.presentTiles.add(key);
        const sig = tileSig(item);
        const node = this.tiles.get(key);
        if (!node || node.sig !== sig) {
          this.desiredTiles.set(key, { q: item.q, r: item.r, packed: item.packed, stock0: item.stock0, stock1: item.stock1, sig });
          if (!this.queuedTiles.has(key)) {
            this.queuedTiles.add(key);
            this.tileQueue.push(key);
          }
        }
      } else {
        this.presentCards.add(item.cardId);
        const sig = cardContentSig(item);
        const node = this.cards.get(item.cardId);
        // Always refresh the desired spec — its `(q, r)` is the tween TARGET the
        // position tween in `tick` reads each frame.
        this.desiredCards.set(item.cardId, {
          q: item.q, r: item.r, offsetX: item.offsetX, offsetY: item.offsetY,
          packed: item.packed, stock: item.stock, flags: item.flags, sig,
        });
        // Rebuild ONLY when the visual content changed (or the card is new). A
        // pure `(q, r)` move keeps the node and glides it via the tween — no
        // teleport, no wholesale rebuild.
        if (!node || node.sig !== sig) {
          if (!this.queuedCards.has(item.cardId)) {
            this.queuedCards.add(item.cardId);
            this.cardQueue.push(item.cardId);
          }
        }
      }
    }
    if (b.final) this.dropAbsent();
  }

  /** Drop retained tiles/cards the just-finished generation didn't report. */
  private dropAbsent(): void {
    for (const [key, node] of this.tiles) {
      if (this.presentTiles.has(key)) continue;
      this.albedo.removeTile(node.primId); // dirties the vacated rects → re-bake empty
      node.prims.destroy();
      node.bg.destroy();
      this.tiles.delete(key);
      this.desiredTiles.delete(key);
    }
    for (const [id, node] of this.cards) {
      if (this.presentCards.has(id)) continue;
      node.node.destroy({ children: true });
      this.cards.delete(id);
      this.desiredCards.delete(id);
    }
  }

  // ── per-frame build pump ───────────────────────────────────────────
  /** Drain a slice of the build queue and advance any prim easing. Driven by the
   *  scene each frame; bounded by {@link BUILD_BUDGET} so large regions stream. */
  tick(): void {
    // Re-aim the gate region EVERY frame from the current anchor. `pan.update()`
    // moves the anchor per-frame but only marks the panel dirty; `layout()` (the
    // sole other `syncRegion` caller) runs on the layout-flush, NOT every frame —
    // so without this, the worker's view-anchor lags/skips the positions a pan
    // sweeps through and those zones are never requested (permanent blank gaps).
    // Cheap: `syncRegion`'s `sameRegion` guard no-ops unless the region changed.
    this.syncRegion();
    let built = 0;
    while (built < BUILD_BUDGET && this.tileQueue.length > 0) {
      const key = this.tileQueue.shift()!;
      this.queuedTiles.delete(key);
      const spec = this.desiredTiles.get(key);
      if (!spec || !this.presentTiles.has(key)) continue;
      this.buildTile(key, spec);
      built++;
    }
    while (built < BUILD_BUDGET && this.cardQueue.length > 0) {
      const id = this.cardQueue.shift()!;
      this.queuedCards.delete(id);
      const spec = this.desiredCards.get(id);
      if (!spec || !this.presentCards.has(id)) continue;
      this.buildCard(id, spec);
      built++;
    }
    // Position tween: glide each card from its current pixel position toward its
    // target cell, so a move (a `(q, r)` change with unchanged content — e.g. a
    // soul walking) reads as motion instead of a teleport. The node was built at
    // its cell; `desiredCards` carries the live target. Content changes rebuild
    // (snapping to the new cell); only pure moves glide here. Runs every tick (the
    // scene drives `tick` per frame), so no `animating` gate is needed.
    for (const [id, c] of this.cards) {
      const spec = this.desiredCards.get(id);
      if (!spec) continue;
      const p = this.grid.cellToPixel(spec.q, spec.r);
      const tx = p.x + c.ox;
      const ty = p.y + c.oy;
      const dx = tx - c.node.position.x;
      const dy = ty - c.node.position.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        c.node.position.set(c.node.position.x + dx * CARD_TWEEN_EASE, c.node.position.y + dy * CARD_TWEEN_EASE);
        c.node.zIndex = Math.round(c.node.position.y - c.oy) + c.stackZ; // sort by current screen-Y
      } else if (dx !== 0 || dy !== 0) {
        c.node.position.set(tx, ty); // settle exactly at the target
        c.node.zIndex = Math.round(p.y) + c.stackZ;
      }
    }

    if (this.animating) {
      let active = false;
      for (const t of this.tiles.values()) {
        // A still-easing tile's ground prims move/resize → re-index + re-bake the
        // rectangles they now cover, so the baked composite tracks the final pose.
        if (t.prims.settle()) { active = true; this.registerTilePrims(t); }
      }
      for (const c of this.cards.values()) if (c.layer?.settle()) active = true;
      this.animating = active;
    }
    this.drawSelection();

    // Apply any LOD upgrades that landed since last frame (coalesced). A tile's
    // ground texture swapping (64px → ideal LOD) needs its rectangles re-baked.
    if (this.texturesDirty) {
      this.texturesDirty = false;
      for (const t of this.tiles.values()) { t.prims.refreshTextures(); this.registerTilePrims(t); }
      for (const c of this.cards.values()) c.layer?.refreshTextures();
    }

    // Ground composite (M1): size to the panel, recenter the wrap-around window on
    // the anchor (revealed strips go dirty), bake the dirty rects into the composite
    // under budget, then copy the visible window to the display RT at the live pan
    // offset. Idle = no bake (nothing dirty); pan = one revealed row/column strip.
    const renderer = this.gctx.app.renderer;
    this.albedo.resize(this.width, this.height, renderer);
    // Authoritative pan THIS frame, from the live anchor — `layout()` (the other
    // `panLayer.position` writer) runs on the layout-flush, not every frame, so during
    // a smooth pan it lags. Compute it here (same formula as `layout`) and set it, so
    // the composite window (recenter), the display copy and the live object/card layers
    // ALL use one anchor value — otherwise the ground jumps against the window/objects.
    const a = this.grid.cellToPixel(this.anchorQ, this.anchorR);
    const panX = this.width / 2 - a.x;
    const panY = this.height / 2 - a.y;
    this.panLayer.position.set(panX, panY);
    this.albedo.recenter(a.x, a.y);
    this.ensureColdLights(a.x, a.y);
    this.albedo.bakeDirty(renderer, BAKE_BUDGET);
    this.albedo.bakeLightDirty(renderer, BAKE_BUDGET); // re-bake stale lightmap slots (cold lights)
    this.updateGroundMesh(renderer, panX, panY);
    if (RECTVIEW) {
      this.drawRectGrid();
      if (this.albedo.lastBaked > 0) {
        debug.log(["render"], `[rectview] baked ${this.albedo.lastBaked} rectangles`, 5);
      }
    }
  }

  /** Point the ground display quad at the panel + feed the shader the window/pan so
   *  it samples the right composite slot per fragment. The composite never moves;
   *  the pan lives entirely in the shader's per-fragment world→slot mapping. */
  private updateGroundMesh(renderer: Renderer, panX: number, panY: number): void {
    if (!this.albedo.ready) return;
    const alb = this.albedo.channelComposite("albedo");
    const nrm = this.albedo.channelComposite("normal");
    if (!alb || !nrm) return;
    // Rebuild the ≤4 seam-split quads for this pan, then point at both G-buffers.
    this.albedo.fillDisplay(panX, panY, this.groundPosBuf.data as Float32Array, this.groundUvBuf.data as Float32Array);
    this.groundPosBuf.update();
    this.groundUvBuf.update();
    this.groundShader.albedo = alb;
    this.groundShader.normal = nrm;
    const lm = this.albedo.lightmapTexture;
    if (lm) this.groundShader.lightmap = lm;
    this.packHotLights(panX, panY);
    this.buildShadowMask(renderer, panX, panY);
  }

  /** Rebuild the projected-silhouette shadow mask for the hot lights (≤3 cast — one per
   *  mask channel) and point the ground shader at it. Light positions are resolved to
   *  panel px exactly as `packHotLights` does (cursor centres until the pointer moves;
   *  world lights add the pan), then `RectComposite` projects the casters per light. */
  private buildShadowMask(renderer: Renderer, panX: number, panY: number): void {
    const n = Math.min(this.hotLights.length, MAX_SHADOW_LIGHTS);
    const lights: { x: number; y: number; z: number; radius: number }[] = [];
    for (let i = 0; i < n; i++) {
      const l = this.hotLights[i];
      let x = l.x;
      let y = l.y;
      if (l.screen && !this.cursorMoved) { x = this.width / 2; y = this.height / 2; }
      else if (!l.screen) { x += panX; y += panY; }
      lights.push({ x, y, z: l.height, radius: l.radius });
    }
    this.albedo.buildShadowMask(renderer, lights, panX, panY);
    const mask = this.albedo.shadowMaskTexture;
    if (mask) this.groundShader.shadowMask = mask;
    const depth = this.albedo.depthTexture;
    if (depth) this.groundShader.depth = depth;
    this.groundShader.setPanelSize(this.width, this.height);
  }

  /** Place the cold (static, baked) light fixtures once the composite is sized — two
   *  world-anchored torches (warm + cool) that pan with the world. The ambient floor
   *  lives in the lightmap. A demo set until authored `^light` cards drive cold lights. */
  private ensureColdLights(anchorWorldX: number, anchorWorldY: number): void {
    if (this.coldSet || !this.albedo.ready) return;
    this.coldSet = true;
    this.albedo.setColdLights([
      { x: anchorWorldX - 220, y: anchorWorldY - 120, height: 120, radius: 380, color: 0xffa64d, brightness: 2.2 },
      { x: anchorWorldX + 260, y: anchorWorldY + 140, height: 120, radius: 380, color: 0x5aa0ff, brightness: 2.0 },
    ], 0.22);
  }

  /** Pack the hot lights into the ground shader (panel px). The cursor light (screen)
   *  centres on first frame until the pointer moves; world lights add the pan. */
  private packHotLights(panX: number, panY: number): void {
    const n = Math.min(this.hotLights.length, MAX_HOT_LIGHTS);
    const data = new Float32Array(MAX_HOT_LIGHTS * 4);
    const color = new Float32Array(MAX_HOT_LIGHTS * 4);
    for (let i = 0; i < n; i++) {
      const l = this.hotLights[i];
      let x = l.x;
      let y = l.y;
      if (l.screen && !this.cursorMoved) { x = this.width / 2; y = this.height / 2; }
      else if (!l.screen) { x += panX; y += panY; }
      data[i * 4] = x; data[i * 4 + 1] = y; data[i * 4 + 2] = l.height; data[i * 4 + 3] = l.radius;
      color[i * 4] = ((l.color >> 16) & 0xff) / 255;
      color[i * 4 + 1] = ((l.color >> 8) & 0xff) / 255;
      color[i * 4 + 2] = (l.color & 0xff) / 255;
      color[i * 4 + 3] = l.brightness;
    }
    this.groundShader.setLights(data, color, n);
  }

  /** `?rectview`: outline every rectangle in the visible area in red (world space,
   *  so it pans with the world). The grid lines sit at world `col·W` / `row·H`, the
   *  exact lattice the composite bakes + copies on — to confirm rect↔hex alignment. */
  private drawRectGrid(): void {
    const W = rectW();
    const H = rectH();
    const panX = this.panLayer.position.x;
    const panY = this.panLayer.position.y;
    const x0 = -panX;
    const x1 = this.width - panX;
    const y0 = -panY;
    const y1 = this.height - panY;
    this.rectGrid.clear();
    for (let c = Math.floor((x0 - rectOffX()) / W); c <= Math.ceil((x1 - rectOffX()) / W); c++) {
      const lx = rectWorldX(c);
      this.rectGrid.moveTo(lx, y0).lineTo(lx, y1);
    }
    for (let r = Math.floor((y0 - rectOffY()) / H); r <= Math.ceil((y1 - rectOffY()) / H); r++) {
      const ly = rectWorldY(r);
      this.rectGrid.moveTo(x0, ly).lineTo(x1, ly);
    }
    this.rectGrid.stroke({ color: 0xff0000, width: 1, alpha: 0.6 });
  }

  override setBounds(x: number, y: number, width: number, height: number): void {
    super.setBounds(x, y, width, height);
  }

  /** Redraw the selection outline over the selected card's footprint (it pans
   *  with `panLayer`, so this stays aligned). Cleared when nothing is selected or
   *  the selected card left the view. */
  private drawSelection(): void {
    this.selectionGfx.clear();
    this.selectionGfx.zIndex = 1e9; // above cards within panLayer
    // Card selection — a rounded rect around the (possibly fanned) card body.
    const id = this.selectedCardId;
    const cardSpec = id !== null && this.cards.has(id) ? this.desiredCards.get(id) : undefined;
    if (cardSpec) {
      const cw = global("card_width");
      const bh = global("body_height");
      const c = this.grid.cellToPixel(cardSpec.q, cardSpec.r);
      const x0 = c.x - cw / 2 + cardSpec.offsetX;
      const y0 = c.y - bh / 2 + cardSpec.offsetY;
      this.selectionGfx
        .roundRect(x0 - 3, y0 - 3, cw + 6, bh + 6, 4)
        .stroke({ color: 0xffd54f, width: 3, alpha: 0.95 });
    }
    // Tile selection — a hex outline tracing the cell (only while it's built).
    const t = this.selectedTile;
    if (t && this.tiles.has(`${t.q},${t.r}`)) {
      const c = this.grid.cellToPixel(t.q, t.r);
      // Same radius the tile body is baked + spaced at, so the outline traces the
      // hex edge exactly (width = √3·r, height = 2·r — see `hexSize`).
      this.selectionGfx
        .poly(hexPoints(c.x, c.y, worldHexRadius()))
        .stroke({ color: 0xffd54f, width: 3, alpha: 0.95 });
    }
  }


  private buildTile(key: string, spec: TileSpec): void {
    const center = this.grid.cellToPixel(spec.q, spec.r);
    const hexW = worldHexWidth();
    const hexH = worldHexHeight();
    const cornerX = center.x - hexW / 2;
    const cornerY = center.y - hexH / 2;
    const def = this.gctx.definitions.decode(spec.packed);

    let node = this.tiles.get(key);
    if (!node) {
      const bg = new HexTileVisual(
        this.deferred,
        this.deps.hexTexture ?? this.deps.whiteTexture,
      );
      // No per-tile root: bg carries absolute world px and lives in the detached
      // prim SOURCE, below every fill prim (the clippedHex grass covers it). The
      // rect composite bakes that source into its wrap-around albedo.
      bg.position.set(cornerX, cornerY);
      bg.zIndex = TILE_BG_Z;
      this.primSource.addChild(bg);
      const prims = new PrimitiveLayer(
        cardBox(hexW, hexH, { x: cornerX, y: cornerY }),
        this.deps,
        // ALL tile prims — ground fills (`rect`/`hex`) AND objects (`sprite`) — go
        // into the baked source; the composite bakes each by its footprint (objects
        // span several rectangles). Both targets are the source.
        { target: this.primSource, groundTarget: this.primSource },
      );
      node = { primId: this.nextPrimId++, bg, prims, sig: spec.sig };
      this.tiles.set(key, node);
    } else {
      node.sig = spec.sig;
      node.prims.setBox(cardBox(hexW, hexH, { x: cornerX, y: cornerY }));
    }
    node.bg.draw(def);
    this.deps.seed = cellHash(spec.q, spec.r);
    node.prims.draw(tilePrims(spec.packed, spec.stock0, spec.stock1, this.deps.seed));
    // Register this tile's primitives (bg + ground fills + object sprites) into the
    // composite's data rectangles. Each prim is indexed by the rectangles its
    // footprint covers; a dirty rectangle re-bakes every prim's portion in it.
    this.registerTilePrims(node);
    this.animating = true;
  }

  /** (Re)register a tile's primitives (bg + ground fills + object sprites) with the
   *  composite. Called on build and each settle step while the prims ease (footprint
   *  + art settle), so the baked rectangles track the final pose. */
  private registerTilePrims(node: TileNode): void {
    this.albedo.setTilePrims(node.primId, [node.bg, ...node.prims.litSprites()]);
  }

  private buildCard(id: number, spec: CardSpec): void {
    const center = this.grid.cellToPixel(spec.q, spec.r);
    const def = this.gctx.definitions.decode(spec.packed);
    this.deps.faction = (def ? this.gctx.definitions.cardFactionOverride(def) : null) ?? undefined;
    // Seed the DSL's art-variant picker (e.g. which robot portrait a Human soul
    // shows) from the card's STABLE identity, not the shared `this.deps.seed`
    // last written by a tile (`cellHash(q,r)`) or its 0 default — otherwise the
    // variant re-rolls every time the card node is dropped on viewport exit and
    // rebuilt on re-entry. `card_id` is stable for the card's lifetime (matches
    // the old client's `seed: cardId`).
    this.deps.seed = id;

    // Decode the card's placement from its flags. A stack member is positioned at
    // its root's cell (the feed already resolved `spec.q/r` to the root's cell);
    // the DSL fans it from there via `card_data.stack.{index,dir}`. A loose card is
    // flat. We just dump the card's state in — the DSL owns the offset + sizing.
    const stacked = microIsCard(spec.flags);
    const branch = stacked ? stackBranch(spec.flags) : 0;
    const slot = stacked ? stackIndex(spec.flags) : 0;
    const dir = branch === STACK_DIR_UP ? -1 : branch === STACK_DIR_DOWN ? 1 : 0;
    const host: HostValue = {
      stack: { state: branch, index: stacked ? slot + 1 : 0, dir },
      loose: stacked ? 0 : 1,
      hovered: 0,
      selected: id === this.selectedCardId ? 1 : 0,
      pending: 0,
      dragging: 0,
      progress: [],
    };
    const prims = drawVisuals(spec.packed, { card_data: host }, "init");

    // Rebuild from scratch (sig-gated upstream, so infrequent): the real-vs-
    // fallback choice can flip as content resolves, so swap the node wholesale.
    this.cards.get(id)?.node.destroy();

    let node: Container;
    let layer: PrimitiveLayer | null = null;
    // Origin offset from the cell centre (so the tween can recompute the target
    // node position from `cellToPixel(q,r)` later): the prims layer draws from
    // the body's top-left; the fallback marker is centred.
    let ox = 0;
    let oy = 0;
    if (prims.length > 0) {
      // Real DSL visuals. Body origin is the card's top-left; the title strip sits
      // above at negative y (same convention as GenericCardFace).
      layer = new PrimitiveLayer(cardBox(global("card_width"), global("body_height")), this.deps);
      layer.draw(prims);
      ox = -global("card_width") / 2;
      oy = -global("body_height") / 2;
      node = layer;
    } else {
      // No generic visuals for this packed (a soul instance) — fallback marker.
      node = this.makeFallbackMarker(id);
    }
    // A just-dropped card starts at the drop point (seed) so the position tween
    // glides it from there to its data cell; otherwise it appears at its cell.
    const seed = this.dropSeed.get(id);
    if (seed) {
      node.position.set(seed.x, seed.y);
      this.dropSeed.delete(id);
    } else {
      node.position.set(center.x + ox, center.y + oy);
    }
    if (this.draggingCards.has(id)) node.alpha = DRAG_ALPHA;
    // Depth: a stack member sits just behind its root (up) or in front (down) so
    // the fan reads right; loose cards sort by screen-Y.
    const stackZ = dir * (stacked ? slot + 1 : 0);
    node.zIndex = Math.round(center.y) + stackZ;
    this.cardLayer.addChild(node);
    this.cards.set(id, { node, layer, sig: spec.sig, ox, oy, stackZ });
    this.animating = true;
  }

  /** A tinted hex + `#id` label for a card the content can't render. */
  private makeFallbackMarker(id: number): Container {
    const marker = new Container();
    const r = worldHexRadius() * 0.55;
    const hex = new Graphics()
      .poly(hexPoints(0, 0, r))
      .fill({ color: CARD_COLORS[id % CARD_COLORS.length], alpha: 0.92 })
      .stroke({ color: 0xffffff, width: 2, alpha: 0.85 });
    const label = new Text({ text: `#${id}`, style: { fill: 0x0b1018, fontSize: 16, fontWeight: "bold" } });
    label.anchor.set(0.5);
    marker.addChild(hex, label);
    return marker;
  }

  override destroy(): void {
    this.feed?.close();
    this.feed = null;
    this.gctx.app.stage.off("globalpointermove", this.onCursorMove);
    this.unsubLod();
    this.unsubContent();
    this.deferred.destroy();
    for (const t of this.tiles.values()) {
      t.prims.destroy();
      t.bg.destroy();
    }
    this.albedo.destroy();
    this.primSource.destroy({ children: true });
    this.groundMesh.destroy();
    for (const c of this.cards.values()) c.node.destroy({ children: true });
    this.tiles.clear();
    this.cards.clear();
    super.destroy();
  }
}
