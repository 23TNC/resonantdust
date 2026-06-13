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
/** The raw fetched corpus (`.rd` + locale sources). The wasm runtimes don't
 *  expose source text, so the Card Editor reads a card's DSL / locale entries
 *  from here. Kept in sync with the live runtimes on init + reload. */
let sources: ContentPayload | null = null;
let contentVersion = "";
let initPromise: Promise<void> | null = null;
/** The gate HTTP base `initContent` loaded from, reused by `reloadContent`. */
let httpBaseUsed = "";

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
      sources = payload;
      contentVersion = payload.version;
      httpBaseUsed = httpBase;
    })();
  }
  await initPromise;
}

const reloadListeners = new Set<() => void>();

/** Re-fetch the gate corpus and swap the live `Content`/`Locales` in place — the
 *  gate hot-swapped its content (a runtime add/modify, or an R2 upload the
 *  authority re-polled). The new runtimes are built BEFORE the swap, so a bad
 *  corpus throws and leaves the working content untouched. On a real change the
 *  version bumps and `onContentReloaded` listeners fire so content-derived caches
 *  (defs, globals, the viewport's retained nodes) rebuild. No-op before
 *  `initContent`, or when the version is unchanged. */
export async function reloadContent(): Promise<void> {
  if (!content || !httpBaseUsed) return;
  const resp = await fetch(`${httpBaseUsed}/content`);
  if (!resp.ok) {
    throw new Error(`content reload failed: ${resp.status} ${resp.statusText}`);
  }
  const payload = (await resp.json()) as ContentPayload;
  if (payload.version === contentVersion) return; // already current — nothing to swap
  // Build the new runtimes first; if the corpus is bad this throws here and the
  // live content is never replaced.
  const nextContent = new Content(JSON.stringify(payload.rd));
  const nextLocales = new Locales(JSON.stringify(payload.locales));
  const prevContent = content;
  const prevLocales = locales;
  content = nextContent;
  locales = nextLocales;
  sources = payload;
  contentVersion = payload.version;
  // Free the superseded wasm runtimes (nothing retains them — DefinitionManager
  // reads `sharedContent()` live each call).
  prevContent?.free();
  prevLocales?.free();
  for (const cb of reloadListeners) cb();
}

/** Subscribe to content reloads (a gate hot-swap relayed via `content_changed`,
 *  driving `reloadContent`). Fired after `Content`/`Locales` are swapped, so
 *  listeners re-derive content-derived caches (`DefinitionManager`, `globals`,
 *  the viewport's retained nodes). Returns an unsubscribe fn. */
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

/** The raw corpus sources (`.rd` pairs + locale JSON) — for tooling that needs
 *  source text the wasm runtimes don't expose (the Card Editor's DSL/locale
 *  tabs). `null` before {@link initContent}. */
export function contentSources(): { rd: [string, string][]; locales: [string, string][] } | null {
  return sources;
}

/** The loaded corpus version fingerprint (hex). Empty until `initContent()`. */
export function getContentVersion(): string {
  return contentVersion;
}
