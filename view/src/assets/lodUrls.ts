/**
 * Build-time discovery + cascade resolution for every LOD-pyramid PNG under
 * `view/public/textures/lod/`. Unified layout (one shape for ALL art —
 * "variations of one object" like flora and "a sheet of distinct objects" like
 * requisite are the same thing at different granularities):
 *
 *   lod/<size>/<category[.biome]>/<object[.faction]>/<variation>.<map>.png
 *
 * where `<size>` ∈ `LOD_SIZES`, `<variation>` is a 1-based integer stem, and
 * `<map>` is a channel — `albedo` (de-lit display), `diffuse` (lit display),
 * legacy plain `.png` (display), `normal`, `emissive`, … . `master/` (the
 * full-res source) is OUTSIDE this glob; it never reaches the client.
 *
 * **Per-channel cascade.** A request carries two independent modifier axes —
 * `.biome` on the category dir and `.faction` on the object dir — and EACH map
 * channel resolves independently up a fallback chain. Precedence (most → least
 * specific), faction outranking biome:
 *
 *   1. <category.biome>/<object.faction>
 *   2. <category>/<object.faction>
 *   3. <category.biome>/<object>
 *   4. <category>/<object>            ← the base (no `default` sentinel; the
 *                                       unsuffixed dir IS the default)
 *
 * Because each channel cascades on its own and override dirs are SPARSE, a
 * faction that overrides only `emissive` still picks up base `albedo` (and a
 * biome `albedo` if one exists) — composition across axes for free. A missing
 * display channel at all four → white fallback; a missing optional channel →
 * simply absent.
 *
 * `import.meta.glob` must be a static literal — Vite evaluates it at build time
 * and emits a `path → () => Promise` map. Files under `public/` are static
 * assets (never bundled); the glob just yields the *list of URLs we can fetch
 * via `Assets.load`*. PNG bytes only cross the wire on first fetch.
 */
const ALL_LOD_URLS = import.meta.glob("/public/textures/lod/**/*.png");

const ALL_URLS: readonly string[] = Object.keys(ALL_LOD_URLS).map(k =>
  k.replace(/^\/public/, ""),
);

/** Ascending LOD bucket sizes. `art lod` emits each variant at every bucket ≤
 *  its master's smaller dimension, so an object may exist only at the coarse
 *  buckets; the resolver descends until it finds files. */
export const LOD_SIZES = [64, 128, 256, 512, 1024] as const;
export type LodSize = (typeof LOD_SIZES)[number];
export const MAX_LOD: LodSize = LOD_SIZES[LOD_SIZES.length - 1];
export const MIN_LOD: LodSize = LOD_SIZES[0];

/** Display channels in preference order: de-lit albedo, then lit diffuse, then
 *  the legacy plain `.png`. A normal/emissive map is never a display channel. */
const DISPLAY_CHANNELS = ["albedo", "diffuse", "png"] as const;
export type Channel = "albedo" | "diffuse" | "png" | "normal" | "emissive";

interface ParsedUrl {
  size: number;
  /** `<category>` or `<category.biome>` — the raw L1 dir name. */
  l1: string;
  /** `<object>` or `<object.faction>` — the raw L2 dir name. */
  l2: string;
  /** Variation stem (the filename before the channel suffix), e.g. `"3"`. */
  variation: string;
  channel: Channel;
  url: string;
}

