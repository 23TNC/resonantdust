import { Assets, Graphics, Rectangle, RenderTexture, Texture, type Renderer } from "pixi.js";
import {
  channelUrl,
  pickLodForSize,
  LOD_SIZES,
  MIN_LOD,
  PREVIEW_LOD,
  type Channel,
} from "../lodUrls";
import { TextureManager, type PackedPair } from "./TextureManager";
import { debug } from "../../debug";

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
 * white fallback. `onLoad` fires when any of those land so consumers re-resolve
 * to the upgrade (white → preview → full-res).
 */
export class LodTextureManager {
  private readonly textures: TextureManager;
  /** Independent atlas holding only low-res `PREVIEW_LOD` placeholders. Kept
   *  separate from the master atlas so previews never compete for slots with
   *  full-res art and persist as a fallback once loaded. */
  private readonly preview: TextureManager;
  private readonly renderer: Renderer;
  private readonly qualityCap: number;
  /** Master atlas-packed triple keyed by `${stem}@${size}`. */
  private readonly byKey = new Map<string, PackedPair>();
  /** Keys whose master load is in flight (dedupe). */
  private readonly loading = new Set<string>();
  /** Preview atlas-packed triple keyed by stem (one preview size per stem). */
  private readonly previewByKey = new Map<string, PackedPair>();
  /** Stems whose preview load is in flight (dedupe). */
  private readonly previewLoading = new Set<string>();
  /** Per-stem largest bucket known to exist (set on first successful descend),
   *  so the picker clamps the ideal and avoids re-probing absent buckets. */
  private readonly maxSize = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private whiteFallback: Texture | null = null;
  /** The gate's HTTP origin (`http(s)://host:port`), set at login. The fallback
   *  target when an R2-direct LOD fetch 404s: `<gateBase>/textures/lod/...`
   *  generates the LOD from the master on demand. `null` until a gate is selected
   *  (pre-login) — fetches then stay R2-direct-only. */
  private gateBase: string | null = null;
  /** Fetch scheduler lanes. Real (on-screen) loads enqueue HIGH, preview prewarm
   *  enqueues LOW; {@link pump} always starts HIGH before LOW, so a visible tile's
   *  texture never queues behind hundreds of off-screen previews (which, on a cold
   *  corpus, each pay gate generation latency). */
  private readonly highQueue: Array<() => Promise<unknown>> = [];
  private readonly lowQueue: Array<() => Promise<unknown>> = [];
  private activeFetches = 0;

  constructor(textures: TextureManager, renderer: Renderer, options?: { qualityCap?: number }) {
    this.textures = textures;
    this.preview = new TextureManager(renderer);
    this.renderer = renderer;
    this.qualityCap = options?.qualityCap ?? DEFAULT_QUALITY_CAP;
  }

