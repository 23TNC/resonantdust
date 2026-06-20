import { Assets, Container, Graphics, Rectangle, RenderTexture, Sprite, Texture, type Renderer } from "pixi.js";
import {
  channelUrl,
  pickLodForSize,
  LOD_SIZES,
  MIN_LOD,
  PREVIEW_LOD,
  type Channel,
} from "../lodUrls";
import { TextureManager, type PackedPair, type SlotHandle } from "./TextureManager";
import { getPreview, putPreview } from "./previewCache";
import { debug } from "../../debug";
import type { GeometryStore } from "../geometry/GeometryStore";
import type { Sidecar } from "../geometry/geoTypes";

/** Content tiers a master-atlas frame can hold (only ever upgrades). */
const enum FrameLevel {
  Geo = 1,
  Preview = 2,
  Real = 3,
}

/** A master-atlas frame entry. The `pair` (albedo/normal/emissive frames) is bound
 *  by sprites ONCE and never re-issued; `rewrite` re-renders the slot in place
 *  (geo → preview → real LOD), so bound sprites follow the upgrade with no swap.
 *  `level` is the current content tier; the preview-atlas reuses this shape without
 *  `rewrite`/`level` (it's a plain `packTracked` slot). */
interface LodEntry {
  readonly pair: PackedPair;
  readonly handle: SlotHandle;
  readonly rewrite?: (albedo: Texture | null, normal: Texture | null, emissive: Texture | null) => void;
  level?: FrameLevel;
}

/** Pixels trimmed off each side of a packed frame, so bilinear sampling can't
 *  bleed from neighbouring atlas slots. */
const FRAME_INSET = 2;

/** Ceiling on the LOD bucket the picker selects — a texture-quality knob. */
const DEFAULT_QUALITY_CAP = 1024;

/** Concurrent in-flight channel loads across both priority lanes. Caps the gate
 *  generation pressure (and browser socket pool) so the HIGH lane drains quickly;
 *  ~the browser's per-origin socket budget, doubled for the R2+gate origins. */
const MAX_CONCURRENT_FETCHES = 8;

/**
 * LOD-aware lazy loader + atlas cache. Input is a RESOLVED STEM
 * (`<category>.<biome>/<object>.<faction>/<id>.<count>.<part>`) produced by the
 * wasm `^r2` resolver — the manager owns only "which LOD size, fetch from R2,
 * pack." No glob, no cascade, no variation pick (all upstream now).
 *
 * **LOD by R2-direct, gate on miss.** Each channel is fetched R2-direct first
 * (the CDN serves every cache hit, keeping the gate out of the texture-bandwidth
 * budget). On a 404 — the LOD hasn't been generated yet — the loader retries the
 * same path against the **gate**, which generates the LOD from the master on
 * demand, caches it in R2, and returns the bytes (see the gateway `lod` module).
 * So only LODs that are actually requested ever get generated and stored.
 *
 * **Always returns a PackedPair.** While a stem loads, `get` returns the best
 * already-cached smaller bucket for the same stem; failing that, the low-res
 * PREVIEW atlas (a separate atlas of `PREVIEW_LOD` placeholders, kicked on
 * demand); only if even the preview is absent does it fall to the MIN_LOD-square
 * transparent fallback. `onLoad` fires when any of those land so consumers
 * re-resolve to the upgrade (transparent → preview → full-res).
 */
