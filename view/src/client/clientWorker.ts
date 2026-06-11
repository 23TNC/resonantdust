/// <reference lib="webworker" />
//! Client worker — the separate thread hosting the Rust `client` core (wasm).
//!
//! Runs off the main thread so the gate connection + world model + matching never
//! block rendering. It loads the wasm bundle (`./wasm/resonantdust_client.js`,
//! built by `bin/client wasm`) and drives it: connect → load content → login →
//! `pump` on an interval. The render-feed channel answers region queries from the
//! core's world snapshot and re-emits when rows change.
//!
//! The wasm surface is synchronous (web-sys WebSocket send + onmessage); the one
//! async step — fetching the `/content` bundle — happens HERE in JS and is handed
//! to `load_content`.

import type { ToWorker, FromWorker } from "./protocol";
import type { RenderRegion, Renderable } from "./render";
import init, { WasmClient } from "./wasm/resonantdust_client.js";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: FromWorker): void => ctx.postMessage(msg);

let gateUrl = "";
let core: WasmClient | null = null;
let pumpTimer: ReturnType<typeof setInterval> | null = null;

/** Per-viewport render state: its current region + a generation counter (bumped
 *  on every emit so the viewport drops stale lower-gen batches). */
interface ViewState {
  region: RenderRegion;
  gen: number;
}
const views = new Map<number, ViewState>();

ctx.onmessage = (e: MessageEvent<ToWorker>): void => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      gateUrl = msg.gateUrl;
      break;
    case "login":
      void handleLogin(msg.id, msg.name);
      break;
    case "renderOpen":
    case "renderUpdate":
      openOrUpdate(msg.viewId, msg.region);
      break;
    case "renderClose":
      views.delete(msg.viewId);
      break;
    case "place":
      core?.place_loose(msg.cardId, msg.surface, msg.owner, msg.q, msg.r);
      break;
    case "placeStack":
      core?.place_stack(msg.cardId, msg.parentId, msg.direction);
      break;
  }
};

// The worker is live and listening; the wasm core loads lazily on first login.
post({ type: "ready" });

// ── login: bring the wasm core up + connect to the selected gate ─────
async function handleLogin(id: number, name: string): Promise<void> {
  try {
    if (!core) {
      await init(); // instantiate the wasm module
      core = new WasmClient();
      core.connect(wsUrl(gateUrl));
      await waitFor(() => core!.is_open(), 8000, "gate connection");
      const rd = await fetchContent(httpBase(gateUrl));
      core.load_content(JSON.stringify(rd));
      startPump();
    }
    core.login(name);
    await waitFor(() => core!.player_id() >= 0, 8000, "player_id");
    // The player_soul card streams in a pump or two later (discovery walk:
    // player_id → cards WHERE owner_id=player_id → player_soul). Wait briefly so
    // the view can open the player's own inventory; -1 if it doesn't arrive.
    try {
      await waitFor(() => core!.player_soul_id() >= 0, 3000, "player_soul");
    } catch {
      /* leave it at -1 — the player inventory just won't open */
    }
    post({
      type: "reply",
      id,
      ok: true,
      result: { playerId: core.player_id(), playerSoulId: core.player_soul_id() },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    post({ type: "reply", id, ok: false, error });
  }
}

/** Drive the core every 50ms; re-emit active regions when rows changed. */
function startPump(): void {
  if (pumpTimer !== null) return;
  pumpTimer = setInterval(() => {
    if (!core) return;
    if (core.pump()) for (const viewId of views.keys()) emitView(viewId);
  }, 50);
}

// ── render feed ─────────────────────────────────────────────────────
const CHUNK = 96;

function openOrUpdate(viewId: number, region: RenderRegion): void {
  const prev = views.get(viewId);
  views.set(viewId, { region, gen: prev?.gen ?? 0 });
  if (core) {
    // Aim the gate subscription at this region so its zones (and the cards in
    // them) stream in. Radius is in TILES — the visible half-extent — so the
    // anchor's `active` disk covers exactly what's on screen; the core adds a
    // prefetch ring beyond it (so edge zones load before they scroll in).
    const radiusTiles = Math.max(region.halfCols, region.halfRows);
    core.set_anchor(region.surface, region.owner, region.q, region.r, radiusTiles);
  }
  emitView(viewId);
}

function emitView(viewId: number): void {
  const v = views.get(viewId);
  if (!v || !core) {
    if (v) post({ type: "renderBatch", batch: { viewId, gen: v.gen, items: [], final: true } });
    return;
  }
  v.gen += 1;
  const gen = v.gen;
  const { surface, owner, q, r, halfCols, halfRows } = v.region;
  let items: Renderable[];
  try {
    items = JSON.parse(core.render_region(surface, owner, q, r, halfCols, halfRows)) as Renderable[];
  } catch {
    items = [];
  }
  if (items.length === 0) {
    post({ type: "renderBatch", batch: { viewId, gen, items: [], final: true } });
    return;
  }
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    const final = i + CHUNK >= items.length;
    post({ type: "renderBatch", batch: { viewId, gen, items: slice, final } });
  }
}

// ── helpers ─────────────────────────────────────────────────────────
/** The gate WS URL is already `ws://host:port/ws`. */
function wsUrl(url: string): string {
  return url;
}

/** Derive the HTTP base (`http://host:port`) from the WS URL for `/content`. */
function httpBase(url: string): string {
  return url.replace(/^ws/, "http").replace(/\/ws$/, "");
}

/** Fetch the gate's `/content` bundle and return its `rd` source pairs. */
async function fetchContent(base: string): Promise<Array<[string, string]>> {
  const resp = await fetch(`${base}/content`);
  if (!resp.ok) throw new Error(`content fetch ${resp.status}`);
  const payload = (await resp.json()) as { rd: Array<[string, string]> };
  return payload.rd;
}

/** Poll `cond` until true or `timeoutMs` elapses (the wasm surface is sync, so a
 *  one-shot connect/login resolves by polling rather than a callback). */
function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (performance.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 40);
    };
    tick();
  });
}
