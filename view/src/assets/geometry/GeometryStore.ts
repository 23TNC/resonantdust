import { geoUrl } from "./geoUrls";
import type { Sidecar } from "./geoTypes";

/**
 * Per-stem cache of silhouette-geometry sidecars, fetched lazily and reused.
 *
 * Mirrors `LodTextureManager`'s byte path: **R2-direct first, gate on miss**
 * (`<textureBase><path>` then `<gateBase><path>`), since the gate generates the
 * sidecar from the master on the first global request and caches it in R2. The
 * gate's per-key lock collapses the prewarm burst, so many sprites asking at once
 * generate each sidecar once.
 *
 * Keyed by the **versioned** stem (`?v=<hash>` included), so a re-mastered sprite
 * refetches under its new hash; the old entry lingers (a slow leak, like the LOD
 * atlas's, swept later if it matters). `get` is synchronous for the render path:
 * it returns the cached sidecar or `null`, kicking a background fetch on a miss —
 * callers redraw on `onLoad`.
 */
export class GeometryStore {
  private textureBase = "";
  private gateBase: string | null = null;
  /** Versioned stem → sidecar, or `null` once a fetch resolved with no geometry
   *  (absent master / fully-transparent) — a negative cache so we don't refetch. */
  private readonly cache = new Map<string, Sidecar | null>();
  private readonly inflight = new Map<string, Promise<Sidecar | null>>();
  private readonly listeners = new Set<() => void>();

  /** The R2/CDN texture origin (PIXI's `Assets` basePath). Empty = same-origin. */
  setTextureBase(base: string): void {
    this.textureBase = base.replace(/\/$/, "");
  }
  /** The gate HTTP base — the on-miss fallback that generates the sidecar. */
  setGateBase(httpBase: string): void {
    this.gateBase = httpBase.replace(/\/$/, "");
  }

  /** Subscribe to load-completion (fires once per stem as its sidecar lands). */
  onLoad(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Eagerly fetch sidecars for every stem (the login warm — mirrors
   *  `LodTextureManager.prewarmPreviews`). This is what makes the first-frame
   *  placeholder actually beat the texture: geometry is resident before a card
   *  renders, instead of racing the cold per-object fetch. Dedup'd via the cache
   *  + in-flight map, so calling it repeatedly is cheap. */
  prewarm(stems: readonly string[]): void {
    for (const s of stems) {
      if (s && !this.cache.has(s) && !this.inflight.has(s)) void this.ensure(s);
    }
  }

  /** The cached sidecar for `stem`, or `null` if not (yet) available. On a miss
   *  it kicks a background fetch and returns `null`; redraw on `onLoad`. */
  get(stem: string): Sidecar | null {
    if (!stem) return null;
    const cached = this.cache.get(stem);
    if (cached !== undefined) return cached;
    void this.ensure(stem);
    return null;
  }

  private ensure(stem: string): Promise<Sidecar | null> {
    const cached = this.cache.get(stem);
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = this.inflight.get(stem);
    if (existing) return existing;
    const p = this.fetchSidecar(stem).then((s) => {
      this.cache.set(stem, s);
      this.inflight.delete(stem);
      if (s) for (const cb of this.listeners) cb();
      return s;
    });
    this.inflight.set(stem, p);
    return p;
  }

  private async fetchSidecar(stem: string): Promise<Sidecar | null> {
    const path = geoUrl(stem);
    const direct = await fetchJsonOrNull(this.textureBase + path);
    if (direct) return direct;
    if (this.gateBase) return fetchJsonOrNull(this.gateBase + path);
    return null;
  }
}

/** Fetch + parse a sidecar, or `null` on any failure (404, network, bad JSON) —
 *  the silent-miss idiom the LOD fetches use; callers fall back to transparent. */
async function fetchJsonOrNull(url: string): Promise<Sidecar | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as Sidecar;
  } catch {
    return null;
  }
}