export class LodTextureManager {
  private readonly textures: TextureManager;
  /** Independent atlas holding only low-res `PREVIEW_LOD` placeholders. Kept
   *  separate from the master atlas so previews never compete for slots with
   *  full-res art and persist as a fallback once loaded. */
  private readonly preview: TextureManager;
  private readonly renderer: Renderer;
  private readonly qualityCap: number;
  /** Master atlas entry keyed by `${stem}@${size}`. The stem includes any
   *  `?v=<hash>` version suffix, so a re-mastered object's bytes are a distinct
   *  key (new fetch) and the old one is evictable (see {@link evictStaleVersions}). */
  private readonly byKey = new Map<string, LodEntry>();
  /** Keys whose master load is in flight (dedupe). */
  private readonly loading = new Set<string>();
  /** Preview atlas entry keyed by the (versioned) stem — one preview per stem. */
  private readonly previewByKey = new Map<string, LodEntry>();
  /** Stems whose preview load is in flight (dedupe). */
  private readonly previewLoading = new Set<string>();
  /** Per-stem largest bucket known to exist (set on first successful descend),
   *  so the picker clamps the ideal and avoids re-probing absent buckets. */
  private readonly maxSize = new Map<string, number>();
  /** The currently-cached versioned stem per base stem (path without `?v=`), so a
   *  changed version evicts the previous one's atlas slots. Only tracked for
   *  versioned stems — un-versioned content never evicts. */
  private readonly versionedByBase = new Map<string, string>();
  /** Hex-clipped tile textures keyed by stem. `src` is the source albedo the clip
   *  was baked from, so the clip re-bakes when the LOD upgrades (preview→full) and
   *  is otherwise reused across every tile sharing that texture. */
  private readonly hexClipped = new Map<
    string,
    { src: Texture; level: number; pair: PackedPair; handle: SlotHandle }
  >();
  private readonly listeners = new Set<() => void>();
  private transparentFallback: Texture | null = null;
  /** The gate's HTTP origin (`http(s)://host:port`), set at login. The fallback
   *  target when an R2-direct LOD fetch 404s: `<gateBase>/textures/lod/...`
   *  generates the LOD from the master on demand. `null` until a gate is selected
   *  (pre-login) — fetches then stay R2-direct-only. */
  private gateBase: string | null = null;
  /** The R2/CDN texture origin (PIXI's `Assets` basePath), for the byte fetches
   *  the persisted-preview path uses (`fetch().arrayBuffer()` needs an absolute
   *  URL, unlike `Assets.load` which rewrites a relative one). Empty = same-origin. */
  private textureBase = "";
  /** Fetch scheduler lanes. Real (on-screen) loads enqueue HIGH, preview prewarm
   *  enqueues LOW; {@link pump} always starts HIGH before LOW, so a visible tile's
   *  texture never queues behind hundreds of off-screen previews (which, on a cold
   *  corpus, each pay gate generation latency). */
  private readonly highQueue: Array<() => Promise<unknown>> = [];
  private readonly lowQueue: Array<() => Promise<unknown>> = [];
  private activeFetches = 0;
  /** Silhouette geometry source — fills a frame with a flat-colour triangulation
   *  when neither the real LOD nor a preview is available yet. Wired post-construct
   *  (both managers built in `main`); null = no geo fallback (just transparent). */
  private geometry: GeometryStore | null = null;
  /** 1×1 flat-up (+Z) normal, scaled into the normal frame whenever a fill has no
   *  real normal (geo / a preview or LOD that lacks one) — so it lights flat. */
  private readonly flatNormal: Texture;

  constructor(textures: TextureManager, renderer: Renderer, options?: { qualityCap?: number }) {
    this.textures = textures;
    this.preview = new TextureManager(renderer);
    this.renderer = renderer;
    this.qualityCap = options?.qualityCap ?? DEFAULT_QUALITY_CAP;
    this.flatNormal = makeFlatNormal();
  }

  /** Wire the geometry source (the geo fill tier). Re-fire our own listeners when a
   *  sidecar lands, so the world re-resolves and allocates the geo frame. */
  setGeometry(geometry: GeometryStore): void {
    this.geometry = geometry;
    geometry.onLoad(() => {
      for (const cb of this.listeners) cb();
    });
  }

  /** Point the on-miss fallback at the selected environment's gate (its HTTP
   *  origin, e.g. `http://localhost:8474`). Called at login alongside the wasm
   *  client's gate URL so generated LODs come from the same gate as the data. */
  setGateBase(httpBase: string): void {
    this.gateBase = httpBase.replace(/\/$/, "");
  }

