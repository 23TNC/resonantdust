/**
 * Build-time discovery of every LOD-pyramid PNG under
 * `pixijs/public/textures/lod/`. Layout is
 *
 *   lod/<lodSize>/<aspect>/<faction>/<N>.png
 *
 * where `<lodSize>` ∈ `LOD_SIZES`, `<faction>` includes `"neutral"`
 * (always populated at the highest LOD any given aspect exists at),
 * and `<N>` are 1-indexed variants mirrored 1:1 across LODs by the
 * `art remaster` tool. `master/` (the high-res source tree consumed
 * only by `art remaster`) is OUTSIDE this glob — it never reaches
 * the client.
 *
 * `import.meta.glob` must be a static literal — Vite evaluates it
 * at build time and emits a `path → () => Promise` map. Files under
 * `public/` are served as static assets (never bundled into JS
 * chunks); the glob just produces the *list of URLs we can fetch
 * from `Assets.load`*. PNG bytes only cross the wire on first
 * fetch.
 */
const ALL_LOD_URLS = import.meta.glob("/public/textures/lod/**/*.png");

function stripPublic(k: string): string {
  return k.replace(/^\/public/, "");
}

const ALL_URLS: readonly string[] = Object.keys(ALL_LOD_URLS).map(stripPublic);
/** O(1) existence lookup over every discoverable LOD URL. */
const URL_SET: ReadonlySet<string> = new Set(ALL_URLS);

/**
 * A sprite is identified by its *stem* — `lod/<size>/<aspect>/<faction>/<N>`
 * (or the splitter's `<sheet>_<idx>` form) — independent of which channel files
 * exist for it. Each stem can carry up to three colour-ish channels in its
 * folder, plus a normal map:
 *
 *   <stem>.albedo.png   de-lit colour  ← what we DISPLAY (correct for relighting)
 *   <stem>.diffuse.png  lit colour     ← display fallback (newer pipeline)
 *   <stem>.png          lit colour     ← display fallback (legacy / unmapped art)
 *   <stem>.normal.png   normal map     ← lighting only, never a variant
 *
 * Enumeration keys off the STEM, not a specific filename — so an aspect whose
 * only colour file is `.albedo.png`/`.diffuse.png` (no plain `.png`) still has
 * renderable variants. `displayColourFor` then picks the channel to show,
 * albedo first.
 */
function stemOf(url: string): string {
  return url.replace(/\.(albedo|normal|diffuse)\.png$/, "").replace(/\.png$/, "");
}

/** The colour URL to display for a stem: de-lit albedo first, then lit diffuse,
 *  then the legacy plain `.png`. Null if the stem has no colour file at all
 *  (only a normal — not renderable on its own). */
function displayColourFor(stem: string): string | null {
  if (URL_SET.has(stem + ".albedo.png")) return stem + ".albedo.png";
  if (URL_SET.has(stem + ".diffuse.png")) return stem + ".diffuse.png";
  if (URL_SET.has(stem + ".png")) return stem + ".png";
  return null;
}

/** Canonical variant URL per stem (its display-colour URL). One entry per
 *  sprite; the seed/index picker chooses among these, and they ARE the URL the
 *  loader fetches as the albedo channel. Built once from the glob. */
const VARIANT_SET: ReadonlySet<string> = (() => {
  const stems = new Set<string>();
  for (const u of ALL_URLS) {
    if (!u.endsWith(".png") || /\.normal\.png$/.test(u)) continue;
    stems.add(stemOf(u));
  }
  const variants = new Set<string>();
  for (const s of stems) {
    const colour = displayColourFor(s);
    if (colour) variants.add(colour);
  }
  return variants;
})();

function isVariantUrl(url: string): boolean {
  return VARIANT_SET.has(url);
}

/** Albedo (display colour) URL for a variant: the variant URL already resolves
 *  to the display channel (albedo-first), so this is identity in the common
 *  case; kept as the single point that prefers the de-lit `.albedo.png`. */
export function albedoUrlFor(variantUrl: string): string {
  return displayColourFor(stemOf(variantUrl)) ?? variantUrl;
}

/** Normal-map URL for a variant: `<stem>.normal.png` when present, else null
 *  (no normal baked → the lighting pass treats null as flat-up). */
export function normalUrlFor(variantUrl: string): string | null {
  const normal = stemOf(variantUrl) + ".normal.png";
  return URL_SET.has(normal) ? normal : null;
}

/** Ascending list of LOD bucket sizes the pyramid uses. `art remaster`
 *  emits each variant at every bucket size whose master source can
 *  cover. An aspect may legitimately exist at only the smallest
 *  bucket (e.g. flowers, master too small to bake a 256 from). The
 *  runtime picker silently drops down when the requested bucket
 *  isn't on disk. */
