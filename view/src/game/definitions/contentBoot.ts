//! Content bootstrap — load the DSL corpus + locales from the gate into the wasm
//! `Content` / `Locales` runtimes (the DSL VM that produces PrimLists + decodes
//! definitions + resolves locale strings).
//!
//! The gate serves `GET /content` → `{ version, rd: [[name,text]…],
//! locales: [[domain,json]…] }` — the exact bytes it validates against, so the
//! client and gate agree by construction. We init the wasm module once, fetch the
//! corpus, and construct the two runtimes. Runs on the MAIN thread (the renderer's
//! `drawVisuals`/`tilePrims` call it) — distinct from the client-core wasm in the
//! worker.
//!
//! Unlike the old pixijs client, the gate is ENV-SELECTED at login, so
//! `initContent(httpBase)` takes the base explicitly (called by `LoginScene` after
//! the user picks a server, before entering the world).

import init, { Content, Locales } from "./wasm/resonantdust_shared";

/** Shape of the gate's `/content` payload. */
interface ContentPayload {
  version: string;
  /** `[name, text]` pairs of `.rd` sources — feeds `new Content(...)`. */
  rd: [string, string][];
  /** `[domain, json]` pairs of locale catalogs — feeds `new Locales(...)`. */
  locales: [string, string][];
}

let content: Content | null = null;
let locales: Locales | null = null;
let contentVersion = "";
let initPromise: Promise<void> | null = null;

/** Load the wasm runtime + fetch the gate corpus at `httpBase` into `Content` /
 *  `Locales`. Idempotent — one in-flight promise; subsequent calls await it.
 *  Throws on a failed fetch or an unparseable corpus (loud at boot, not
 *  mid-game). */
export async function initContent(httpBase: string): Promise<void> {
  if (content) return;
  if (!initPromise) {
    initPromise = (async () => {
      await init();
      const resp = await fetch(`${httpBase}/content`);
      if (!resp.ok) {
        throw new Error(`content fetch failed: ${resp.status} ${resp.statusText}`);
      }
      const payload = (await resp.json()) as ContentPayload;
      content = new Content(JSON.stringify(payload.rd));
      locales = new Locales(JSON.stringify(payload.locales));
      contentVersion = payload.version;
    })();
  }
  await initPromise;
}

const reloadListeners = new Set<() => void>();

/** Subscribe to content reloads (a runtime add/modify pushed by the gate). Fired
 *  after `Content`/`Locales` are swapped, so listeners re-derive content-derived
 *  caches. Returns an unsubscribe fn. (No gate `content_changed` wiring in the
 *  view yet — present so `DefinitionManager` can subscribe.) */
export function onContentReloaded(cb: () => void): () => void {
  reloadListeners.add(cb);
  return () => reloadListeners.delete(cb);
}

/** The loaded content runtime. Throws if `initContent()` hasn't resolved. */
export function sharedContent(): Content {
  if (!content) throw new Error("content not initialised — await initContent() first");
  return content;
}

/** The loaded locale runtime. Throws if `initContent()` hasn't resolved. */
export function sharedLocales(): Locales {
  if (!locales) throw new Error("locales not initialised — await initContent() first");
  return locales;
}

/** The loaded corpus version fingerprint (hex). Empty until `initContent()`. */
export function getContentVersion(): string {
  return contentVersion;
}
