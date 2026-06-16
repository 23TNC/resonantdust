/**
 * LOD math + texture-URL construction. The view no longer discovers textures by
 * globbing a local tree — the wasm visual VM (`^r2`) resolves each sprite to a
 * STEM `<category>.<biome>/<object>.<faction>/<id>.<count>.<part>` from the
 * manifest, and the client just appends the LOD size + channel and fetches from
 * R2. So this module is pure: bucket sizes, the footprint→bucket picker, and the
 * `stem → URL` builder. No `import.meta.glob`, no cascade, no variation logic.
 *
 * URLs are root-relative (`/textures/lod/<size>/<stem>.<map>.png`); PIXI's
 * `Assets.init({ basePath })` rewrites them against the R2 origin at fetch time.
 */

/** Ascending LOD bucket sizes. `art lod` emits each map at every bucket ≤ its
 *  master's smaller dimension, so a given stem may only exist at coarse buckets;
 *  the loader descends until a bucket's albedo actually fetches. */
export const LOD_SIZES = [64, 128, 256, 512, 1024] as const;
export type LodSize = (typeof LOD_SIZES)[number];
export const MAX_LOD: LodSize = LOD_SIZES[LOD_SIZES.length - 1];
export const MIN_LOD: LodSize = LOD_SIZES[0];

/** A renderable map channel. `albedo` is the de-lit display colour; `normal`
 *  feeds the lighting pass; `emissive` the additive pass. */
export type Channel = "albedo" | "normal" | "emissive";

/** Pick the smallest LOD bucket ≥ `desiredSize`, clamped to the largest bucket. */
export function pickLodForSize(desiredSize: number): LodSize {
  for (const lod of LOD_SIZES) {
    if (lod >= desiredSize) return lod;
  }
  return MAX_LOD;
}

/** LOD buckets descending from `start` (inclusive) — the loader's fetch order
 *  when the ideal bucket isn't on disk for a stem. */
export function lodsDescendingFrom(start: number): LodSize[] {
  return LOD_SIZES.filter(lod => lod <= start).slice().reverse() as LodSize[];
}

/** Build the fetch URL for a resolved stem at a LOD size + channel:
 *  `/textures/lod/<size>/<stem>.<channel>.png`. */
export function channelUrl(stem: string, size: number, channel: Channel): string {
  return `/textures/lod/${size}/${stem}.${channel}.png`;
}