export const LOD_SIZES = [64, 128, 256, 512, 1024] as const;
export type LodSize = (typeof LOD_SIZES)[number];

/** Largest LOD bucket. Used as the seed when the requested
 *  `desiredSize` exceeds every available bucket. */
export const MAX_LOD: LodSize = LOD_SIZES[LOD_SIZES.length - 1];
/** Smallest LOD bucket. Used as the white-fallback resolution and
 *  as the floor when `desiredSize` is below every available bucket. */
export const MIN_LOD: LodSize = LOD_SIZES[0];

/** URLs for one specific `(lodSize, aspect, faction)` triple — one canonical
 *  colour variant per sprite, NATURAL-sorted by stem (`1_2` before `1_10`).
 *  This order is the index space: it mirrors `bin/art manifest`'s `sort -V`, so
 *  a positional `index` (see `pickVariantUrl`) selects the same sprite the
 *  manifest's `&texture.<i>` does. Empty array means "no files at this triple"
 *  (caller drops LOD or falls back to neutral). */
export function lodUrlsFor(
  lodSize: number,
  aspect: string,
  faction: string,
): readonly string[] {
  const prefix = `/textures/lod/${lodSize}/${aspect}/${faction}/`;
  return ALL_URLS
    .filter(url => url.startsWith(prefix) && isVariantUrl(url))
    .sort((a, b) => stemOf(a).localeCompare(stemOf(b), undefined, { numeric: true }));
}

/** All faction subfolders that exist for an aspect at a given LOD.
 *  Sorted (deterministic). Empty when the aspect has no files at
 *  that LOD bucket at all.
 *
 *  Used by the picker as a "what's available?" lookup when the
 *  caller-supplied faction is missing or doesn't resolve — so a
 *  `soul`-art card whose owner-faction lookup hasn't hydrated yet
 *  still renders SOMETHING (alphabetical first available) instead
 *  of the white fallback. The "wrong" faction is fine for the
 *  loading-frame use case; the card re-resolves once its real
 *  faction lands. */
export function availableFactionsAt(
  lodSize: number,
  aspect: string,
): readonly string[] {
  const prefix = `/textures/lod/${lodSize}/${aspect}/`;
  const factions = new Set<string>();
  for (const url of ALL_URLS) {
    if (!url.startsWith(prefix)) continue;
    const rest = url.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash > 0) factions.add(rest.slice(0, slash));
  }
  return [...factions].sort();
}

/** Pick the smallest LOD bucket `≥ desiredSize`, clamped to the
 *  largest bucket when `desiredSize` exceeds the pyramid's max.
 *  Pure math against `LOD_SIZES` — does NOT consult availability on
 *  disk. The caller drops LODs when the ideal isn't populated for
 *  the requested aspect. */
export function pickLodForSize(desiredSize: number): LodSize {
  for (const lod of LOD_SIZES) {
    if (lod >= desiredSize) return lod;
  }
  return MAX_LOD;
}

/** Yield LOD buckets descending from `start` (inclusive). Used by
 *  the resolver to walk down the pyramid looking for any LOD that
 *  has files for a given `(aspect, faction)`. */
export function lodsDescendingFrom(start: number): LodSize[] {
  return LOD_SIZES.filter(lod => lod <= start).slice().reverse() as LodSize[];
}

/** Substitute a different LOD bucket into an existing LOD URL,
 *  preserving aspect / faction / variant. Used by the runtime to
 *  compute "what would the equivalent URL be at a different LOD?"
 *  for the cached-substitute search. Returns the input unchanged
 *  if it doesn't match the expected LOD-URL shape. */
export function urlAtLod(url: string, lod: number): string {
  return url.replace(/\/textures\/lod\/\d+\//, `/textures/lod/${lod}/`);
}

/** All URLs at the smallest LOD bucket. Used by `main.ts` as the
 *  startup pre-warm slice — every aspect gets at least a coarse
 *  texture in the browser cache so the first-reference fallback
 *  chain (cached substitute → white) lands quickly. */
export function smallestLodUrls(): readonly string[] {
  const prefix = `/textures/lod/${MIN_LOD}/`;
  return ALL_URLS.filter(url => url.startsWith(prefix) && isVariantUrl(url)).sort();
}

/** Every LOD URL discoverable at build time. Diagnostic-only; the
 *  runtime resolver never asks for this. */
export function allLodUrls(): readonly string[] {
  return [...ALL_URLS].sort();
}
