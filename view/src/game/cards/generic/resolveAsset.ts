import type { Texture } from "pixi.js";
import type { LodTextureManager } from "../../../assets/textures/LodTextureManager";
import type { AssetRef } from "./visualSpec";

/**
 * The single `LodTextureManager` consumer. `ref` is the resolved texture STEM
 * (`<category>.<biome>/<object>.<faction>/<id>.<count>.<part>`) from the wasm
 * `^r2` resolver — variation/biome/faction/part are already decided. This layer
 * only turns the on-screen footprint into a LOD bucket and fetches.
 *
 * `footprintCssPx` is the draw size at scale 1.0 (CSS px). We pick the LOD for
 * `footprintCssPx × dpr` (hi-dpi loads a sharper bucket), then return
 * `scale = footprintCssPx / tex.width` so the sprite draws at the requested CSS
 * size regardless of which bucket backed it. `variance` jitters the scale.
 */
export interface AssetResolution {
  texture: Texture;
  /** Normal-map frame at the SAME atlas slot, or null. */
  normal: Texture | null;
  /** Emissive frame at the SAME atlas slot, or null. */
  emissive: Texture | null;
  /** Multiply onto `sprite.scale` to draw at the requested CSS size. */
  scale: number;
}

export interface ResolveOpts {
  dpr: number;
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
  const { albedo, normal, emissive } = lod.getPair(ref, desired);
  const variance = opts.variance ?? 1;
  return { texture: albedo, normal, emissive, scale: (footprintCssPx / albedo.width) * variance };
}
