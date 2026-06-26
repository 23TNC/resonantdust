//! The message protocol between the `view` main thread and the client worker.
//!
//! The Rust `client` core (wasm) runs inside a Web Worker — a separate thread —
//! so the gate connection, world model, clock, and recipe matching never block
//! rendering or input on the main thread. Everything crosses the thread boundary
//! as structured-clone messages typed here.

import type { RenderRegion, RenderBatch } from "./render";

/** Result of a successful claim-or-login. */
export interface LoginResult {
  /** The player_id the gate assigned. */
  playerId: number;
  /** The player's `player_soul` card_id (its inventory IS the player's), or -1
   *  if the discovery walk hadn't surfaced it in time. */
  playerSoulId: number;
}

/** A world/state update pushed from the worker (rows, clock, action outcomes).
 *  Shape lands when the wasm core's event stream is wired; opaque for now. */
export type ClientEvent = { kind: string; [k: string]: unknown };

/** Clock-discipline + RTT diagnostics the worker drains from the wasm core each
 *  pump (the gate clock's internal state — `client_delay`, the sample window,
 *  round-trip times). This is the wasm-side slice exactly; the main thread adds
 *  the `Date.now()`-relative `dateNowMs`/`offsetMs` to fill the view's
 *  `SyncStats`. `null` fields read "—" in the HUD until synced. All ms unless
 *  noted. */
export interface ClockStats {
  serverNowMs: number;
  synced: boolean;
  clientDelayMs: number;
  runningDelayMs: number;
  runningDeltaMs: number;
  deltaMs: number | null;
  captures: number;
  bestOffsetMs: number | null;
  worstOffsetMs: number | null;
  rttMs: number | null;
  bestRttMs: number | null;
  rttSamples: number;
}

/** One reducer's gateway-call tally for the debug HUD's "calls" tab. `requests`
 *  counts outgoing `Call` frames (an outbox retry is another request); `ok`/
 *  `err`/`promise` count the `CallOk`/`CallErr`/`CallPromise` replies. `tx`/`rx`
 *  are serialized-frame byte ESTIMATES (they ignore WS framing + compression). */
export interface CallStat {
  command: string;
  requests: number;
  ok: number;
  err: number;
  promise: number;
  tx: number;
  rx: number;
}

/** One table's subscription tally for the debug HUD's "subs" tab. `subs` is the
 *  currently-open subscription count (zone/card subs are one-per-zone, so it
 *  tracks the anchor's coverage); `tx`/`rx` are serialized-frame byte ESTIMATES
 *  (tx = `Sub`/`Unsub` frames, rx = the `Row`/`Applied` frames streamed back). */
export interface SubStat {
  table: string;
  /** Currently-open subscriptions (`Sub` − `Unsub`) — a live gauge. */
  subs: number;
  /** Every `Sub` ever issued for this table — additive, never decremented. */
  total: number;
  tx: number;
  rx: number;
}

/** One chat message from the `chat_messages` feed. `sentAt` is the packed
 *  `[time_ms | seq]` key as a STRING — the u64 exceeds JS's safe-integer range,
 *  so it's carried as text (and is a stable per-message id / sort key). */
export interface ChatMessage {
  sentAt: string;
  senderPlayerId: number;
  senderName: string;
  body: string;
}

/** Main thread → worker.
 *
 *  Two channels share the worker: the LOGIN/event game-logic channel
 *  (`init`/`login`) and the RENDER-FEED channel (`renderOpen`/`renderUpdate`/
 *  `renderClose`). The render feed answers "what's in this region?" and is
 *  deliberately distinct from game logic — a viewport drives it without ever
 *  touching the matcher/world state directly. */
