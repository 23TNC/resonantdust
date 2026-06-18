//! Persistent preview-floor store (IndexedDB) — pins the low-res preview LODs in
//! a store the browser's HTTP cache can't evict, so a returning player's
//! placeholders load with ZERO network (and never get pushed out by large
//! full-res textures, which share the HTTP cache's one LRU pool).
//!
//! Keyed by BASE stem (path without the `?v=` suffix), one entry per object —
//! the entry carries the version it was fetched at, so a re-mastered object
//! (new hash) reads as stale and is re-fetched + overwritten in place (no
//! accumulation). Full-res LODs are deliberately NOT persisted: they stay in the
//! evictable HTTP cache (the preview floor catches an eviction gracefully), so
//! this store stays small (~a few MB) and bounded.
//!
//! Every op is best-effort: a private-mode / quota / unsupported failure degrades
//! to "no persistence" (the network prewarm still runs), never an error.

const DB_NAME = "resonantdust-tex";
const STORE = "previews";
const DB_VERSION = 1;

/** A persisted preview: the raw channel PNG bytes plus the version (`?v=` hash)
 *  they were fetched at, for staleness checks. `normal`/`emissive` are null when
 *  the object has no such master (emissive is rare). */
export interface PreviewBytes {
  v: string;
  albedo: ArrayBuffer;
  normal: ArrayBuffer | null;
  emissive: ArrayBuffer | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

/** The persisted preview for `base` (stem without `?v=`), or null if absent /
 *  storage unavailable. The caller checks `.v` against the current version. */
export async function getPreview(base: string): Promise<PreviewBytes | null> {
  try {
    const d = await db();
    return await new Promise<PreviewBytes | null>((resolve, reject) => {
      const req = d.transaction(STORE, "readonly").objectStore(STORE).get(base);
      req.onsuccess = () => resolve((req.result as PreviewBytes | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** Persist `entry` for `base`, overwriting any prior version. Best-effort. */
export async function putPreview(base: string, entry: PreviewBytes): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry, base);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* storage unavailable — skip; the network prewarm re-fetches next time */
  }
}

/** Ask the browser to make this origin's storage (IndexedDB included) exempt from
 *  automatic eviction. Best-effort: may be denied by browser heuristics, in which
 *  case IndexedDB is still "best-effort" durable (evicted only under whole-origin
 *  storage pressure — far stickier than the HTTP cache). Call once at boot. */
export async function persistStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
