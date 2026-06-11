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
  // Drag-drop: place a card loose at a global cell, or stack it on a card. Fire-
  // and-forget — the outcome streams back through the render feed (no ack).
  | { type: "place"; cardId: number; surface: number; owner: number; q: number; r: number }
  | { type: "placeStack"; cardId: number; parentId: number; direction: number };

/** Worker → main thread. `reply` is correlated to a request by `id`; `event` is
 *  an unsolicited push; `ready` fires once the worker (and later the wasm) booted;
 *  `renderBatch` is one streamed chunk of a viewport's region. */
export type FromWorker =
  | { type: "ready" }
  | { type: "reply"; id: number; ok: true; result: LoginResult }
  | { type: "reply"; id: number; ok: false; error: string }
  | { type: "event"; event: ClientEvent }
  | { type: "renderBatch"; batch: RenderBatch };
