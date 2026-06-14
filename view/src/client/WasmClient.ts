//! Main-thread proxy to the Rust `client` core, which runs in a Web Worker (a
//! separate thread — see `clientWorker.ts`). The view never touches a gateway
//! directly and never runs client logic on the render thread: this class spawns
//! the worker, forwards intents (login, …) as correlated request/reply messages,
//! and will surface the worker's event stream (rows/world updates) for rendering.
//!
//! Because the wasm core lives in the worker, a slow gate round-trip or a heavy
//! matching pass can't stall PIXI — the main thread only ever does message I/O.

import ClientWorker from "./clientWorker.ts?worker";
import type { ToWorker, FromWorker, LoginResult, ClientEvent, ChatMessage, ClockStats, CallStat, SubStat } from "./protocol";
import type { RenderRegion, RenderBatch, ViewportFeed } from "./render";

export type { LoginResult, ChatMessage, ClockStats, CallStat, SubStat };
export type { RenderRegion, RenderBatch, ViewportFeed };

/** Player name that unlocks developer-only UI (the right-click card menu,
 *  etc.). There's no server-side role yet — this is a client-side gate keyed
 *  off the login name. Swap for a real permission check (the `players`
 *  module's `PERM_*` byte) when one is wired through the gate protocol. */
export const DEVELOPER_NAME = "Developer";

type Pending = { resolve: (r: LoginResult) => void; reject: (e: Error) => void };

