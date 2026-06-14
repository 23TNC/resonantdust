/* tslint:disable */
/* eslint-disable */

export class WasmClient {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Author a brand-new `.rd` source named `name` with `text` (a card that
     * shipped no source for this facet). Same authority validate + hot-swap +
     * persist + `content_changed` as `modify_content`.
     */
    add_content(name: string, text: string): void;
    /**
     * Per-reducer gateway-call tally as a JSON array (the debug HUD's "calls"
     * tab): `[{ command, requests, ok, err, promise, tx, rx }]`, sorted by
     * command name. `tx`/`rx` are serialized-frame byte ESTIMATES. Cheap —
     * drained each pump.
     */
    call_stats(): string;
    /**
     * The clock-discipline + RTT diagnostics as a JSON object (the view's
     * `SyncStats` shape, camelCase) for the debug HUD's "sync" tab. The view
     * adds the `Date.now()`-relative fields itself. Cheap — call each pump.
     */
    clock_stats(): string;
    /**
     * Open the gate WebSocket and wire the inbound queue + open flag. Returns once
     * the socket is *created*; poll [`is_open`](Self::is_open) for the handshake.
     */
    connect(ws_url: string): void;
    /**
     * Create a new card via `create_card` — the chat `/give` path. `owner` owns
     * the new card; `card_key` is the content def id (e.g. `"corpus"`); the new
     * card lands in `zone_owner`'s `surface` zone (the gate resolves the def +
     * stock; the shard places it).
     *
     * Placement: when `world_q/world_r` are `0,0` AND `zone_owner == owner`, send
     * `macro_zone = 0` so the SHARD auto-places into the default bucket
     * (`first_free_cell` — collision-free; this is `/give 1025 corpus` → first
     * empty inventory slot). Otherwise resolve the global cell to an explicit
     * `macro_zone` + local cell (world zones are owned by `0`, inventory zones by
     * the container card) and place there (exact snap, no collision avoidance).
     */
    give(owner: number, card_key: string, zone_owner: number, surface: number, world_q: number, world_r: number): void;
    /**
     * True once the WebSocket handshake completed.
     */
    is_open(): boolean;
    /**
     * Load the DSL content the JS side fetched from the gate's `/content`.
     * `rd_json` is the `[[name, src], …]` array (the payload's `rd` field).
     */
    load_content(rd_json: string): void;
    /**
     * Trust-on-first-use login. `player_id` lands later via `pump`.
     */
    login(name: string): void;
    /**
     * Author a NEW version of an existing `.rd` source (art editor "save DSL").
     * `lineage` is the source name the gate tracks; `text` is the full file. The
     * authority validates + hot-swaps + persists to R2, then broadcasts
     * `content_changed`. Fire-and-forget — gated on the content-author capability.
     */
    modify_content(lineage: string, text: string): void;
    /**
     * Replace locale `domain`'s JSON (art editor "save locale"). The authority
     * validates + hot-swaps + persists + broadcasts `content_changed`. Fire-and-
     * forget — gated on the content-author capability.
     */
    modify_locale(domain: string, json: string): void;
    /**
     * Replace visuals source `name` (`visuals/…`) with `text` (art editor "save
     * visuals"). The authority validates + hot-swaps + persists + broadcasts
     * `content_changed`. Fire-and-forget — gated on the content-author capability.
     */
    modify_visuals(name: string, text: string): void;
    constructor();
    /**
     * Drop a card loose at a GLOBAL world cell `(q, r)` on `(surface, owner)` —
     * the view's drag-drop path. One-way: on success the new position arrives via
     * the render stream; on rejection the data is unchanged, so the card simply
     * tweens back to its origin (no ack, no prediction).
     */
    place_loose(card_id: number, surface: number, owner: number, q: number, r: number): void;
    /**
     * Drop a card onto `parent_id`'s stack in `direction` (drop-on-a-card).
     */
    place_stack(card_id: number, parent_id: number, direction: number): void;
    /**
     * The assigned player id, or `-1` before login resolves.
     */
    player_id(): number;
    /**
     * Our player_soul card_id (the on-surface-0 card the player owns directly,
     * whose inventory IS the player's), or `-1` until the discovery walk folds
     * it in (`player_id → player_soul`, a pump or two after login). The view
     * opens this card's inventory as the player's own.
     */
    player_soul_id(): number;
    /**
     * One drive step: tick the clock, fold inbound frames, flush outbound.
     * Returns true if any card/zone row changed (the worker re-emits then).
     */
    pump(): boolean;
    /**
     * The renderables in a region of `surface` centred on hex `(center_q,
     * center_r)`, as a JSON `Renderable[]` (the view's render-feed shape):
     * the zone tile grid first (under everything), then cards. Loose cards sit
     * at their cell; stacked members resolve to their root's cell (the DSL fans
     * the stack). All within the region's half-extents on the named surface.
     */
    render_region(surface: number, owner: number, center_q: number, center_r: number, half_cols: number, half_rows: number): string;
    /**
     * Send a chat message to the world feed. Sender id/name come from the session;
     * the shard trims/validates `body`. Fire-and-forget — it echoes back through
     * our own subscription like any other message.
     */
    send_chat(body: string): void;
    /**
     * Aim a viewport anchor at hex `(q, r)` on `(surface, owner)`, subscribing the
     * surrounding zones. `radius_tiles` is the VISIBLE half-extent in TILES (the
     * `AnchorRadii` tiers are tile distances, not zone counts) — the `active`
     * tier covers exactly what's on screen so its zones stream. The `cold` tier
     * extends one [`PREFETCH_TILES`] ring further so the next zones' tiles
     * materialize BEFORE they scroll into view — without it a pan reveals a
     * blank row/col while the just-entered zone is still being requested.
     * `owner` is `0` for the world, or the soul card_id for an inventory
     * surface. Each `(surface, owner)` is a distinct named anchor so multiple
     * viewports don't clobber each other. Re-call on pan.
     */
    set_anchor(surface: number, owner: number, q: number, r: number, radius_tiles: number): void;
    /**
     * Per-table subscription tally as a JSON array (the debug HUD's "subs"
     * tab): `[{ table, subs, tx, rx }]`, sorted by table name. `subs` is the
     * currently-open count; `tx`/`rx` are serialized-frame byte ESTIMATES (tx =
     * `Sub`/`Unsub` frames, rx = the `Row`/`Applied` frames they stream back).
     * Cheap — drained each pump.
     */
    sub_stats(): string;
    /**
     * Subscribe to the world chat feed. Idempotent — call once login resolved (so
     * our sender id/name are known); inbound messages then accumulate for
     * [`take_chat`](Self::take_chat). Safe to re-call.
     */
    subscribe_chat(): void;
    /**
     * Drain chat messages folded since the last call, as a JSON array of
     * `{ sentAt: string, senderPlayerId: number, senderName: string, body: string }`
     * (sorted by `sentAt`; `sentAt` is a string because the packed u64 exceeds
     * JS's safe-integer range). Empty `[]` when nothing arrived. The worker calls
     * this each pump and posts non-empty batches to the chat UI.
     */
    take_chat(): string;
    /**
     * The new content version if the gate hot-swapped its corpus since the last
     * call, else `undefined`. Drains the flag — the worker calls this each pump
     * and, on `Some`, re-fetches `/content`, reloads the matching bundle, and
     * tells the main thread to refresh its render-side `Content`/`Locales`.
     */
    take_content_changed(): string | undefined;
    /**
     * Upload an edited master texture channel to the gate (art editor "save
     * master"). `data_b64` is the standard-base64 PNG; the gate writes it to the
     * texture R2 bucket at `textures/master/<aspect>/<faction>/<variant>.<channel>.png`.
     * Fire-and-forget — gated server-side on the content-author capability;
     * success/failure is logged gate-side.
     */
    upload_master(aspect: string, faction: string, variant: string, channel: string, data_b64: string): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmclient_free: (a: number, b: number) => void;
    readonly wasmclient_add_content: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmclient_call_stats: (a: number) => [number, number];
    readonly wasmclient_clock_stats: (a: number) => [number, number];
    readonly wasmclient_connect: (a: number, b: number, c: number) => [number, number];
    readonly wasmclient_give: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly wasmclient_is_open: (a: number) => number;
    readonly wasmclient_load_content: (a: number, b: number, c: number) => [number, number];
    readonly wasmclient_login: (a: number, b: number, c: number) => void;
    readonly wasmclient_modify_content: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmclient_modify_locale: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmclient_modify_visuals: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmclient_new: () => number;
    readonly wasmclient_place_loose: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasmclient_place_stack: (a: number, b: number, c: number, d: number) => void;
    readonly wasmclient_player_id: (a: number) => number;
    readonly wasmclient_player_soul_id: (a: number) => number;
    readonly wasmclient_pump: (a: number) => number;
    readonly wasmclient_render_region: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly wasmclient_send_chat: (a: number, b: number, c: number) => void;
    readonly wasmclient_set_anchor: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasmclient_sub_stats: (a: number) => [number, number];
    readonly wasmclient_subscribe_chat: (a: number) => void;
    readonly wasmclient_take_chat: (a: number) => [number, number];
    readonly wasmclient_take_content_changed: (a: number) => [number, number];
    readonly wasmclient_upload_master: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hd1bd04d83691b28f: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hfd934f8036d3fba0: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