function parseUrl(url: string): ParsedUrl | null {
  // /textures/lod/<size>/<l1>/<l2>/<file>
  const m = url.match(/^\/textures\/lod\/(\d+)\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  const [, sizeStr, l1, l2, file] = m;
  let variation: string;
  let channel: Channel;
  const typed = file.match(/^(.+)\.(albedo|diffuse|normal|emissive)\.png$/);
  if (typed) {
    variation = typed[1];
    channel = typed[2] as Channel;
  } else {
    const plain = file.match(/^(.+)\.png$/);
    if (!plain) return null;
    variation = plain[1];
    channel = "png";
  }
  return { size: Number(sizeStr), l1, l2, variation, channel, url };
}

/** Nested lookup: size → l1 → l2 → variation → channel → url. Built once from
 *  the glob; every resolution is O(probe-count) Map gets, no string scans. */
type ChannelMap = Map<Channel, string>;
type VarMap = Map<string, ChannelMap>;
type L2Map = Map<string, VarMap>;
type L1Map = Map<string, L2Map>;
const INDEX: Map<number, L1Map> = (() => {
  const root = new Map<number, L1Map>();
  for (const url of ALL_URLS) {
    const p = parseUrl(url);
    if (!p) continue;
    let l1m = root.get(p.size);
    if (!l1m) root.set(p.size, (l1m = new Map()));
    let l2m = l1m.get(p.l1);
    if (!l2m) l1m.set(p.l1, (l2m = new Map()));
    let vm = l2m.get(p.l2);
    if (!vm) l2m.set(p.l2, (vm = new Map()));
    let cm = vm.get(p.variation);
    if (!cm) vm.set(p.variation, (cm = new Map()));
    cm.set(p.channel, url);
  }
  return root;
})();

/** The (l1, l2) directory pairs to probe, most-specific first. Faction (the L2
 *  suffix) outranks biome (the L1 suffix), so the order is
 *  faction+biome → faction → biome → base. Suffixed candidates are omitted when
 *  the corresponding modifier is absent. */
function probePairs(
  category: string,
  biome: string | undefined,
  object: string,
  faction: string | undefined,
): Array<[string, string]> {
  const l1s = biome ? [`${category}.${biome}`, category] : [category];
  const l2s = faction ? [`${object}.${faction}`, object] : [object];
  const pairs: Array<[string, string]> = [];
  for (const l2 of l2s) for (const l1 of l1s) pairs.push([l1, l2]);
  return pairs;
}

function channelMapAt(size: number, l1: string, l2: string, variation: string): ChannelMap | undefined {
  return INDEX.get(size)?.get(l1)?.get(l2)?.get(variation);
}

/** Resolve one map channel for a variation at a fixed LOD size through the
 *  dir cascade. `display` tries albedo→diffuse→png within each probed dir
 *  (so the most-specific dir wins regardless of which colour format it ships).
 *  Returns the concrete URL or null. */
function resolveChannelAt(
  size: number,
  category: string,
  biome: string | undefined,
  object: string,
  faction: string | undefined,
  variation: string,
  channel: "display" | "normal" | "emissive",
): string | null {
  for (const [l1, l2] of probePairs(category, biome, object, faction)) {
    const cm = channelMapAt(size, l1, l2, variation);
    if (!cm) continue;
    if (channel === "display") {
      for (const c of DISPLAY_CHANNELS) {
        const u = cm.get(c);
        if (u) return u;
      }
    } else {
      const u = cm.get(channel);
      if (u) return u;
    }
  }
  return null;
}

export interface ResolvedChannels {
  /** The display (albedo/diffuse/png) URL — always present (a null display is
   *  reported by the resolver returning null, not by this being null). */
  albedo: string;
  normal: string | null;
  emissive: string | null;
  /** The LOD size these URLs were resolved at (≤ the requested ideal). */
  size: LodSize;
}

/** Resolve all three render channels for one variation at a SINGLE LOD size
 *  (no descent). albedo/normal/emissive each resolve through their OWN dir
 *  cascade, so their atlas frames line up. Null when this exact size has no
 *  display channel anywhere in the cascade. */
export function resolveAtSize(
  size: LodSize,
  category: string,
  biome: string | undefined,
  object: string,
  faction: string | undefined,
  variation: string,
): ResolvedChannels | null {
  const albedo = resolveChannelAt(size, category, biome, object, faction, variation, "display");
  if (!albedo) return null;
  return {
    albedo,
    normal: resolveChannelAt(size, category, biome, object, faction, variation, "normal"),
    emissive: resolveChannelAt(size, category, biome, object, faction, variation, "emissive"),
    size,
  };
}

/** Resolve all three render channels, descending LOD buckets from `idealLod`
 *  until one has a display channel (somewhere in the cascade). Returns null when
 *  no bucket has any display channel (→ white fallback). */
export function resolveVariation(
  category: string,
  biome: string | undefined,
  object: string,
  faction: string | undefined,
  variation: string,
  idealLod: number,
): ResolvedChannels | null {
  for (const size of lodsDescendingFrom(idealLod)) {
    const r = resolveAtSize(size, category, biome, object, faction, variation);
    if (r) return r;
  }
  return null;
}

/** The variation stems for a (category, object), taken from the BASE dir
 *  (`<category>/<object>`, the cascade floor) — biome/faction dirs are sparse
 *  overrides, never new variations. Natural-sorted (`"2"` before `"10"`), unioned
 *  across LOD sizes. This list IS the index space the picker selects over
 *  (fixed index / random seed). Empty when the object has no base art. */
export function variationsFor(category: string, object: string): readonly string[] {
  const stems = new Set<string>();
  for (const size of LOD_SIZES) {
    const vm = INDEX.get(size)?.get(category)?.get(object);
    if (!vm) continue;
    for (const [variation, cm] of vm) {
      if (DISPLAY_CHANNELS.some(c => cm.has(c))) stems.add(variation);
    }
  }
  return [...stems].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Pick the smallest LOD bucket ≥ `desiredSize`, clamped to the largest bucket.
 *  Pure math against `LOD_SIZES`; the resolver drops lower when the ideal bucket
 *  has no files. */
export function pickLodForSize(desiredSize: number): LodSize {
  for (const lod of LOD_SIZES) {
    if (lod >= desiredSize) return lod;
  }
  return MAX_LOD;
}

/** LOD buckets descending from `start` (inclusive). */
export function lodsDescendingFrom(start: number): LodSize[] {
  return LOD_SIZES.filter(lod => lod <= start).slice().reverse() as LodSize[];
}

/** Resolved channel triples for variation 1 of every BASE object at the
 *  smallest LOD bucket — the startup pre-warm slice. Every object then has a
 *  coarse texture cached before its first reference, so the first frame resolves
 *  to the 64px instead of the white fallback. */
export function prewarmResolved(): readonly ResolvedChannels[] {
  const out: ResolvedChannels[] = [];
  const l1m = INDEX.get(MIN_LOD);
  if (!l1m) return out;
  for (const [l1, l2m] of l1m) {
    if (l1.includes(".")) continue; // base categories only
    for (const [l2] of l2m) {
      if (l2.includes(".")) continue; // base objects only
      const first = variationsFor(l1, l2)[0];
      if (!first) continue;
      const r = resolveAtSize(MIN_LOD, l1, undefined, l2, undefined, first);
      if (r) out.push(r);
    }
  }
  return out;
}

/** Every LOD URL discoverable at build time. Diagnostic-only. */
export function allLodUrls(): readonly string[] {
  return [...ALL_URLS].sort();
}