export class WasmClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<void>;
  /** Cached from the last successful login. `-1` until then. */
  private _playerId = -1;
  private _playerSoulId = -1;
  /** The name the last successful login authenticated as. `""` until then. */
  private _playerName = "";
  /** The logged-in player's id, or -1 before login. */
  get playerId(): number { return this._playerId; }
  /** The logged-in player's `player_soul` card_id (its inventory is the
   *  player's own), or -1 before login / before discovery surfaced it. */
  get playerSoulId(): number { return this._playerSoulId; }
  /** The name the logged-in player authenticated as, or `""` before login. */
  get playerName(): string { return this._playerName; }
  /** Whether the logged-in player is the developer (gates dev-only UI).
   *  See {@link DEVELOPER_NAME}. */
  get isDeveloper(): boolean { return this._playerName === DEVELOPER_NAME; }
  private readonly eventListeners = new Set<(e: ClientEvent) => void>();
  /** Fired when the gate hot-swapped its content corpus (the worker reloaded its
   *  matcher bundle); the app refreshes its render-side `Content`/`Locales`. */
  private readonly contentChangedListeners = new Set<(version: string) => void>();
  /** Fired with each batch of chat messages the worker drained from the feed. */
  private readonly chatListeners = new Set<(messages: ChatMessage[]) => void>();
  /** Fired each pump with the latest clock-discipline + RTT diagnostics (debug HUD). */
  private readonly clockStatsListeners = new Set<(stats: ClockStats) => void>();
  /** Fired each pump with the latest per-reducer gateway-call tally (debug HUD). */
  private readonly callStatsListeners = new Set<(stats: CallStat[]) => void>();
  /** Fired each pump with the latest per-table subscription tally (debug HUD). */
  private readonly subStatsListeners = new Set<(stats: SubStat[]) => void>();
  /** Fired when discovery resolves (or changes) our `player_soul` card_id — a
   *  pump or two after login. The view opens the player's own inventory here. */
  private readonly playerSoulListeners = new Set<(id: number) => void>();
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
        case "contentChanged":
          for (const fn of this.contentChangedListeners) fn(msg.version);
          break;
        case "chat":
          for (const fn of this.chatListeners) fn(msg.messages);
          break;
        case "clockStats":
          for (const fn of this.clockStatsListeners) fn(msg.stats);
          break;
        case "callStats":
          for (const fn of this.callStatsListeners) fn(msg.stats);
          break;
        case "subStats":
          for (const fn of this.subStatsListeners) fn(msg.stats);
          break;
        case "playerSoul":
          // Discovery surfaced (or changed) our player_soul after login. Keep the
          // cached id in sync and notify listeners so the view opens the player's
          // own inventory even when the login reply raced ahead of discovery.
          this._playerSoulId = msg.id;
          for (const fn of this.playerSoulListeners) fn(msg.id);
          break;
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
    this._playerName = name;
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

  /** Upload an edited master texture channel (art editor "save master"). The gate
   *  writes the base64 PNG to the texture R2 bucket at
   *  `textures/master/<aspect>/<faction>/<variant>.<channel>.png`. Fire-and-forget;
   *  gated server-side on the content-author capability. */
  uploadMaster(
    aspect: string,
    faction: string,
    variant: string,
    channel: string,
    dataB64: string,
  ): void {
    this.post({ type: "uploadMaster", aspect, faction, variant, channel, data: dataB64 });
  }

  /** Author a new version of an existing `.rd` source (art editor "save DSL").
   *  The gate validates + hot-swaps + persists to R2, then broadcasts
   *  `content_changed` (which `onContentChanged` listeners pick up). Fire-and-
   *  forget; gated server-side on the content-author capability. */
  modifyContent(lineage: string, text: string): void {
    this.post({ type: "modifyContent", lineage, text });
  }

  /** Author a brand-new `.rd` source (a facet the card didn't ship). Same gate
   *  validate + hot-swap + persist as {@link modifyContent}. */
  addContent(name: string, text: string): void {
    this.post({ type: "addContent", name, text });
  }

  /** Replace a locale domain's JSON (art editor "save locale"). The gate
   *  validates + hot-swaps + persists, then broadcasts `content_changed`. */
  modifyLocale(domain: string, json: string): void {
    this.post({ type: "modifyLocale", domain, json });
  }

  /** Replace a `visuals/…` source in place (art editor "save visuals"). The gate
   *  validates + hot-swaps + persists, then broadcasts `content_changed`. */
  modifyVisuals(name: string, text: string): void {
    this.post({ type: "modifyVisuals", name, text });
  }

  /** Subscribe to world/state events pushed from the worker. Returns an
   *  unsubscribe fn. (Event stream is wired when the wasm core lands.) */
  onEvent(fn: (e: ClientEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /** Send a chat message to the world feed. Fire-and-forget: it arrives back
   *  through {@link onChat} like every other client's, so the UI renders it from
   *  the feed rather than echoing locally. The worker fills sender id/name from
   *  the session; the shard trims/validates the body. */
  sendChat(body: string): void {
    this.post({ type: "sendChat", body });
  }

  /** Create a card (the dev `/give` path). `owner` owns the new `cardKey` card;
   *  it lands in `zoneOwner`'s `surface` zone. With `worldQ/worldR === 0` and
   *  `zoneOwner === owner` the shard auto-places it collision-free (first free
   *  cell); otherwise it's placed at the exact resolved cell. Fire-and-forget —
   *  the row streams back through the render feed if the zone is in view. */
  give(owner: number, cardKey: string, zoneOwner: number, surface: number, worldQ: number, worldR: number): void {
    this.post({ type: "give", owner, cardKey, zoneOwner, surface, worldQ, worldR });
  }

  /** Subscribe to chat messages streamed from the feed (the worker drains the
   *  wasm core each pump and forwards non-empty batches). Returns an unsubscribe
   *  fn. Messages arrive sorted by `sentAt`. */
  onChat(fn: (messages: ChatMessage[]) => void): () => void {
    this.chatListeners.add(fn);
    return () => this.chatListeners.delete(fn);
  }

  /** Subscribe to the clock-discipline + RTT diagnostics the worker drains each
   *  pump (server-time estimate, `client_delay`, sample-window spread, RTT). The
   *  debug HUD's sync tab consumes this. Returns an unsubscribe fn. */
  onClockStats(fn: (stats: ClockStats) => void): () => void {
    this.clockStatsListeners.add(fn);
    return () => this.clockStatsListeners.delete(fn);
  }

  /** Subscribe to the per-reducer gateway-call tally the worker drains each pump
   *  (request/ok/err/promise counts + tx/rx byte estimates). The debug HUD's
   *  "calls" tab consumes this. Returns an unsubscribe fn. */
  onCallStats(fn: (stats: CallStat[]) => void): () => void {
    this.callStatsListeners.add(fn);
    return () => this.callStatsListeners.delete(fn);
  }

  /** Subscribe to the per-table subscription tally the worker drains each pump
   *  (open-subscription count + tx/rx byte estimates). The debug HUD's "subs"
   *  tab consumes this. Returns an unsubscribe fn. */
  onSubStats(fn: (stats: SubStat[]) => void): () => void {
    this.subStatsListeners.add(fn);
    return () => this.subStatsListeners.delete(fn);
  }

  /** Subscribe to gate content hot-swaps (a runtime add/modify, or an R2 upload
   *  the authority re-polled). The worker has already reloaded its matcher
   *  bundle when this fires; the handler refreshes the render-side content
   *  (`reloadContent`). Returns an unsubscribe fn. */
  onContentChanged(fn: (version: string) => void): () => void {
    this.contentChangedListeners.add(fn);
    return () => this.contentChangedListeners.delete(fn);
  }

  /** Subscribe to `player_soul` resolution. Fires when discovery surfaces our
   *  player_soul card_id after login (or if it later changes). Fires with `-1`
   *  only on un-resolve. Returns an unsubscribe fn. The view uses this to open
   *  the player's own inventory once the soul lands — the login reply often
   *  carries `-1` because discovery hasn't finished a pump or two in. */
  onPlayerSoul(fn: (id: number) => void): () => void {
    this.playerSoulListeners.add(fn);
    return () => this.playerSoulListeners.delete(fn);
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
    this.contentChangedListeners.clear();
    this.chatListeners.clear();
    this.clockStatsListeners.clear();
    this.callStatsListeners.clear();
    this.subStatsListeners.clear();
    this.viewListeners.clear();
  }
}
