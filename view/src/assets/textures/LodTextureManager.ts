import { Assets, Graphics, Rectangle, RenderTexture, Texture, type Renderer } from "pixi.js";
import {
  resolveVariation,
  resolveAtSize,
  variationsFor,
  prewarmResolved,
  pickLodForSize,
  LOD_SIZES,
  MIN_LOD,
  type ResolvedChannels,
} from "../lodUrls";
import type { PackedPair, TextureManager } from "./TextureManager";
import { debug } from "../../debug";

/** Pixels trimmed off each side of a packed texture's frame. Source PNGs ship
 *  with a transparent margin already baked in; this inset narrows the visible
 *  frame onto the inner artwork so bilinear sampling at sub-pixel positions
 *  can't pick up bleed from neighbouring atlas slots. */
const FRAME_INSET = 2;

/** Default ceiling on the LOD bucket the picker selects, even when `desiredSize`
 *  would resolve higher — a texture-quality knob (lower it to cap atlas memory).
 *  Surfaced as a constructor option for a future settings panel. */
const DEFAULT_QUALITY_CAP = 1024;

/** A fully-specified sprite request: a (category, object) identity, the two
 *  modifier axes (biome, faction) resolved from game state, the draw size, and
 *  the variant picker (`index` pins 1-based, else `seed` picks deterministically). */
export interface PairRequest {
  category: string;
  object: string;
  /** Target draw size in screen px at scale 1.0. The picker resolves the
   *  smallest LOD bucket ≥ this (capped at `qualityCap`). */
  desiredSize: number;
  /** Variant picker when `index` is unset. `seed % variations` — stable. */
  seed: number;
  /** Pin to the i-th variation (1-based), wrapped into range. */
  index?: number;
  /** Category-axis modifier — resolves `<category.biome>` dirs first. */
  biome?: string;
  /** Object-axis modifier — resolves `<object.faction>` dirs first (outranks biome). */
  faction?: string;
}

/** Composite cache key for a resolved triple. MUST include all three channels:
 *  a faction sprite that shares the base albedo+normal but adds its own emissive
 *  is a DIFFERENT pack than the base, even though their albedo URL is identical. */
function keyOf(r: ResolvedChannels): string {
  return `${r.albedo}|${r.normal ?? ""}|${r.emissive ?? ""}`;
}

/**
 * LOD-aware lazy loader, picker, and atlas cache for every sprite the runtime
 * renders. Resolves a {@link PairRequest} to an atlas-packed albedo+normal+
 * emissive triple through the per-channel cascade (see `lodUrls`):
 *
 *   1. Variant pick — `variationsFor(category, object)` (the base-dir floor)
 *      gives the index space; `index` or `seed` selects a variation stem.
 *   2. Channel resolve — `resolveVariation` descends LOD buckets and, at the
 *      chosen size, resolves albedo / normal / emissive EACH through its own
 *      `<category[.biome]>/<object[.faction]>` dir cascade.
 *   3. Cache / load — keyed on the composite triple (see `keyOf`).
 *
 * **Always returns a PackedPair — never null.** While the ideal triple loads,
 * `get` returns the best already-cached substitute (same variation at a
 * different LOD) or the 64×64 white fallback, then fires `onLoad` so consumers
 * re-resolve to the upgrade. When the object has no base variations, or no LOD
 * bucket carries a display channel, it's white permanently.
 */
export class LodTextureManager {
  private readonly textures: TextureManager;
  private readonly renderer: Renderer;
  private readonly qualityCap: number;
  /** Atlas-packed triple keyed by the composite resolved-URL key (see `keyOf`).
   *  Stable: a key's pair is set once and never reassigned, so callers can hold
   *  the reference across frames. */
  private readonly byKey = new Map<string, PackedPair>();
  /** Composite keys whose `Assets.load` is in flight (dedupe). */
  private readonly loading = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private whiteFallback: Texture | null = null;

  constructor(
    textures: TextureManager,
    renderer: Renderer,
    options?: { qualityCap?: number },
  ) {
    this.textures = textures;
    this.renderer = renderer;
    this.qualityCap = options?.qualityCap ?? DEFAULT_QUALITY_CAP;
  }