  /** The R2/CDN origin PIXI's `Assets` was inited with — so the persisted-preview
   *  path can build absolute URLs for its `fetch()` byte reads. Set once at boot. */
  setTextureBase(base: string): void {
    this.textureBase = base.replace(/\/$/, "");
  }

  /** Subscribe to load-completion (fires once per stem@size as it lands). */
  onLoad(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Atlas-packed albedo for the stem at the requested draw size. See {@link getPair}. */
  get(stem: string, desiredSize: number): Texture {
    return this.getPair(stem, desiredSize).albedo;
  }

  /** Resolve `stem` and return it **clipped to the hex cell** (`hexMask`'s alpha),
   *  packed into the atlas — for textured tiles. Cached per stem and re-baked only
   *  when the LOD upgrades (preview→full), so every tile sharing a texture reuses
   *  one clipped frame. While the source is still the transparent placeholder it's
   *  returned unclipped, so the solid-colour tile bg shows through until grass lands. */
  getHexClipped(stem: string, desiredSize: number, hexMask: Texture, fillScale: number): PackedPair {
    if (!stem) return this.transparentPair();
    const source = this.getPair(stem, desiredSize);
    if (source.albedo === this.ensureTransparentFallback()) return source; // not loaded yet
    // The stable frame is rewritten IN PLACE as its tier upgrades (geo→preview→real),
    // so its `albedo` Texture identity never changes — the bake must re-run when the
    // CONTENT level advances, not on identity (which would freeze the clip at whatever
    // tier was resident at first bake, e.g. the blurry preview).
    const level = this.byKey.get(`${stem}@${this.idealFor(stem, desiredSize)}`)?.level ?? 0;
    const prev = this.hexClipped.get(stem);
    if (prev && prev.src === source.albedo && prev.level === level) return prev.pair;
    if (prev) prev.handle.release();
    const baked = this.bakeHexClip(source, hexMask, fillScale);
    this.hexClipped.set(stem, { src: source.albedo, level, pair: baked.pair, handle: baked.handle });
    return baked.pair;
  }

  /** Cover-stretch each channel of `source` over the hex bbox, clip by `hexMask`'s
   *  alpha, and pack the result as one atlas slot. The hex mask already carries a
   *  transparent pad, so no frame inset is needed (the seams between tiles stay
   *  tight). */
  private bakeHexClip(
    source: PackedPair,
    hexMask: Texture,
    fillScale: number,
  ): { pair: PackedPair; handle: SlotHandle } {
    const w = Math.round(hexMask.frame.width);
    const h = Math.round(hexMask.frame.height);
    const albedoRT = this.renderMasked(source.albedo, hexMask, w, h, fillScale);
    const normalRT = source.normal ? this.renderMasked(source.normal, hexMask, w, h, fillScale) : null;
    const emissiveRT = source.emissive ? this.renderMasked(source.emissive, hexMask, w, h, fillScale) : null;
    const { pair, handle } = this.textures.packTracked(albedoRT, normalRT, emissiveRT);
    albedoRT.destroy(true);
    normalRT?.destroy(true);
    emissiveRT?.destroy(true);
    return { pair, handle };
  }

  /** Render `src` cover-fitted over the hex cell and masked by `hexMask`'s alpha
   *  into a fresh RenderTexture. The fit is UNIFORM (preserving aspect — a
   *  non-uniform stretch would squish the hexagon) and scaled to cover the cell
   *  bbox with a small overscale, so the master's hex (slightly inset in its
   *  square) fully fills the cell hex; the mask clips the overflow. */
  private renderMasked(
    src: Texture,
    hexMask: Texture,
    w: number,
    h: number,
    fillScale: number,
  ): RenderTexture {
    const rt = RenderTexture.create({ width: w, height: h });
    const cont = new Container();
    const tex = new Sprite(src);
    // Cover-fit the cell (universal), then the DSL-supplied `fillScale` overscale
    // (per tile texture, set by its ground pack) closes the master's hex inset.
    const scale = Math.max(w / src.width, h / src.height) * fillScale;
    tex.anchor.set(0.5);
    tex.scale.set(scale);
    tex.position.set(w / 2, h / 2);
    const mask = new Sprite(hexMask);
    mask.width = w;
    mask.height = h;
    cont.addChild(tex, mask);
    cont.mask = mask;
    this.renderer.render({ container: cont, target: rt, clear: true });
    cont.destroy({ children: true });
    return rt;
  }

  /** Resolve a stem to its ONE stable atlas frame at the requested LOD. The frame is
   *  allocated on first request from the best content available (preview → geo) and
   *  rewritten in place as better content lands (preview/geo → real LOD), so the
   *  bound sprite never swaps texture. Returns transparent only until the very first
   *  content (geo/preview/real) for the stem exists. */
  /** The LOD bucket `getPair` resolves `desiredSize` to — clamped by the quality cap
   *  and the largest bucket known to exist for the stem. Shared with `getHexClipped`
   *  so both look up the SAME `byKey` entry (and thus its content level). */
  private idealFor(stem: string, desiredSize: number): number {
    let ideal = pickLodForSize(Math.min(desiredSize, this.qualityCap));
    const known = this.maxSize.get(stem);
    if (known !== undefined && ideal > known) ideal = pickLodForSize(known);
    return ideal;
  }

  getPair(stem: string, desiredSize: number): PackedPair {
    if (!stem) return this.transparentPair();
    this.evictStaleVersions(stem);
    const ideal = this.idealFor(stem, desiredSize);
    const key = `${stem}@${ideal}`;

    const entry = this.byKey.get(key);
    if (entry) {
      this.ensureRealLoad(stem, ideal, key);
      // Upgrade a geo frame in place once its preview lands (preview beats geo);
      // the real LOD still rewrites over the top when it arrives.
      if ((entry.level ?? 0) < FrameLevel.Preview) {
        const preview = this.getPreview(stem);
        if (preview) {
          entry.rewrite?.(preview.albedo, preview.normal ?? this.flatNormal, preview.emissive);
          entry.level = FrameLevel.Preview;
        }
      }
      return entry.pair;
    }
    // No frame yet — kick the real + preview loads, then allocate from whatever
    // content is available NOW (preview beats geo; the real LOD allocates via load).
    this.ensureRealLoad(stem, ideal, key);
    this.ensurePreviewLoad(stem);
    const preview = this.getPreview(stem);
    if (preview) return this.allocateFromPreview(key, ideal, preview).pair;
    const sidecar = this.geometry?.get(stem) ?? null; // also kicks the geo fetch
    if (sidecar) return this.allocateFromGeo(key, ideal, sidecar).pair;
    return this.transparentPair();
  }

  /** Schedule the real-LOD load for `key` unless it's already loaded (level Real)
   *  or in flight. */
  private ensureRealLoad(stem: string, ideal: number, key: string): void {
    if (this.loading.has(key)) return;
    if ((this.byKey.get(key)?.level ?? 0) >= FrameLevel.Real) return;
    this.loading.add(key);
    this.schedule(() => this.load(stem, ideal, key), "high");
  }

  /** Kick the low-res preview load for `stem` unless cached or in flight. */
  private ensurePreviewLoad(stem: string): void {
    if (this.previewByKey.has(stem) || this.previewLoading.has(stem)) return;
    this.previewLoading.add(stem);
    this.schedule(() => this.loadPreview(stem), "low");
  }

  /** Allocate a stable SQUARE frame at the LOD bucket size and fill it by scaling
   *  the preview triple up into the slot. The master is square, so the preview
   *  (and every later tier) is square — slot, frame, and source all match. */
  private allocateFromPreview(key: string, ideal: number, preview: PackedPair): LodEntry {
    const entry = this.allocateFrame(key, ideal, FrameLevel.Preview);
    entry.rewrite!(preview.albedo, preview.normal ?? this.flatNormal, preview.emissive);
    return entry;
  }

  /** Allocate a stable SQUARE frame at the LOD bucket size and fill it with the geo
   *  triangulation (flat-up normal so it lights flat). The sidecar coords are
   *  normalized by the (square) master, so they map straight into the square. */
  private allocateFromGeo(key: string, ideal: number, sidecar: Sidecar): LodEntry {
    const entry = this.allocateFrame(key, ideal, FrameLevel.Geo);
    const geoRT = this.renderGeo(sidecar, ideal);
    entry.rewrite!(geoRT, this.flatNormal, null);
    geoRT.destroy(true);
    return entry;
  }

  /** Allocate the stable SQUARE atlas frame for `key` at `size×size`, store + return
   *  the entry. Every streamed-art frame is a pow2 square — the master is square, so
   *  geo/preview/real all share one square slot (slot == frame, no waste, no
   *  cross-tier aspect mismatch). Inset like every other packed frame so bilinear
   *  sampling can't bleed from a neighbouring atlas slot. */
  private allocateFrame(key: string, size: number, level: FrameLevel): LodEntry {
    const { pair, handle, rewrite } = this.textures.packResizable(size, size);
    const entry: LodEntry = { pair: insetPair(pair), handle, rewrite, level };
    this.byKey.set(key, entry);
    return entry;
  }

  /** Render the sidecar's earcut triangles (flat dominant colour) into a fresh
   *  `size×size` RenderTexture — the geo placeholder source the frame is filled
   *  from. Coords are normalized by the square master, so `× size` reproduces the
   *  silhouette's master framing (centered, padded) inside the square. */
  private renderGeo(sidecar: Sidecar, size: number): RenderTexture {
    const rt = RenderTexture.create({ width: size, height: size });
    const g = new Graphics();
    for (const poly of sidecar.polygons) {
      const verts = poly.contour.concat(...poly.holes);
      const t = poly.triangles;
      for (let i = 0; i + 2 < t.length; i += 3) {
        const a = verts[t[i]];
        const b = verts[t[i + 1]];
        const c = verts[t[i + 2]];
        if (!a || !b || !c) continue;
        g.moveTo(a[0] * size, a[1] * size)
          .lineTo(b[0] * size, b[1] * size)
          .lineTo(c[0] * size, c[1] * size)
          .closePath();
      }
    }
    g.fill({ color: parseHexColor(sidecar.color) });
    this.renderer.render({ container: g, target: rt, clear: true });
    g.destroy();
    return rt;
  }

  /** When a versioned stem's `?v=<hash>` differs from the one currently cached for
   *  its base path (a re-mastered object), release every cached size + the preview
   *  of the OLD version — freeing their atlas slots — so superseded versions don't
   *  accumulate. No-op for an un-versioned stem or an unchanged version. */
  private evictStaleVersions(stem: string): void {
    const q = stem.indexOf("?");
    if (q < 0) return; // un-versioned — nothing to track or evict
    const base = stem.slice(0, q);
    const prev = this.versionedByBase.get(base);
    if (prev !== undefined && prev !== stem) {
      for (const size of LOD_SIZES) {
        const k = `${prev}@${size}`;
        this.byKey.get(k)?.handle.release();
        this.byKey.delete(k);
        this.loading.delete(k);
      }
      this.previewByKey.get(prev)?.handle.release();
      this.previewByKey.delete(prev);
      this.previewLoading.delete(prev);
      this.maxSize.delete(prev);
      this.hexClipped.get(prev)?.handle.release();
      this.hexClipped.delete(prev);
    }
    this.versionedByBase.set(base, stem);
  }

  /** Cached preview for the stem, or null if its prewarm hasn't landed yet (or it
   *  has no small bucket). Previews are loaded EAGERLY by {@link prewarmPreviews}
   *  at login — NOT lazily here — so by the time an object renders its placeholder
   *  is already packed and a streaming full-res texture upgrades from colour/shape
   *  rather than popping in from nothing. */
  private getPreview(stem: string): PackedPair | null {
    return this.previewByKey.get(stem)?.pair ?? null;
  }

  /** Enqueue a `PREVIEW_LOD` placeholder load for every stem into the preview
   *  atlas, on the LOW scheduler lane. Call at login (fire-and-forget): the
   *  full-res buckets still stream lazily per-object on the HIGH lane, which
   *  always preempts these — so prewarm fills idle fetch capacity without delaying
   *  the textures actually on screen. Idempotent — stems already cached or in
   *  flight are skipped, so a content reload re-call only fetches genuinely new
   *  stems. `onLoad` fires per landed preview so placeholders pop in. */
  prewarmPreviews(stems: readonly string[]): void {
    for (const s of stems) {
      if (!s || this.previewByKey.has(s) || this.previewLoading.has(s)) continue;
      this.previewLoading.add(s);
      this.schedule(() => this.loadPreview(s), "low");
    }
  }

  /** Enqueue a fetch task in the given lane and pump the pool. */
  private schedule(task: () => Promise<unknown>, lane: "high" | "low"): void {
    (lane === "high" ? this.highQueue : this.lowQueue).push(task);
    this.pump();
  }

  /** Start queued tasks up to the concurrency budget, HIGH lane first — so a
   *  newly-visible tile's load runs ahead of any pending preview prewarm. */
  private pump(): void {
    while (this.activeFetches < MAX_CONCURRENT_FETCHES) {
      const task = this.highQueue.shift() ?? this.lowQueue.shift();
      if (!task) return;
      this.activeFetches++;
      void task().finally(() => {
        this.activeFetches--;
        this.pump();
      });
    }
  }

  private transparentPair(): PackedPair {
    return { albedo: this.ensureTransparentFallback(), normal: null, emissive: null };
  }

  /** A fully transparent MIN_LOD square, packed once into the atlas. Players
   *  prefer an invisible placeholder over a white square, so an unresolved /
   *  not-yet-loaded sprite renders as nothing rather than a flash of white.
   *  (An empty Graphics rendered with `clear: true` leaves the RT cleared to
   *  transparent black `(0,0,0,0)`.) */
  private ensureTransparentFallback(): Texture {
    if (this.transparentFallback) return this.transparentFallback;
    const g = new Graphics();
    const rt = RenderTexture.create({ width: MIN_LOD, height: MIN_LOD });
    this.renderer.render({ container: g, target: rt, clear: true });
    g.destroy();
    const atlas = this.textures.pack(rt).albedo;
    rt.destroy(true);
    this.transparentFallback = atlas;
    return atlas;
  }

  destroy(): void {
    this.byKey.clear();
    this.loading.clear();
    this.previewByKey.clear();
    this.previewLoading.clear();
    this.preview.destroy();
    this.maxSize.clear();
    this.versionedByBase.clear();
    this.hexClipped.clear();
    this.transparentFallback = null;
    // Drop queued (not-yet-started) fetches; in-flight ones settle and decrement.
    this.highQueue.length = 0;
    this.lowQueue.length = 0;
  }

  /** Fetch the real LOD for `key` (albedo + optional normal/emissive), R2-direct
   *  with a gate fallback per channel, and land it into the stem's STABLE frame:
   *  rewrite the slot in place if a geo/preview frame already exists (so bound
   *  sprites upgrade with no swap), else allocate a fresh frame from the real dims.
   *  The gate clamps a request above the master's native resolution, so a too-large
   *  `ideal` returns a smaller image — harmless, it's scaled into the square LOD-bucket
   *  slot. `key` is released from `loading` regardless so a later reference can
   *  retry. */
  private async load(stem: string, ideal: number, key: string): Promise<void> {
    let landed = false;
    try {
      const albedoSrc = await this.fetchChannel(stem, ideal, "albedo");
      if (albedoSrc) {
        const normalSrc = await this.fetchChannel(stem, ideal, "normal");
        const emissiveSrc = await this.fetchChannel(stem, ideal, "emissive");
        // Reuse the stem's existing stable frame (geo/preview) so every bound
        // sprite follows the upgrade in place; otherwise stand a fresh one up at
        // the real source's aspect.
        const entry = this.byKey.get(key) ?? this.allocateFrame(key, ideal, FrameLevel.Real);
        entry.rewrite?.(albedoSrc, normalSrc ?? this.flatNormal, emissiveSrc);
        entry.level = FrameLevel.Real;
        if (ideal > (this.maxSize.get(stem) ?? 0)) this.maxSize.set(stem, ideal);
        landed = true;
      }
    } catch (err) {
      debug.warn(["lod"], `[lod] failed to load ${stem}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loading.delete(key);
    }
    if (landed) for (const cb of this.listeners) cb();
  }

  /** Fetch one channel for `stem` at `size`: R2-direct first (the CDN serves
   *  every cache hit, off the gate's bandwidth budget), then — on a 404 — the
   *  gate, which generates the LOD from the master, caches it in R2, and returns
   *  the bytes. Returns null if neither has it (the channel has no master, the
   *  common case for `emissive`). Both URLs cache independently in PIXI Assets;
   *  within a session the packed result is held in `byKey`, so we never re-probe. */
  private async fetchChannel(stem: string, size: number, channel: Channel): Promise<Texture | null> {
    // `channelUrl` is version-aware: it splits any `?v=` off the path and re-adds
    // it as the query, so both the R2-direct path and the gate URL carry it.
    const path = channelUrl(stem, size, channel);
    const fromCache = await loadOrNull(path); // R2-direct via Assets basePath
    if (fromCache) return fromCache;
    if (this.gateBase) {
      const generated = await loadOrNull(`${this.gateBase}${path}`);
      if (generated) return generated;
    }
    return null;
  }

  /** Fetch + pack the stem's `PREVIEW_LOD` placeholder into the dedicated preview
   *  atlas (R2-direct, gate on miss — same path as {@link load}). Cached under the
   *  bare stem (one preview per stem); fires `onLoad` so consumers swap the
   *  transparent fallback for the preview in place. Best-effort: a stem with no
   *  master has nothing to show, so it stays transparent. */
  private async loadPreview(stem: string): Promise<void> {
    const { base, version } = splitVersion(stem);
    let landed = false;
    try {
      // 1. Persisted bytes (version-matched) — zero network, can't be HTTP-evicted.
      let bytes = await getPreview(base);
      if (!bytes || bytes.v !== version) {
        // 2. Miss / stale → fetch the channel bytes from R2 (gate on miss) and
        //    write them through to IndexedDB for next session.
        const albedo = await this.fetchBytes(stem, PREVIEW_LOD, "albedo");
        bytes = albedo
          ? {
              v: version,
              albedo,
              normal: await this.fetchBytes(stem, PREVIEW_LOD, "normal"),
              emissive: await this.fetchBytes(stem, PREVIEW_LOD, "emissive"),
            }
          : null;
        if (bytes) void putPreview(base, bytes);
      }
      if (bytes) {
        const albedoTex = await bytesToTexture(bytes.albedo);
        const normalTex = bytes.normal ? await bytesToTexture(bytes.normal) : null;
        const emissiveTex = bytes.emissive ? await bytesToTexture(bytes.emissive) : null;
        const { pair, handle } = this.preview.packTracked(albedoTex, normalTex, emissiveTex);
        this.previewByKey.set(stem, { pair: insetPair(pair), handle });
        // The sources are baked into the atlas page now — free the transient
        // decoded bitmaps (the byte path owns them, unlike Assets-cached textures).
        albedoTex.destroy(true);
        normalTex?.destroy(true);
        emissiveTex?.destroy(true);
        landed = true;
      }
    } catch (err) {
      debug.warn(["lod"], `[lod] preview load failed ${stem}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.previewLoading.delete(stem);
    }
    if (landed) for (const cb of this.listeners) cb();
  }

  /** Fetch one channel's raw PNG bytes for the persisted-preview path: R2-direct
   *  (absolute, via the texture base) first, then the gate on a miss. Null if
   *  neither has it. Distinct from {@link fetchChannel} (which decodes via PIXI
   *  `Assets`) because persistence needs the bytes, not a GPU texture. */
  private async fetchBytes(stem: string, size: number, channel: Channel): Promise<ArrayBuffer | null> {
    const path = channelUrl(stem, size, channel); // version-aware (?v in query)
    const direct = await fetchOrNull(this.textureBase + path);
    if (direct) return direct;
    if (this.gateBase) return fetchOrNull(this.gateBase + path);
    return null;
  }
}

/** Split a resolved stem into its base path and `?v=` version hash (empty for an
 *  un-versioned stem). The base is the persisted-preview store key; the version
 *  is its staleness tag. */
function splitVersion(stem: string): { base: string; version: string } {
  const i = stem.indexOf("?");
  if (i < 0) return { base: stem, version: "" };
  const m = /(?:^|&)v=([^&]*)/.exec(stem.slice(i + 1));
  return { base: stem.slice(0, i), version: m ? m[1] : "" };
}

/** `fetch` `url` to an ArrayBuffer; null on 404 / failure. Used by the persisted-
 *  preview path, which needs the raw bytes (to store) — not a decoded texture. */
async function fetchOrNull(url: string): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch(url);
    return r.ok ? await r.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** Decode PNG bytes into a transient PIXI texture (via `createImageBitmap`). The
 *  caller packs it into the atlas then destroys it — the bytes themselves live in
 *  IndexedDB, not the PIXI Assets cache. */
async function bytesToTexture(buf: ArrayBuffer): Promise<Texture> {
  const bitmap = await createImageBitmap(new Blob([buf], { type: "image/png" }));
  return Texture.from(bitmap);
}

/** Load `url` via PIXI Assets; null if it 404s / fails. A failed load leaves a
 *  rejected entry in the Assets cache, but the packed result is held in `byKey`
 *  for the session, so the same URL is never re-requested anyway. */
async function loadOrNull(url: string): Promise<Texture | null> {
  try {
    await Assets.load(url);
    return Assets.get<Texture>(url) ?? null;
  } catch {
    return null;
  }
}

/** Inset every channel of a packed triple by `FRAME_INSET` (bilinear bleed
 *  guard), preserving nulls. */
function insetPair(pair: PackedPair): PackedPair {
  return {
    albedo: insetFrame(pair.albedo, FRAME_INSET),
    normal: pair.normal ? insetFrame(pair.normal, FRAME_INSET) : null,
    emissive: pair.emissive ? insetFrame(pair.emissive, FRAME_INSET) : null,
  };
}

function insetFrame(tex: Texture, inset: number): Texture {
  const { x, y, width, height } = tex.frame;
  return new Texture({
    source: tex.source,
    frame: new Rectangle(x + inset, y + inset, width - inset * 2, height - inset * 2),
  });
}

/** A 1×1 flat-up (+Z) normal (`#8080ff`), scaled into the normal frame whenever a
 *  fill has no real normal (geo, or a preview/LOD without one) so it lights flat
 *  rather than reading the colour bytes as a normal. */
function makeFlatNormal(): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#8080ff";
  ctx.fillRect(0, 0, 1, 1);
  return Texture.from(canvas);
}

/** Parse a sidecar `#rrggbb` dominant colour to a 0xRRGGBB number for the geo
 *  fill. Falls back to mid-grey on a malformed string. */
function parseHexColor(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  return m ? parseInt(m[1], 16) : 0x808080;
}
