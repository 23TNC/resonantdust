/* @ts-self-types="./resonantdust_client.d.ts" */

export class WasmClient {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmClientFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmclient_free(ptr, 0);
    }
    /**
     * Author a brand-new `.rd` source named `name` with `text` (a card that
     * shipped no source for this facet). Same authority validate + hot-swap +
     * persist + `content_changed` as `modify_content`.
     * @param {string} name
     * @param {string} text
     */
    add_content(name, text) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.wasmclient_add_content(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * The clock-discipline + RTT diagnostics as a JSON object (the view's
     * `SyncStats` shape, camelCase) for the debug HUD's "sync" tab. The view
     * adds the `Date.now()`-relative fields itself. Cheap — call each pump.
     * @returns {string}
     */
    clock_stats() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmclient_clock_stats(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Open the gate WebSocket and wire the inbound queue + open flag. Returns once
     * the socket is *created*; poll [`is_open`](Self::is_open) for the handshake.
     * @param {string} ws_url
     */
    connect(ws_url) {
        const ptr0 = passStringToWasm0(ws_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmclient_connect(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
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
     * @param {number} owner
     * @param {string} card_key
     * @param {number} zone_owner
     * @param {number} surface
     * @param {number} world_q
     * @param {number} world_r
     */
    give(owner, card_key, zone_owner, surface, world_q, world_r) {
        const ptr0 = passStringToWasm0(card_key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmclient_give(this.__wbg_ptr, owner, ptr0, len0, zone_owner, surface, world_q, world_r);
    }
    /**
     * True once the WebSocket handshake completed.
     * @returns {boolean}
     */
    is_open() {
        const ret = wasm.wasmclient_is_open(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Load the DSL content the JS side fetched from the gate's `/content`.
     * `rd_json` is the `[[name, src], …]` array (the payload's `rd` field).
     * @param {string} rd_json
     */
    load_content(rd_json) {
        const ptr0 = passStringToWasm0(rd_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmclient_load_content(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Trust-on-first-use login. `player_id` lands later via `pump`.
     * @param {string} name
     */
    login(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmclient_login(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Author a NEW version of an existing `.rd` source (art editor "save DSL").
     * `lineage` is the source name the gate tracks; `text` is the full file. The
     * authority validates + hot-swaps + persists to R2, then broadcasts
     * `content_changed`. Fire-and-forget — gated on the content-author capability.
     * @param {string} lineage
     * @param {string} text
     */
    modify_content(lineage, text) {
        const ptr0 = passStringToWasm0(lineage, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.wasmclient_modify_content(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * Replace locale `domain`'s JSON (art editor "save locale"). The authority
     * validates + hot-swaps + persists + broadcasts `content_changed`. Fire-and-
     * forget — gated on the content-author capability.
     * @param {string} domain
     * @param {string} json
     */
    modify_locale(domain, json) {
        const ptr0 = passStringToWasm0(domain, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.wasmclient_modify_locale(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * Replace visuals source `name` (`visuals/…`) with `text` (art editor "save
     * visuals"). The authority validates + hot-swaps + persists + broadcasts
     * `content_changed`. Fire-and-forget — gated on the content-author capability.
     * @param {string} name
     * @param {string} text
     */
    modify_visuals(name, text) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.wasmclient_modify_visuals(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    constructor() {
        const ret = wasm.wasmclient_new();
        this.__wbg_ptr = ret;
        WasmClientFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Drop a card loose at a GLOBAL world cell `(q, r)` on `(surface, owner)` —
     * the view's drag-drop path. One-way: on success the new position arrives via
     * the render stream; on rejection the data is unchanged, so the card simply
     * tweens back to its origin (no ack, no prediction).
     * @param {number} card_id
     * @param {number} surface
     * @param {number} owner
     * @param {number} q
     * @param {number} r
     */
    place_loose(card_id, surface, owner, q, r) {
        wasm.wasmclient_place_loose(this.__wbg_ptr, card_id, surface, owner, q, r);
    }
    /**
     * Drop a card onto `parent_id`'s stack in `direction` (drop-on-a-card).
     * @param {number} card_id
     * @param {number} parent_id
     * @param {number} direction
     */
    place_stack(card_id, parent_id, direction) {
        wasm.wasmclient_place_stack(this.__wbg_ptr, card_id, parent_id, direction);
    }
    /**
     * The assigned player id, or `-1` before login resolves.
     * @returns {number}
     */
    player_id() {
        const ret = wasm.wasmclient_player_id(this.__wbg_ptr);
        return ret;
    }
    /**
     * Our player_soul card_id (the on-surface-0 card the player owns directly,
     * whose inventory IS the player's), or `-1` until the discovery walk folds
     * it in (`player_id → player_soul`, a pump or two after login). The view
     * opens this card's inventory as the player's own.
     * @returns {number}
     */
    player_soul_id() {
        const ret = wasm.wasmclient_player_soul_id(this.__wbg_ptr);
        return ret;
    }
    /**
     * One drive step: tick the clock, fold inbound frames, flush outbound.
     * Returns true if any card/zone row changed (the worker re-emits then).
     * @returns {boolean}
     */
    pump() {
        const ret = wasm.wasmclient_pump(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * The renderables in a region of `surface` centred on hex `(center_q,
     * center_r)`, as a JSON `Renderable[]` (the view's render-feed shape):
     * the zone tile grid first (under everything), then cards. Loose cards sit
     * at their cell; stacked members resolve to their root's cell (the DSL fans
     * the stack). All within the region's half-extents on the named surface.
     * @param {number} surface
     * @param {number} owner
     * @param {number} center_q
     * @param {number} center_r
     * @param {number} half_cols
     * @param {number} half_rows
     * @returns {string}
     */
    render_region(surface, owner, center_q, center_r, half_cols, half_rows) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmclient_render_region(this.__wbg_ptr, surface, owner, center_q, center_r, half_cols, half_rows);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Send a chat message to the world feed. Sender id/name come from the session;
     * the shard trims/validates `body`. Fire-and-forget — it echoes back through
     * our own subscription like any other message.
     * @param {string} body
     */
    send_chat(body) {
        const ptr0 = passStringToWasm0(body, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmclient_send_chat(this.__wbg_ptr, ptr0, len0);
    }
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
     * @param {number} surface
     * @param {number} owner
     * @param {number} q
     * @param {number} r
     * @param {number} radius_tiles
     */
    set_anchor(surface, owner, q, r, radius_tiles) {
        wasm.wasmclient_set_anchor(this.__wbg_ptr, surface, owner, q, r, radius_tiles);
    }
    /**
     * Subscribe to the world chat feed. Idempotent — call once login resolved (so
     * our sender id/name are known); inbound messages then accumulate for
     * [`take_chat`](Self::take_chat). Safe to re-call.
     */
    subscribe_chat() {
        wasm.wasmclient_subscribe_chat(this.__wbg_ptr);
    }
    /**
     * Drain chat messages folded since the last call, as a JSON array of
     * `{ sentAt: string, senderPlayerId: number, senderName: string, body: string }`
     * (sorted by `sentAt`; `sentAt` is a string because the packed u64 exceeds
     * JS's safe-integer range). Empty `[]` when nothing arrived. The worker calls
     * this each pump and posts non-empty batches to the chat UI.
     * @returns {string}
     */
    take_chat() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.wasmclient_take_chat(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The new content version if the gate hot-swapped its corpus since the last
     * call, else `undefined`. Drains the flag — the worker calls this each pump
     * and, on `Some`, re-fetches `/content`, reloads the matching bundle, and
     * tells the main thread to refresh its render-side `Content`/`Locales`.
     * @returns {string | undefined}
     */
    take_content_changed() {
        const ret = wasm.wasmclient_take_content_changed(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Upload an edited master texture channel to the gate (art editor "save
     * master"). `data_b64` is the standard-base64 PNG; the gate writes it to the
     * texture R2 bucket at `textures/master/<aspect>/<faction>/<variant>.<channel>.png`.
     * Fire-and-forget — gated server-side on the content-author capability;
     * success/failure is logged gate-side.
     * @param {string} aspect
     * @param {string} faction
     * @param {string} variant
     * @param {string} channel
     * @param {string} data_b64
     */
    upload_master(aspect, faction, variant, channel, data_b64) {
        const ptr0 = passStringToWasm0(aspect, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(faction, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(variant, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(channel, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(data_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        wasm.wasmclient_upload_master(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
    }
}
if (Symbol.dispose) WasmClient.prototype[Symbol.dispose] = WasmClient.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_string_get_fa2687d531ed17a5: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_bbadd78c1bac3a77: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_c2301a3c9b78104b: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_data_8a04443c1e5a8cd3: function(arg0) {
            const ret = arg0.data;
            return ret;
        },
        __wbg_new_a3e5112401a82338: function() { return handleError(function (arg0, arg1) {
            const ret = new WebSocket(getStringFromWasm0(arg0, arg1));
            return ret;
        }, arguments); },
        __wbg_now_bce4dc999095ea77: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_send_bac9d3dc4f21ef28: function() { return handleError(function (arg0, arg1, arg2) {
            arg0.send(getStringFromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_set_onmessage_96337495f0bfb796: function(arg0, arg1) {
            arg0.onmessage = arg1;
        },
        __wbg_set_onopen_3e2bf6b11d434c2d: function(arg0, arg1) {
            arg0.onopen = arg1;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("MessageEvent")], shim_idx: 43, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hd1bd04d83691b28f);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 45, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hfd934f8036d3fba0);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./resonantdust_client_bg.js": import0,
    };
}

function wasm_bindgen__convert__closures_____invoke__hfd934f8036d3fba0(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__hfd934f8036d3fba0(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__hd1bd04d83691b28f(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__hd1bd04d83691b28f(arg0, arg1, arg2);
}

const WasmClientFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmclient_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('resonantdust_client_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
