/**
 * Geometry-sidecar URL construction — the JSON analog of `channelUrl` in
 * `lodUrls.ts`. A sprite stem (from the wasm `^r2` resolver, carrying a `?v=<hash>`
 * version) maps to `/textures/geo/<dir>/<version>/<variation>.json`. The version
 * is a PATH SEGMENT at the object boundary (not a `?v=` query), so a re-mastered
 * object is a distinct R2 key — clean 404 → gate-regenerate — exactly as the LOD
 * URLs do (see {@link splitStem}).
 */

import { splitStem } from "../lodUrls";

/** Build the sidecar fetch URL for a resolved sprite stem (root-relative; the
 *  caller prefixes the R2 or gate origin). */
export function geoUrl(stem: string): string {
  const { dir, variation, version } = splitStem(stem);
  return `/textures/geo/${dir}/${version}/${variation}.json`;
}
