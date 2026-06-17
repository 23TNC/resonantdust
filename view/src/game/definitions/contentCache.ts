//! Persistent corpus cache (IndexedDB) — lets a returning client seed the content
//! runtime and warm preview LODs BEFORE login, hiding the cold-start white flash.
//!
//! The gate is the authority on the current corpus, so anything read here is
//! OPTIMISTIC: we seed from the last session's cache to start the preview prewarm
//! early, then reconcile against the gate's `/content` at login (a version match
//! validates the warm atlas; a mismatch swaps it). Keyed by environment, since
//! each gate (dev/claude/alpha) owns its own corpus + version.
//!
//! IndexedDB (not localStorage) because the corpus is large-ish JSON and the API
//! is async/off-thread. Every op is best-effort — a private-mode/quota failure
//! degrades to "no cache" (cold start), never an error.

const DB_NAME = "resonantdust";
const STORE = "kv";
const DB_VERSION = 1;
/** Last environment a corpus was cached for — what the pre-login warm targets. */
const LAST_ENV_KEY = "lastEnv";

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function idbGet<T>(key: string): Promise<T | null> {
  const d = await db();
  return new Promise<T | null>((resolve, reject) => {
    const req = d.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Persist `payload` (the `/content` corpus) for `env` and record it as the most
 *  recently used env. Best-effort — swallows storage failures. */
export async function cacheCorpus(env: string, payload: unknown): Promise<void> {
  try {
    await idbPut(`corpus:${env}`, payload);
    await idbPut(LAST_ENV_KEY, env);
  } catch {
    /* storage unavailable (private mode / quota) — skip, cold start next time */
  }
}

/** The cached corpus for `env`, or null if none / storage unavailable. */
export async function cachedCorpus(env: string): Promise<unknown | null> {
  try {
    return await idbGet<unknown>(`corpus:${env}`);
  } catch {
    return null;
  }
}

/** The env a corpus was most recently cached for (what to pre-warm at boot), or
 *  null on a first-ever visit / storage unavailable. */
export async function lastEnv(): Promise<string | null> {
  try {
    return await idbGet<string>(LAST_ENV_KEY);
  } catch {
    return null;
  }
}
