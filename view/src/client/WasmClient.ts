//! Main-thread proxy to the Rust `client` core, which runs in a Web Worker (a
//! separate thread — see `clientWorker.ts`). The view never touches a gateway
//! directly and never runs client logic on the render thread: this class spawns
//! the worker, forwards intents (login, …) as correlated request/reply messages,
//! and will surface the worker's event stream (rows/world updates) for rendering.
//!
//! Because the wasm core lives in the worker, a slow gate round-trip or a heavy
//! matching pass can't stall PIXI — the main thread only ever does message I/O.

import ClientWorker from "./clientWorker.ts?worker";
import type { ToWorker, FromWorker, LoginResult, ClientEvent } from "./protocol";
import type { RenderRegion, RenderBatch, ViewportFeed } from "./render";

export type { LoginResult };
export type { RenderRegion, RenderBatch, ViewportFeed };

type Pending = { resolve: (r: LoginResult) => void; reject: (e: Error) => void };

export class WasmClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<void>;
  /** Cached from the last successful login. `-1` until then. */
  private _playerId = -1;
  private _playerSoulId = -1;
  /** The logged-in player's id, or -1 before login. */
  get playerId(): number { return this._playerId; }
  /** The logged-in player's `player_soul` card_id (its inventory is the
   *  player's own), or -1 before login / before discovery surfaced it. */
  get playerSoulId(): number { return this._playerSoulId; }
  private readonly eventListeners = new Set<(e: ClientEvent) => void>();
  /** Per-viewport render-batch handlers, keyed by the viewId assigned in
   *  {@link openViewport}. */
  private nextViewId = 1;
  private readonly viewListeners = new Map<number, (b: RenderBatch) => void>();

  /** The gate WS endpoint the worker's wasm core connects to. Re-pointed by
   *  {@link setGateUrl} when the user picks a different environment. */
  private gateUrl: string;

  /** @param gateUrl the gateway WS endpoint the worker's wasm core connects to. */
  constructor(gateUrl: string) {
    this.gateUrl = gateUrl;
    this.worker = new ClientWorker();

    let markReady!: () => void;
    this.ready = new Promise<void>((res) => (markReady = res));

    this.worker.onmessage = (e: MessageEvent<FromWorker>): void => {
      const msg = e.data;
      switch (msg.type) {
        case "ready":
          markReady();
          break;
        case "reply": {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error));
          break;
        }
        case "event":
          for (const fn of this.eventListeners) fn(msg.event);
          break;
        case "renderBatch": {
          const fn = this.viewListeners.get(msg.batch.viewId);
          fn?.(msg.batch);
          break;
        }
      }
    };
    this.worker.onerror = (e): void => console.error("[WasmClient] worker error", e.message);

    this.post({ type: "init", gateUrl });
  }

  private post(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }

  /** Point the client at a different gate (the user selecting an environment).
   *  Re-inits the worker's transport target; takes effect on the next login. */
  setGateUrl(gateUrl: string): void {
    if (gateUrl === this.gateUrl) return;
    this.gateUrl = gateUrl;
    this.post({ type: "init", gateUrl });
  }

  /** Claim-or-login as `name` via the worker's wasm core. Resolves with the
   *  assigned player_id (rejects with the worker's error). */
  async login(name: string): Promise<LoginResult> {
    await this.ready;
    const id = this.nextId++;
    const result = await new Promise<LoginResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: "login", id, name });
    });
    this._playerId = result.playerId;
    this._playerSoulId = result.playerSoulId;
    return result;
  }

  /** Drop a card loose at a GLOBAL world cell `(q, r)` on `(surface, owner)` —
   *  the drag-drop path. Fire-and-forget: the resulting position arrives via the
   *  render feed (success → dropped cell, rejection → unchanged data → origin). */
  placeLoose(cardId: number, surface: number, owner: number, q: number, r: number): void {
    this.post({ type: "place", cardId, surface, owner, q, r });
  }

  /** Drop a card onto `parentId`'s stack in `direction` (drop-on-a-card). */
  placeStack(cardId: number, parentId: number, direction: number): void {
    this.post({ type: "placeStack", cardId, parentId, direction });
  }

  /** Subscribe to world/state events pushed from the worker. Returns an
   *  unsubscribe fn. (Event stream is wired when the wasm core lands.) */
  onEvent(fn: (e: ClientEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /** Open a render feed for a viewport. The client streams `onBatch` chunks of
   *  whatever it finds in `region` (see {@link RenderBatch}); the returned
   *  handle re-aims (`update`) or tears down (`close`) the feed. Independent of
   *  the login/event channel — a viewport drives this without touching game
   *  logic. */
  openViewport(region: RenderRegion, onBatch: (b: RenderBatch) => void): ViewportFeed {
    const viewId = this.nextViewId++;
    this.viewListeners.set(viewId, onBatch);
    // `init` is fire-and-forget on construction, so the worker is reachable
    // immediately for posts; batches just won't flow until it's `ready`. Gate on
    // ready so an open issued before boot still streams.
    void this.ready.then(() => {
      if (this.viewListeners.has(viewId)) this.post({ type: "renderOpen", viewId, region });
    });
    return {
      update: (next) => {
        if (this.viewListeners.has(viewId)) this.post({ type: "renderUpdate", viewId, region: next });
      },
      close: () => {
        this.viewListeners.delete(viewId);
        this.post({ type: "renderClose", viewId });
      },
    };
  }

  /** Tear down the worker thread. */
  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
    this.eventListeners.clear();
    this.viewListeners.clear();
  }
}
