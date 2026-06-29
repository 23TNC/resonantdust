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
export const LOD_SIZES = [16, 32, 64, 128, 256, 512, 1024] as const;
export type LodSize = (typeof LOD_SIZES)[number];
export const MAX_LOD: LodSize = LOD_SIZES[LOD_SIZES.length - 1];
export const MIN_LOD: LodSize = LOD_SIZES[0];

/** Bucket the PREVIEW atlas loads — a cheap, low-res placeholder shown while the
 *  full-res master texture streams in (see `LodTextureManager`). The preview
 *  load descends from here, so a stem with no 32px bucket falls to 16px. Tune to
 *  trade placeholder sharpness vs. preview load cost (32 ≈ a clear thumbnail). */
export const PREVIEW_LOD: LodSize = 32;

/** A renderable map channel. `albedo` is the de-lit display colour; `normal`
 *  feeds the lighting pass; `emissive` the additive pass. */
export type Channel = "albedo" | "normal" | "emissive";

/** Map-existence bits, mirroring `bin/art`'s `_object_maps` / the manifest's
 *  `&maps`: which channels a stem actually has a master for. The resolver rides
 *  them in the stem as `&m=<bits>` so the client skips channels that can't exist
 *  (chiefly `emissive`, which has zero masters today) instead of speculatively
 *  fetching them and eating a guaranteed 404. */
export const MAP_ALBEDO = 1;
export const MAP_NORMAL = 2;
export const MAP_EMISSIVE = 4;

/** The `&m=<bits>` map-existence field carried in a resolved stem. Absent (legacy
 *  / un-migrated manifest) → all bits set, i.e. fetch every channel exactly as
 *  before, so nothing regresses until the manifest is regenerated with `&maps`. */
export function mapsOf(stem: string): number {
  const q = stem.indexOf("?");
  if (q < 0) return MAP_ALBEDO | MAP_NORMAL | MAP_EMISSIVE;
  const m = /(?:^|&)m=([0-9]+)/.exec(stem.slice(q + 1));
  return m ? Number(m[1]) : MAP_ALBEDO | MAP_NORMAL | MAP_EMISSIVE;
}

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

/** Split a resolved `^r2` stem `<dir>/<variation>?v=<hash>` into its object
 *  directory (`<cat>.<biome>/<obj>.<faction>`), variation leaf (`<id>.<count>.
 *  <part>`), and version hash. The version becomes a PATH SEGMENT at the object
 *  boundary (not a `?v=` query) so a re-mastered object is a DISTINCT R2 object
 *  key — a clean 404 → gate-regenerate, not a query-string cache-bust that r2.dev
 *  ignores at the origin. `"0"` for un-versioned content (the manifest always
 *  emits `&hash`, so this is just a defensive sentinel) — keeps the gate's path
 *  parse uniform (version is always the segment before the size). */
export function splitStem(stem: string): { dir: string; variation: string; version: string } {
  const q = stem.indexOf("?");
  const path = q < 0 ? stem : stem.slice(0, q);
  const version = (q < 0 ? "" : /(?:^|&)v=([^&]*)/.exec(stem.slice(q + 1))?.[1]) || "0";
  const slash = path.lastIndexOf("/");
  return { dir: path.slice(0, slash), variation: path.slice(slash + 1), version };
}

/** Build the fetch URL for a resolved stem at a LOD size + channel:
 *  `/textures/lod/<dir>/<version>/<size>/<variation>.<channel>.png`. The version
 *  sits in the path at the object boundary, above the size, so every per-object /
 *  per-version cleanup is a single R2 prefix (see {@link splitStem}). */
export function channelUrl(stem: string, size: number, channel: Channel): string {
  const { dir, variation, version } = splitStem(stem);
  return `/textures/lod/${dir}/${version}/${size}/${variation}.${channel}.png`;
}
