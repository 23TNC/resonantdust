//! Master-texture resolver for the Card Editor.
//!
//! The LOD pyramid the game renders is GENERATED from `public/textures/master/`
//! — the high-res source tree. The editor pulls from master (not LOD) so edits
//! land on the source the LODs are rebuilt from. Master is 1:1 with LOD by
//! variant order (lod is baked from it), but carries more channels + full res.
//!
//! Layout: `master/<aspect>/<faction>/<variant>(.<channel>)?.png`, where channel
//! ∈ {diffuse, albedo, normal} (plus a bare `.png` legacy colour). Variants per
//! `(aspect, faction)` are natural-sorted; the card's variant index / seed picks
//! among them with the SAME logic the LOD picker uses, so the editor resolves the
//! same variant as the card — just at master res.
//!
//! Files under `public/` are served as static assets; `import.meta.glob` (same
//! pattern as `assets/lodUrls.ts`) just yields the fetchable URL list — bytes
//! only cross on the first `Assets.load`.

import { Assets, type Texture } from "pixi.js";

export type MasterChannel = "diffuse" | "albedo" | "normal" | "emissive";

const MASTER_GLOB = import.meta.glob("/public/textures/master/**/*.png");
const URLS: readonly string[] = Object.keys(MASTER_GLOB).map((k) => k.replace(/^\/public/, ""));
const URL_SET: ReadonlySet<string> = new Set(URLS);

/** Drop the channel + `.png` suffix to get a variant's stem (its on-disk id). */
function stemOf(url: string): string {
  return url.replace(/\.(albedo|normal|diffuse|emissive)\.png$/, "").replace(/\.png$/, "");
}

/** Numeric-aware compare so `1_2` sorts before `1_10`. */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** `aspect/faction` → its natural-sorted variant stems (one per sprite). Built
 *  once from the glob; normals don't count as colour variants. */
const BY_ASPECT_FACTION: ReadonlyMap<string, string[]> = (() => {
  const stems = new Set<string>();
  for (const u of URLS) {
    if (/\.(normal|emissive)\.png$/.test(u)) continue; // not colour variants
    stems.add(stemOf(u));
  }
  const groups = new Map<string, Set<string>>();
  for (const stem of stems) {
    const m = stem.match(/^\/textures\/master\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const key = `${m[1]}/${m[2]}`;
    let set = groups.get(key);
    if (!set) groups.set(key, (set = new Set()));
    set.add(stem);
  }
  const out = new Map<string, string[]>();
  for (const [key, set] of groups) out.set(key, [...set].sort(naturalCompare));
  return out;
})();

/** Variant stems for `(aspect, faction)`, with the LOD picker's faction
 *  fallback: requested faction → neutral → first available faction. */
function variantsFor(aspect: string, faction: string): string[] {
  const direct = BY_ASPECT_FACTION.get(`${aspect}/${faction}`);
  if (direct?.length) return direct;
  const neutral = BY_ASPECT_FACTION.get(`${aspect}/neutral`);
  if (neutral?.length) return neutral;
  for (const [key, list] of BY_ASPECT_FACTION) {
    if (key.startsWith(`${aspect}/`) && list.length) return list;
  }
  return [];
}

/** Resolve the master variant stem for a sprite reference, mirroring the LOD
 *  variant pick: a 1-based `index` pins it; otherwise `seed % count`. `null`
 *  when the aspect has no master variants. */
export function masterVariantStem(
  aspect: string,
  faction: string | undefined,
  seed: number,
  index?: number,
): string | null {
  const variants = variantsFor(aspect, faction || "neutral");
  if (variants.length === 0) return null;
  const i = index !== undefined
    ? (((index - 1) % variants.length) + variants.length) % variants.length
    : (seed >>> 0) % variants.length;
  return variants[i];
}

/** The URL for one channel of a variant stem, with per-channel fallback. `null`
 *  when that channel (and its fallbacks) doesn't exist on disk. */
export function masterChannelUrl(stem: string, channel: MasterChannel): string | null {
  const exists = (suffix: string): string | null => (URL_SET.has(stem + suffix) ? stem + suffix : null);
  switch (channel) {
    case "normal":
      return exists(".normal.png");
    case "emissive":
      return exists(".emissive.png");
    case "diffuse":
      return exists(".diffuse.png") ?? exists(".png") ?? exists(".albedo.png");
    case "albedo":
      return exists(".albedo.png") ?? exists(".diffuse.png") ?? exists(".png");
  }
}

/** Load (and cache, via Pixi `Assets`) the texture at `url`. */
export function loadMasterTexture(url: string): Promise<Texture> {
  return Assets.load<Texture>(url);
}
