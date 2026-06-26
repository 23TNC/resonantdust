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

import type { ToWorker, FromWorker, ChatMessage, ClockStats, CallStat, SubStat } from "./protocol";
import type { RenderRegion, Renderable } from "./render";
import init, { WasmClient } from "./wasm/resonantdust_client.js";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: FromWorker): void => ctx.postMessage(msg);

let gateUrl = "";
let core: WasmClient | null = null;
let pumpTimer: ReturnType<typeof setInterval> | null = null;
/** Last `player_soul_id()` posted to the main thread, so the pump only emits a
 *  `playerSoul` message on an actual change (notably -1 → resolved). */
let lastSoulId = -1;

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
    case "place": {
      const moved = core ? core.place_loose(msg.cardId, msg.surface, msg.owner, msg.q, msg.r) : false;
      // Push the predicted position to the feed BEFORE replying, so the new cell is
      // already in `desiredCards` when the drag's await resolves (no back-tween).
      if (moved) for (const viewId of views.keys()) emitView(viewId);
      post({ type: "placeResult", id: msg.id, moved });
      break;
    }
    case "placeStack": {
      const moved = core ? core.place_stack(msg.cardId, msg.parentId, msg.direction) : false;
      if (moved) for (const viewId of views.keys()) emitView(viewId);
      post({ type: "placeResult", id: msg.id, moved });
      break;
    }
    case "carriedRun": {
      const ids = core ? Array.from(core.carried_run(msg.cardId)) : [];
      post({ type: "carriedRun", id: msg.id, ids });
      break;
    }
    case "uploadMaster":
      core?.upload_master(msg.aspect, msg.faction, msg.variant, msg.channel, msg.data);
      break;
    case "modifyContent":
      core?.modify_content(msg.lineage, msg.text);
      break;
    case "addContent":
      core?.add_content(msg.name, msg.text);
      break;
    case "modifyLocale":
      core?.modify_locale(msg.domain, msg.json);
      break;
    case "modifyVisuals":
      core?.modify_visuals(msg.name, msg.text);
      break;
    case "sendChat":
      core?.send_chat(msg.body);
      break;
    case "give":
      core?.give(msg.owner, msg.cardKey, msg.zoneOwner, msg.surface, msg.worldQ, msg.worldR);
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
    // Subscribe the chat feed now that our sender id/name are known. Idempotent —
    // safe on a re-login. Inbound messages accumulate for the pump's `take_chat`.
    core.subscribe_chat();
    // The player_soul card streams in a pump or two later (discovery walk:
    // player_id → cards WHERE owner_id=player_id → player_soul). Wait briefly so
    // the view can open the player's own inventory.
    try {
      await waitFor(() => core!.player_soul_id() >= 0, 3000, "player_soul");
    } catch {
      // A fresh player owns no player_soul. `claim_or_login` deliberately does
      // NOT mint one — the soul lives in the cards DB, a different module the
      // players module can't write to — so by design the CLIENT mints it (the
      // headless harness does the same in `session.rs`). Create it: owner = our
      // player_id, the reserved `player_soul` def, surface 0 (never rendered) at
      // the origin. `give` is the generic create_card path; with zone_owner ==
      // owner and world (0,0) it sends `macro_zone = 0` → the exact harness seed.
      // Then wait for the discovery sub to stream it back so the login reply
      // carries a real soul id (the pump's `playerSoul` event is the backstop if
      // it lands even later).
      const pid = core.player_id();
      if (pid >= 0) {
        core.give(pid, "player_soul", pid, 0, 0, 0);
        try {
          await waitFor(() => core!.player_soul_id() >= 0, 5000, "player_soul(minted)");
          // A fresh player's starting kit, seeded into the player_soul's own
          // inventory (its inventory IS the player's): one blueprint + one dust,
          // which assemble a chord_soul via the `chord_soul_assemble` recipe.
          // `surface 1` = INVENTORY_LAYER; zone_owner == owner + (0,0) → the
          // shard first-free-places into the soul's inventory bucket.
          const soul = core.player_soul_id();
          if (soul >= 0) {
            core.give(soul, "blueprint_chord_soul", soul, 1, 0, 0);
            core.give(soul, "dust", soul, 1, 0, 0);
          }
        } catch {
          /* still pending — the pump's `playerSoul` event opens it if it lands */
        }
      }
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
    const changed = core.pump();
    // The gate may have hot-swapped its corpus (runtime add/modify, or an R2
    // upload the authority re-polled). Reload our matcher bundle + tell the main
    // thread BEFORE re-emitting, so the redraw uses the new defs.
    const version = core.take_content_changed();
    if (version !== undefined) void handleContentChanged(version);
    // Re-emit on row changes, OR while a pre-fire debounce is live so the queue
    // progress bar appears + advances (queuing is client-side and doesn't flip
    // `changed`). The build bar rides `changed` — the hold it sets IS a row change.
    if (changed || core.has_pending_debounce()) for (const viewId of views.keys()) emitView(viewId);
    // The player_soul card_id lands a pump or two after login (the discovery
    // walk), so the login reply often carried -1. Notify the main thread the
    // instant it resolves (or changes) so the view opens the player's inventory
    // — the soul is never rendered, so this is the only handle to it.
    const soul = core.player_soul_id();
    if (soul !== lastSoulId) {
      lastSoulId = soul;
      post({ type: "playerSoul", id: soul });
    }
    // Clock diagnostics for the debug HUD — drained every pump (independent of
    // `changed`) so the sync tab's sparklines have a continuous trail. Cheap; the
    // main thread skips the DOM work when the panel is closed.
    try {
      post({ type: "clockStats", stats: JSON.parse(core.clock_stats()) as ClockStats });
    } catch {
      /* malformed snapshot — skip this tick; the next pump's is independent */
    }
    // Per-reducer call tally for the debug HUD's "calls" tab — drained every
    // pump (independent of `changed`). Cheap; the main thread skips the DOM work
    // when the panel is closed.
    try {
      post({ type: "callStats", stats: JSON.parse(core.call_stats()) as CallStat[] });
    } catch {
      /* malformed snapshot — skip this tick; the next pump's is independent */
    }
    // Per-table subscription tally for the debug HUD's "subs" tab.
    try {
      post({ type: "subStats", stats: JSON.parse(core.sub_stats()) as SubStat[] });
    } catch {
      /* malformed snapshot — skip this tick; the next pump's is independent */
    }
    // Chat is a side feed (not world rows) — drain it independently of `changed`.
    const chat = core.take_chat();
    if (chat !== "[]") {
      try {
        const messages = JSON.parse(chat) as ChatMessage[];
        if (messages.length > 0) post({ type: "chat", messages });
      } catch {
        /* malformed batch — drop it; the next pump's messages are independent */
      }
    }
  }, 50);
}

/** Reload content after a gate hot-swap: re-fetch `/content`, rebuild the wasm
 *  matcher bundle, and signal the main thread (which refreshes its render-side
 *  `Content`/`Locales` and redraws). Guarded so overlapping changes don't race;
 *  a failed reload keeps the current bundle (the next change retries). */
let reloadingContent = false;
async function handleContentChanged(version: string): Promise<void> {
  if (reloadingContent || !core) return;
  reloadingContent = true;
  try {
    const rd = await fetchContent(httpBase(gateUrl));
    core.load_content(JSON.stringify(rd));
    post({ type: "contentChanged", version });
  } catch (err) {
    console.error("[worker] content reload failed", err);
  } finally {
    reloadingContent = false;
  }
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