  /** Subscribe to texture-load completion. Fires once per triple as it lands in
   *  the atlas, so a consumer that resolved a substitute/white fallback can
   *  re-resolve and pick up the upgrade. Returns an unsubscribe fn. */
  onLoad(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Pre-load variation 1 of every base object at the smallest LOD so the
   *  substitute cascade has something to find before the first `get`. Resolves
   *  when every pre-warm load has settled. */
  async prewarm(): Promise<void> {
    await Promise.all(prewarmResolved().map(r => {
      const key = keyOf(r);
      if (this.byKey.has(key) || this.loading.has(key)) return Promise.resolve();
      this.loading.add(key);
      return this.load(key, r);
    }));
  }

  /** Atlas-packed albedo Texture for the request. See {@link getPair}. */
  get(req: PairRequest): Texture {
    return this.getPair(req).albedo;
  }

  /** Resolve a request to its atlas-packed albedo+normal+emissive triple, with
   *  the substitute + white-fallback cascade. Never returns null. */
  getPair(req: PairRequest): PackedPair {
    const cap = Math.min(req.desiredSize, this.qualityCap);
    const idealLod = pickLodForSize(cap);

    const variations = variationsFor(req.category, req.object);
    if (variations.length === 0) return this.whitePair();
    const variation = pickVariation(variations, req.seed, req.index);

    const resolved = resolveVariation(
      req.category, req.biome, req.object, req.faction, variation, idealLod,
    );
    if (!resolved) return this.whitePair();

    const key = keyOf(resolved);
    const cached = this.byKey.get(key);
    if (cached) return cached;

    if (!this.loading.has(key)) {
      this.loading.add(key);
      void this.load(key, resolved);
    }
    return this.findCachedSubstitute(req, variation) ?? this.whitePair();
  }

  private whitePair(): PackedPair {
    return { albedo: this.ensureWhiteFallback(), normal: null, emissive: null };
  }

  /** Best already-cached LOD for the SAME variation as the ideal — walks
   *  `LOD_SIZES` descending so the highest-resolution cached entry wins (Pixi
   *  downscales cleanly). Re-resolves the cascade at each size (an override dir
   *  may exist at some sizes but not others) and checks the composite cache.
   *  Null when no bucket for this variation is cached. */
  private findCachedSubstitute(req: PairRequest, variation: string): PackedPair | null {
    for (let i = LOD_SIZES.length - 1; i >= 0; i--) {
      const r = resolveAtSize(LOD_SIZES[i], req.category, req.biome, req.object, req.faction, variation);
      if (!r) continue;
      const cached = this.byKey.get(keyOf(r));
      if (cached) return cached;
    }
    return null;
  }

  /** Lazy-allocate the 64×64 white fallback Texture into the atlas. Idempotent. */
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
    this.whiteFallback = null;
  }

  private async load(key: string, resolved: ResolvedChannels): Promise<void> {
    let loaded = false;
    try {
      // Load the three channels (each may live in a different cascade dir) and
      // pack them into one shared atlas slot so their frames line up for the
      // lighting passes. Normal / emissive are null when the variant has none.
      const { albedo, normal, emissive } = resolved;
      await Promise.all([
        Assets.load(albedo),
        normal ? Assets.load(normal) : Promise.resolve(),
        emissive ? Assets.load(emissive) : Promise.resolve(),
      ]);
      const albedoSrc = Assets.get<Texture>(albedo);
      if (!albedoSrc) return;
      const normalSrc = normal ? Assets.get<Texture>(normal) ?? null : null;
      const emissiveSrc = emissive ? Assets.get<Texture>(emissive) ?? null : null;
      const packed = this.textures.pack(albedoSrc, normalSrc, emissiveSrc);
      this.byKey.set(key, {
        albedo: insetFrame(packed.albedo, FRAME_INSET),
        normal: packed.normal ? insetFrame(packed.normal, FRAME_INSET) : null,
        emissive: packed.emissive ? insetFrame(packed.emissive, FRAME_INSET) : null,
      });
      loaded = true;
    } catch (err) {
      // Fire-and-forget callers can't handle a rejection; the system already
      // resolved a substitute/white for this frame and `loading.delete` below
      // lets the next reference retry. Log and move on.
      debug.warn(["lod"], `[lod] failed to load ${key}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loading.delete(key);
    }
    if (loaded) for (const cb of this.listeners) cb();
  }
}

/** Pick one variation stem from the natural-sorted list. `index` set → the i-th
 *  variation, ONE-BASED, wrapped into range. `index` unset → deterministic
 *  `seed % length`. */
function pickVariation(variations: readonly string[], seed: number, index?: number): string {
  if (index !== undefined) {
    const zero = (((index - 1) % variations.length) + variations.length) % variations.length;
    return variations[zero];
  }
  return variations[(seed >>> 0) % variations.length];
}

function insetFrame(tex: Texture, inset: number): Texture {
  const { x, y, width, height } = tex.frame;
  return new Texture({
    source: tex.source,
    frame: new Rectangle(x + inset, y + inset, width - inset * 2, height - inset * 2),
  });
}
