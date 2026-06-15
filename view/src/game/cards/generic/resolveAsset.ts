import type { Texture } from "pixi.js";
import type { LodTextureManager } from "../../../assets/textures/LodTextureManager";
import type { AssetRef } from "./visualSpec";

/**
 * The single `LodTextureManager` consumer. Every textured primitive resolves
 * its art here, so the "LOD bucket is driven by the actual draw footprint ×
 * dpr" rule lives in exactly one place — the fix for the soul-portrait
 * minification aliasing, and the thing that kept drifting across the five
 * hand-rolled `lodTextures.get(...)` call sites.
 *
 * `footprintCssPx` is the size the sprite will occupy on screen at scale 1.0
 * (CSS px). We pick the LOD for `footprintCssPx × dpr` (so a hi-dpi screen
 * loads the sharper bucket), then return `scale = footprintCssPx / tex.width`
 * so the sprite draws at the requested CSS size regardless of which bucket
 * backed it. `variance` (world-object instance jitter) multiplies the scale.
 */
export interface AssetResolution {
  texture: Texture;
  /** Normal-map frame at the SAME atlas slot as `texture`, or null when the
   *  resolved variant has no normal map (white fallback, or art without one).
   *  Fed to the lighting shader; null → the lit prim uses a flat-up normal. */
  normal: Texture | null;
  /** Emissive frame at the SAME atlas slot, or null when the variant has none.
   *  Fed to the deferred emissive pass; null → the prim self-illuminates nothing. */
  emissive: Texture | null;
  /** Multiply onto `sprite.scale` to draw `tex` at the requested CSS size. */
  scale: number;
}

export interface ResolveOpts {
  dpr: number;
  /** Object-axis modifier — `<object.faction>` dirs resolve first. */
  faction?: string;
  /** Category-axis modifier — `<category.biome>` dirs resolve first. */
  biome?: string;
  /** Variant picker when `ref.index` is unset (typically the card/tile id). */
  seed?: number;
  /** Per-instance scale jitter (world objects); default 1. */
  variance?: number;
}

export function resolveAsset(
  lod: LodTextureManager,
  ref: AssetRef,
  footprintCssPx: number,
  opts: ResolveOpts,
): AssetResolution {
  const desired = Math.max(1, footprintCssPx * opts.dpr);
  const { albedo, normal, emissive } = lod.getPair({
    category: ref.category,
    object: ref.name,
    desiredSize: desired,
    seed: opts.seed ?? 0,
    index: ref.index,
    biome: opts.biome,
    faction: opts.faction,
  });
  const variance = opts.variance ?? 1;
  return { texture: albedo, normal, emissive, scale: (footprintCssPx / albedo.width) * variance };
}
