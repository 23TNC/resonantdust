/**
 * Geometry-sidecar URL construction — the JSON analog of `channelUrl` in
 * `lodUrls.ts`. A sprite stem (from the wasm `^r2` resolver, possibly carrying a
 * `?v=<hash>` version suffix) maps to `/textures/geo/<stem>.json[?v=<hash>]`. The
 * version is split off the path and re-attached as the query, so it keys the
 * browser/CDN cache (re-master → new hash → clean bust) while the path stays the
 * stable R2 object key — exactly as the LOD URLs do.
 */

/** Build the sidecar fetch URL for a resolved sprite stem (root-relative; the
 *  caller prefixes the R2 or gate origin). */
export function geoUrl(stem: string): string {
  const q = stem.indexOf("?");
  const base = q < 0 ? stem : stem.slice(0, q);
  const query = q < 0 ? "" : stem.slice(q);
  return `/textures/geo/${base}.json${query}`;
}