  /** Point the on-miss fallback at the selected environment's gate (its HTTP
   *  origin, e.g. `http://localhost:8474`). Called at login alongside the wasm
   *  client's gate URL so generated LODs come from the same gate as the data. */
  setGateBase(httpBase: string): void {
    this.gateBase = httpBase.replace(/\/$/, "");
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

  /** Resolve a stem to its atlas-packed albedo+normal+emissive triple, with the
   *  substitute + white-fallback cascade. Never returns null. Empty stem (the VM
   *  couldn't resolve it) → white. */
  getPair(stem: string, desiredSize: number): PackedPair {
    if (!stem) return this.whitePair();
    let ideal = pickLodForSize(Math.min(desiredSize, this.qualityCap));
    const known = this.maxSize.get(stem);
    if (known !== undefined && ideal > known) ideal = pickLodForSize(known);

    const key = `${stem}@${ideal}`;
    const cached = this.byKey.get(key);
    if (cached) return cached;

    if (!this.loading.has(key)) {
      this.loading.add(key);
      this.schedule(() => this.load(stem, ideal, key), "high");
    }
    // Best already-loaded full-res bucket for this stem (Pixi downscales cleanly).
    const substitute = this.findCachedSubstitute(stem);
    if (substitute) return substitute;
    // No full-res yet → fall back to the low-res PREVIEW atlas (kicking its load
    // on first miss); white only if even the preview hasn't landed.
    return this.getPreview(stem) ?? this.whitePair();
  }

  /** Cached preview for the stem, or null if its prewarm hasn't landed yet (or it
   *  has no small bucket). Previews are loaded EAGERLY by {@link prewarmPreviews}
   *  at login — NOT lazily here — so by the time an object renders its placeholder
   *  is already packed and a streaming full-res texture upgrades from colour/shape
   *  rather than flashing white. */
  private getPreview(stem: string): PackedPair | null {
    return this.previewByKey.get(stem) ?? null;
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

  private whitePair(): PackedPair {
    return { albedo: this.ensureWhiteFallback(), normal: null, emissive: null };
  }

  /** Highest-resolution already-cached bucket for this stem (Pixi downscales
   *  cleanly), or null. */
  private findCachedSubstitute(stem: string): PackedPair | null {
    for (let i = LOD_SIZES.length - 1; i >= 0; i--) {
      const cached = this.byKey.get(`${stem}@${LOD_SIZES[i]}`);
      if (cached) return cached;
    }
    return null;
  }

  private ensureWhiteFallback(): Texture {
    if (this.whiteFallback) return this.whiteFallback;
    const g = new Graphics();
    g.rect(0, 0, MIN_LOD, MIN_LOD).fill({ color: 0xffffff });
    const rt = RenderTexture.create({ width: MIN_LOD, height: MIN_LOD });
    this.renderer.render({ container: g, target: rt, clear: true });
    g.destroy();
    const atlas = this.textures.pack(rt).albedo;
    rt.destroy(true);
    this.whiteFallback = atlas;
    return atlas;
  }

  destroy(): void {
    this.byKey.clear();
    this.loading.clear();
    this.previewByKey.clear();
    this.previewLoading.clear();
    this.preview.destroy();
    this.maxSize.clear();
    this.whiteFallback = null;
    // Drop queued (not-yet-started) fetches; in-flight ones settle and decrement.
    this.highQueue.length = 0;
    this.lowQueue.length = 0;
  }

  /** Fetch + pack the stem at `ideal` (albedo + optional normal/emissive),
   *  R2-direct with a gate fallback per channel. Caches the result under
   *  `${stem}@${ideal}`. The gate clamps a request above the master's native
   *  resolution, so a too-large `ideal` returns a smaller image — harmless, the
   *  draw-scale math keys off the texture's own width. `idealKey` is released
   *  from `loading` regardless so a later reference can retry. */
  private async load(stem: string, ideal: number, idealKey: string): Promise<void> {
    let landedKey: string | null = null;
    try {
      const albedoSrc = await this.fetchChannel(stem, ideal, "albedo");
      if (albedoSrc) {
        const normalSrc = await this.fetchChannel(stem, ideal, "normal");
        const emissiveSrc = await this.fetchChannel(stem, ideal, "emissive");
        const packed = this.textures.pack(albedoSrc, normalSrc, emissiveSrc);
        const key = `${stem}@${ideal}`;
        this.byKey.set(key, {
          albedo: insetFrame(packed.albedo, FRAME_INSET),
          normal: packed.normal ? insetFrame(packed.normal, FRAME_INSET) : null,
          emissive: packed.emissive ? insetFrame(packed.emissive, FRAME_INSET) : null,
        });
        if (ideal > (this.maxSize.get(stem) ?? 0)) this.maxSize.set(stem, ideal);
        landedKey = key;
      }
    } catch (err) {
      debug.warn(["lod"], `[lod] failed to load ${stem}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loading.delete(idealKey);
    }
    if (landedKey) for (const cb of this.listeners) cb();
  }

  /** Fetch one channel for `stem` at `size`: R2-direct first (the CDN serves
   *  every cache hit, off the gate's bandwidth budget), then — on a 404 — the
   *  gate, which generates the LOD from the master, caches it in R2, and returns
   *  the bytes. Returns null if neither has it (the channel has no master, the
   *  common case for `emissive`). Both URLs cache independently in PIXI Assets;
   *  within a session the packed result is held in `byKey`, so we never re-probe. */
  private async fetchChannel(stem: string, size: number, channel: Channel): Promise<Texture | null> {
    const direct = channelUrl(stem, size, channel); // R2-direct via Assets basePath
    const fromCache = await loadOrNull(direct);
    if (fromCache) return fromCache;
    if (this.gateBase) {
      const viaGate = `${this.gateBase}/textures/lod/${size}/${stem}.${channel}.png`;
      const generated = await loadOrNull(viaGate);
      if (generated) return generated;
    }
    return null;
  }

  /** Fetch + pack the stem's `PREVIEW_LOD` placeholder into the dedicated preview
   *  atlas (R2-direct, gate on miss — same path as {@link load}). Cached under the
   *  bare stem (one preview per stem); fires `onLoad` so consumers swap the white
   *  fallback for the preview in place. Best-effort: a stem with no master simply
   *  stays on white until... it has no master, so it stays white. */
  private async loadPreview(stem: string): Promise<void> {
    let landed = false;
    try {
      const albedoSrc = await this.fetchChannel(stem, PREVIEW_LOD, "albedo");
      if (albedoSrc) {
        const normalSrc = await this.fetchChannel(stem, PREVIEW_LOD, "normal");
        const emissiveSrc = await this.fetchChannel(stem, PREVIEW_LOD, "emissive");
        const packed = this.preview.pack(albedoSrc, normalSrc, emissiveSrc);
        this.previewByKey.set(stem, {
          albedo: insetFrame(packed.albedo, FRAME_INSET),
          normal: packed.normal ? insetFrame(packed.normal, FRAME_INSET) : null,
          emissive: packed.emissive ? insetFrame(packed.emissive, FRAME_INSET) : null,
        });
        landed = true;
      }
    } catch (err) {
      debug.warn(["lod"], `[lod] preview load failed ${stem}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.previewLoading.delete(stem);
    }
    if (landed) for (const cb of this.listeners) cb();
  }
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

function insetFrame(tex: Texture, inset: number): Texture {
  const { x, y, width, height } = tex.frame;
  return new Texture({
    source: tex.source,
    frame: new Rectangle(x + inset, y + inset, width - inset * 2, height - inset * 2),
  });
}
