import { Assets, Graphics, Rectangle, RenderTexture, Texture, type Renderer } from "pixi.js";
import {
  channelUrl,
  pickLodForSize,
  lodsDescendingFrom,
  LOD_SIZES,
  MIN_LOD,
} from "../lodUrls";
import type { PackedPair, TextureManager } from "./TextureManager";
import { debug } from "../../debug";

/** Pixels trimmed off each side of a packed frame, so bilinear sampling can't
 *  bleed from neighbouring atlas slots. */
const FRAME_INSET = 2;

/** Ceiling on the LOD bucket the picker selects — a texture-quality knob. */
const DEFAULT_QUALITY_CAP = 1024;

/**
 * LOD-aware lazy loader + atlas cache. Input is a RESOLVED STEM
 * (`<category>.<biome>/<object>.<faction>/<id>.<count>.<part>`) produced by the
 * wasm `^r2` resolver — the manager owns only "which LOD size, fetch from R2,
 * pack." No glob, no cascade, no variation pick (all upstream now).
 *
 * **LOD by request-and-descend.** The view no longer knows which buckets exist
 * for a stem, so the loader tries the ideal bucket's albedo and, on fetch
 * failure, descends to the next smaller — caching the first success and the
 * stem's max available size (so repeat requests don't re-probe absent buckets).
 *
 * **Always returns a PackedPair.** While a stem loads, `get` returns the best
 * already-cached smaller bucket for the same stem, else the 64×64 white fallback;
 * `onLoad` fires when the ideal lands so consumers re-resolve to the upgrade.
 */
export class LodTextureManager {
  private readonly textures: TextureManager;
  private readonly renderer: Renderer;
  private readonly qualityCap: number;
  /** Atlas-packed triple keyed by `${stem}@${size}`. */
  private readonly byKey = new Map<string, PackedPair>();
  /** Keys whose load is in flight (dedupe). */
  private readonly loading = new Set<string>();
  /** Per-stem largest bucket known to exist (set on first successful descend),
   *  so the picker clamps the ideal and avoids re-probing absent buckets. */
  private readonly maxSize = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private whiteFallback: Texture | null = null;

  constructor(textures: TextureManager, renderer: Renderer, options?: { qualityCap?: number }) {
    this.textures = textures;
    this.renderer = renderer;
    this.qualityCap = options?.qualityCap ?? DEFAULT_QUALITY_CAP;
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
      void this.load(stem, ideal, key);
    }
    return this.findCachedSubstitute(stem) ?? this.whitePair();
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
    this.maxSize.clear();
    this.whiteFallback = null;
  }

  /** Fetch + pack the stem, descending LOD buckets from `ideal` until one's
   *  albedo loads (the rest of the pyramid for this stem doesn't exist). Caches
   *  the hit under `${stem}@${size}` and records the stem's max size. `idealKey`
   *  is released from `loading` regardless so a later reference can retry. */
  private async load(stem: string, ideal: number, idealKey: string): Promise<void> {
    let landedKey: string | null = null;
    try {
      for (const size of lodsDescendingFrom(ideal)) {
        const albedoUrl = channelUrl(stem, size, "albedo");
        try {
          await Assets.load(albedoUrl);
        } catch {
          continue; // bucket absent for this stem — try smaller
        }
        const albedoSrc = Assets.get<Texture>(albedoUrl);
        if (!albedoSrc) continue;
        // optional channels — null if they 404.
        const normalSrc = await loadOptional(channelUrl(stem, size, "normal"));
        const emissiveSrc = await loadOptional(channelUrl(stem, size, "emissive"));
        const packed = this.textures.pack(albedoSrc, normalSrc, emissiveSrc);
        const key = `${stem}@${size}`;
        this.byKey.set(key, {
          albedo: insetFrame(packed.albedo, FRAME_INSET),
          normal: packed.normal ? insetFrame(packed.normal, FRAME_INSET) : null,
          emissive: packed.emissive ? insetFrame(packed.emissive, FRAME_INSET) : null,
        });
        if (size > (this.maxSize.get(stem) ?? 0)) this.maxSize.set(stem, size);
        landedKey = key;
        break;
      }
    } catch (err) {
      debug.warn(["lod"], `[lod] failed to load ${stem}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loading.delete(idealKey);
    }
    if (landedKey) for (const cb of this.listeners) cb();
  }
}

/** Load an optional channel; null if it 404s (most art has no emissive). */
async function loadOptional(url: string): Promise<Texture | null> {
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