export type ToWorker =
  | { type: "init"; gateUrl: string }
  | { type: "login"; id: number; name: string }
  | { type: "renderOpen"; viewId: number; region: RenderRegion }
  | { type: "renderUpdate"; viewId: number; region: RenderRegion }
  | { type: "renderClose"; viewId: number }
  // Drag-drop: place a card loose at a global cell, or stack it on a card. The
  // worker applies the move, re-emits the affected views, then replies
  // `placeResult` (correlated by `id`) so the drag can wait for the decision before
  // releasing the ghost — without the wait the card tweens toward its stale cell
  // before the prediction streams back.
  | { type: "place"; id: number; cardId: number; surface: number; owner: number; q: number; r: number }
  | { type: "placeStack"; id: number; cardId: number; parentId: number; direction: number }
  // Drag pickup: ask the headless core which cards a loose drag of `cardId` lifts
  // (the grabbed card + the run the resolver carries). Correlated reply by `id`.
  | { type: "carriedRun"; id: number; cardId: number }
  // Art authoring: upload an edited master texture channel (base64 PNG) to the
  // gate, which writes it to the texture R2 bucket. Fire-and-forget.
  | { type: "uploadMaster"; aspect: string; faction: string; variant: string; channel: string; data: string }
  // DSL authoring: write a new version of an existing `.rd` source (`modify`) or
  // a brand-new one (`add`) — the gate validates + hot-swaps + persists to R2.
  | { type: "modifyContent"; lineage: string; text: string }
  | { type: "addContent"; name: string; text: string }
  // Locale authoring: replace a locale domain's JSON — same gate validate +
  // hot-swap + R2 persist + content_changed as the `.rd` author path.
  | { type: "modifyLocale"; domain: string; json: string }
  // Visuals authoring: replace a `visuals/…` source in place — same gate validate
  // + hot-swap + R2 persist + content_changed.
  | { type: "modifyVisuals"; name: string; text: string }
  // Chat: send a message to the world feed. Fire-and-forget — it echoes back
  // through the `chat` push like everyone else's.
  | { type: "sendChat"; body: string }
  // Dev `/give`: create a card via `create_card`. `owner` owns it; `cardKey` is
  // the def id; it lands in `zoneOwner`'s `surface` zone (worldQ/worldR=0,0 +
  // zoneOwner==owner → shard auto-places collision-free). Fire-and-forget.
  | { type: "give"; owner: number; cardKey: string; zoneOwner: number; surface: number; worldQ: number; worldR: number };

/** Worker → main thread. `reply` is correlated to a request by `id`; `event` is
 *  an unsolicited push; `ready` fires once the worker (and later the wasm) booted;
 *  `renderBatch` is one streamed chunk of a viewport's region. */
export type FromWorker =
  | { type: "ready" }
  | { type: "reply"; id: number; ok: true; result: LoginResult }
  | { type: "reply"; id: number; ok: false; error: string }
  | { type: "event"; event: ClientEvent }
  | { type: "renderBatch"; batch: RenderBatch }
  // Reply to a `carriedRun` request: the drag pickup set (grabbed card first).
  | { type: "carriedRun"; id: number; ids: number[] }
  // Reply to a `place`/`placeStack` request: whether the card moved. The affected
  // views were re-emitted just before this, so the new position is already in the
  // feed when the drag's await resolves.
  | { type: "placeResult"; id: number; moved: boolean }
  // The gate hot-swapped its content corpus; the worker has reloaded its matcher
  // bundle. The main thread refreshes its render-side `Content`/`Locales` and
  // redraws. `version` is the new corpus fingerprint (for logging/dedupe).
  | { type: "contentChanged"; version: string }
  // One or more chat messages folded since the last pump (chronological). The
  // main thread fans them to the chat UI. Never empty (the worker skips empties).
  | { type: "chat"; messages: ChatMessage[] }
  // Clock-discipline + RTT diagnostics drained from the wasm core each pump, for
  // the debug HUD's "sync" tab. The raw wasm slice; the main thread adds the
  // `Date.now()`-relative fields (the core only knows its server estimate).
  | { type: "clockStats"; stats: ClockStats }
  // Per-reducer gateway-call tally drained each pump, for the debug HUD's
  // "calls" tab (request/ok/err/promise counts + tx/rx byte estimates).
  | { type: "callStats"; stats: CallStat[] }
  // Per-table subscription tally drained each pump, for the debug HUD's "subs"
  // tab (open-subscription count + tx/rx byte estimates).
  | { type: "subStats"; stats: SubStat[] }
  // Our `player_soul` card_id resolved (or changed). It streams in a pump or two
  // AFTER login (discovery walk: player_id → cards WHERE owner_id=player_id), so
  // the login reply often carries `-1`; this fires when it actually lands so the
  // view can open the player's own inventory. `id` is `-1` only if it un-resolves.
  | { type: "playerSoul"; id: number };
