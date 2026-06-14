# Binary wire protocol (JSON → postcard)

Status: **design / scoped, not started.** This is foundational — the client↔gate
contract — so it's written down before any code moves.

## Why

The client↔gate wire is JSON-over-WebSocket (`serde_json::to_string`), and JSON is
self-describing: every frame re-ships the field-name keys, the variant tag string
(`"t":"call"`), the reducer name (`"request_zone"`), and — worst — **every `u64`
stringified to ~20-char decimal text** (`gateway/src/ws.rs` `normalize`, the
`Value::Number(n) => Value::String(...)` line), because JS can't hold a `u64`.

Measured cost:

| frame | JSON now | postcard | win |
|---|---|---|---|
| `request_zone` call (tx) | ~110 B | ~22 B | ~5× |
| **zone `Row` (rx)** | **~450 B** | **~110–130 B** | **~3.7×** |

The **rx / `Row`** direction is the heaviest: it's gate→client, i.e. the
**server-upload ~10 Mb/s binding constraint** (`[[project_bandwidth_budget]]`).
A zone row carries 13 `u64` tile words; JSON stringifies all of them and adds
camelCased keys. So **the `Row` direction goes first by impact** — but tx is not
free either: it's the client's upload, cheaper but still real, and it's fixed in
the same pass (typed `ClientCall`).

There is a **second, separate waste** the rewrite also closes: the gate doesn't
even use the generated SDK bindings to *call* reducers — it bypasses them with raw
JSON-over-HTTP (see Part 2). Both wastes share one root cause: reducer args are a
dynamic `serde_json::Value`. Type the args and both fall out.

## Two parts, two hops

```
  view (TS/PIXI) ─structured clones─ wasm client core (Rust)
                                            │
                                    PART 1: postcard over WS binary   (ClientMsg / GateMsg)
                                            │
                                          gate (Rust)
                                            │
                                    PART 2: generated SDK bindings, BSATN   (was reqwest JSON/HTTP)
                                            │
                                      SpacetimeDB
```

- **Part 1 — client↔gate wire → postcard.** `ClientMsg`/`GateMsg` over the
  WebSocket. The hop we fully control; `Row` (rx) is the heaviest, fixed first.
- **Part 2 — gate↔SpacetimeDB call → SDK bindings (BSATN), drop HTTP/JSON.** The
  gate currently calls reducers via raw `reqwest .json(&args)` POSTs to
  `/v1/database/{db}/call/{reducer}` (`ws.rs:1111,1142`, `apply.rs:374`,
  `login_relay ws.rs:677`), using the bindings only for subscriptions. This is a
  second JSON tax (and a second u64-stringify, since HTTP `/call` JSON has the same
  problem). The generated `reducers.X_then(typed_args, cb)` is already available on
  the live pooled connection (`run_threaded`) — we just weren't using it. Part 2
  routes calls through it: BSATN binary, typed args, no `serde_json::Value`.
- **The view does not change, either part.** It is fully off the wire:
  `view/src/client/` talks to the wasm core via worker structured-clones
  (`WasmClient.ts`, `clientWorker.ts`); all serde lives in Rust. Zero TS edits.
  This is the property that makes the whole thing cheap — guard it.

## Encoding decisions

1. **postcard, not hand-rolled `#[repr(C)]` casting.** Reuse the existing
   `#[derive(Serialize, Deserialize)]`. postcard encodes enum variants as a
   varint discriminant and fields positionally with varints — no field names, no
   tag string, native integers. This is the proposed "u8 t / u8 reducer / payload"
   frame, achieved declaratively, with **zero `unsafe`** and none of the
   alignment / padding / enum-validity / endianness UB that a transmute carries.
   (`zerocopy`/`bytemuck` for true memcpy stays available later for specific hot
   POD rows if profiling demands it — not in the first cut.)

2. **Drop `#[serde(tag = "t", rename_all = "snake_case")]`** on `ClientMsg` /
   `GateMsg`. The internal string tag is pure JSON waste under postcard (it would
   serialize the tag as a string field); postcard's native enum encoding is a
   1-byte varint. We are abandoning JSON on this hop, so remove the attribute.

3. **No `len` prefix, no FEC.** WebSocket frames are already length-delimited
   (`onmessage` hands a complete buffer) and ride TCP (reliable, ordered,
   checksummed). A `u16 len` is redundant; Reed-Solomon/CRC solves a problem this
   transport doesn't have.

4. **Numbers ride native.** Drop the `String`-wrapped `server_micros`,
   `ZoneObservers.macro_zone`, and the row-level `de_str_num` + camelCase. The
   client core is Rust — `u64` round-trips natively. (The wasm→view boundary keeps
   its own JSON representation for big ints; that's a separate hop, untouched.)

5. **Schema version guard — required, not optional, and free.** postcard is
   positional and non-self-describing: a client/gate layout mismatch *silently
   misparses*. The guard reuses the **`shared` component hash we already
   compute** (`bin/versions` → baked into both the gate's `VERSIONS_JSON` and the
   client's `__BUILD_VERSIONS__`). The handshake (the `claim_or_login` reply is the
   natural carrier) sends the gate's `shared` hash; the client compares to its own
   and **hard-rejects** on mismatch — a harder stop than the panel's existing soft
   drift display. Zero new hashing. It over-rejects slightly (any `shared/` edit,
   not just `shared/protocol`), which is the safe direction; narrow to a
   `protocol`-only component hash later only if the over-rejection bites. This is
   the "error correction" the plan intuited, correctly reframed as skew detection.

## Message-by-message design

### `ClientMsg::Call` — typed, gate keeps its `Value` internals

Today: `Call { cid, reducer: String, args: serde_json::Value }`; the client
injects `client_time_ms` into `args` (`client/core/src/client.rs:585`); the gate
injects per-reducer fields and POSTs `json(&args)`.

Proposed:

```rust
enum ClientMsg {
    Sub  { sid: u32, sub: SubKind },
    Unsub { sid: u32 },
    Call { cid: u32, client_time_ms: u64, call: ClientCall },
}

// one variant per *client-callable* reducer; the variant IS the reducer name,
// so the `reducer: String` field disappears.
enum ClientCall {
    RequestZone     { macro_zone: u64 },
    EnsureRegion    { macro_zone: u64 },
    CreateCard      { owner_id: u32, surface: u8, macro_zone: u64, q: u8, r: u8 },
    PlaceCard       { card_id: u32, placement: Placement },
    MoveCards       { card_ids: Vec<u32>, macro_zones: Vec<u64>, micro_locations: Vec<u32>, stack_states: Vec<u8> },
    MoveSoul        { soul_id: u32, soul_def: u16, from_q: i32, from_r: i32, dest: TilePoint, depart_ms: u64 },
    RequestBlueprint{ soul_card_id: u32, blueprint_id: u16, surface: u8, macro_zone: u64, micro_location: u32 },
    SendChat        { body: String },
    CreatePlayer    { name: String },
    ClaimOrLogin    { name: String },
    ProposeAction   { recipe_id: u16, surface: u8, macro_zone: u64, micro_location: u32, root: u32, bindings: Vec<Vec<u32>> },
    // NOTE: only client fields. Gate-injected fields are NOT on the wire.
}
```

**Part 1 keeps the gate's `Value` internals (low blast radius).** For the wire
migration alone, the gate's per-reducer injection, worldgen-promise, and routing
keep operating on `serde_json::Value`; only the *source* of that Value changes:

```rust
// was: args comes straight off the wire as Value
let (reducer, mut args) = call.to_args();       // hand-written match: variant → (&str, json)
args["client_time_ms"] = json!(client_time_ms);
// … existing injection + worldgen_promise + POST unchanged …
```

`ClientCall::to_args()` is the explicit adapter that also carries the
variant→reducer-name mapping. **Part 2 then deletes the `Value` + HTTP tail** and
calls the typed SDK reducer directly with the injected fields (see below); the
injection logic is the only thing that survives, rewritten from `obj.insert(...)`
to typed locals.

**Gate-injected fields stay server-only** (confirmed list — these must NOT be on
the wire; the gate computes them):

| reducer | client sends | gate injects |
|---|---|---|
| `request_zone` | `macro_zone` | `tiles: Vec<u64>` (worldgen) |
| `ensure_region` | `macro_zone` | `distance: u16` (owner inventory aspect) |
| `create_card` | `card_key`→ name, `owner_id`, `surface`, `q`, `r` | `packed_definition`, `stock`, `distance` |
| `move_soul` | from/dest/`depart_ms`/`soul_def` | `arrival_ms` (re-derived; client value overridden) |
| `request_blueprint` | `blueprint_id`, … | `max_active`, `blueprint_packed_def` |
| `place_card`/`move_cards` | ids/placement | `caller_player_id` (session) |
| `set_last_login` | — | `player_id` (session) |

`propose_action` and `claim_or_login` are **intercepted** gate-side (`ws.rs:373,
376`), never relayed — `propose_action` generates `apply_action`/
`apply_action_tile`, which are gate-built and never ride the client wire at all.

### `ClientMsg::Sub` — typed kind, gate rebuilds the SQL

Today: `Sub { sid, table: String, filter: Option<String> }`, where `filter` is a
raw SQL `WHERE` body the gate uses to build (and dedup, by `"<table>\x1f<sql>"`)
the upstream SDK subscription.

Proposed `SubKind` enum (`Cards { zone }`, `Zones { zone }`, `Regions { region }`,
`Chat`, …); the gate maps the variant back to `(table, sql)` — same pattern as
`Call`. This drops the `"macro_zone = "` SQL boilerplate and the table string
from every sub frame.

*Decision to make:* type `Sub` now, or ship Call/Row binary first and leave `Sub`
as `{ table, filter }` for a follow-up. Sub frames are smaller and tx-side
(non-binding); typing them is lower value than Call/Row. **Recommend: Call + Row
first, Sub typing as a fast-follow.**

### `GateMsg` + rows — the priority direction

Today: rows arrive at the gate as typed SDK binding structs
(`bindings::shard::zone_type::Zone`, …), get down-converted by `row_json` →
`normalize` (camelCase keys + stringify every number) → `Row { row: Value }` →
JSON. Client deserializes `Value` → `rows.rs::ZoneRow` via `de_str_num`.

Proposed:

```rust
enum GateMsg {
    Applied { sid: u32 },
    Row { sid: u32, op: RowOp, row: RowData },          // table is RowData's discriminant
    CallOk      { cid: u32, server_micros: u64 },        // was String
    CallErr     { cid: u32, error: String, server_micros: u64 },
    CallPromise { cid: u32, timeout_ms: u64, server_micros: u64 },
    Error { error: String },
    Time  { server_micros: u64 },
    ContentChanged { version: u64 },                     // was hex String
    ZoneObservers  { macro_zone: u64, observers: u32 },  // was String
}

enum RowData { Card(CardRow), Zone(ZoneRow), Region(RegionRow), Chat(ChatRow), Player(PlayerRow) }
```

**Row-struct ownership — the one real coupling risk.** postcard is positional, so
the gate's serialized struct and the client's deserialized struct must agree on
field order/type byte-for-byte. The SDK binding structs are *codegen* — a schema
change can reorder them silently. So:

- Define the canonical row structs **once in `shared/`** (e.g. `shared/protocol`
  or `shared/state`), with explicit field order. Both gate and client link it.
- The gate converts the SDK binding row → the shared row (a field copy in the
  subscription callback) and `postcard::to_stdvec`s the shared struct. This costs
  one struct copy per row but **decouples the wire from SDK codegen** — worth it.
- This deletes `row_json` + `normalize` (gate) and `de_str_num` + the camelCase
  renames (client). Native `u64` throughout.

The `old: Option<Value>` field on `Row` (update before-image) is rarely used —
keep it symmetric as `Option<RowData>` or drop if unused (verify first).

## Transport / framing changes

- **`Transport` trait → bytes.** `client/core/src/transport.rs:14` carries
  `String` frames; change `send(&mut self, frame: Vec<u8>)` /
  `recv() -> Option<Vec<u8>>`. Updates the native `WsTransport` impl
  (`Message::Text` → `Message::Binary`) and `GateConnection::send`/`next`
  (`gate.rs:30,45`) which currently `serde_json::to_string` / `from_str`.
- **wasm WS → binary.** After `WebSocket::new()`, set
  `ws.set_binary_type(BinaryType::Arraybuffer)`; send via `send_with_u8_array`
  (was `send_with_str`, `lib.rs:695`); in `onmessage`, read the `ArrayBuffer` into
  `Vec<u8>` (was `e.data().as_string()`, `lib.rs:255`). `BinaryType` is already in
  the `web-sys` feature set.
- **gate WS → binary.** `Message::Text` → `Message::Binary` on send
  (`ws.rs:160,169`) and add the `Message::Binary` arm on recv (`ws.rs:224`,
  currently text-only; `postcard::from_bytes::<ClientMsg>`).

## Stats

`SubStats`/`CallStats` `note_send`/`note_inbound` already take a byte count — pass
`bytes.len()` instead of `string.len()` (`lib.rs:689,519,520`). The debug-HUD
`to_json()` output stays JSON (it's a wasm→view summary, not the wire). The `tx`/
`rx` numbers will drop ~3–5×; the panel's "estimate" wording stays honest.
`CallStats` keys by reducer name — derive the label from the `ClientCall` variant.

## Part 2 — fix the SpacetimeDB call (SDK bindings, BSATN)

Today the gate uses the generated bindings **only for subscriptions**. Every
reducer **call** bypasses them: a raw `reqwest` POST of JSON args to
`/v1/database/{db}/call/{reducer}` (`ws.rs:1111,1125,1142`; `apply.rs:374`;
`login_relay ws.rs:677`). No comment defends it — it's expediency: a dynamic
`serde_json::Value` POSTs trivially and HTTP returns a **synchronous** status that
maps straight to `CallOk`/`CallErr`. The cost is a second JSON tax (with the same
u64-stringify bloat) on the gate↔DB hop, and the generated typed bindings sitting
unused.

The bindings already provide the path, on the connection the gate already runs:

```rust
// generated per reducer; the live pooled DbConnection is pumped by run_threaded()
conn.reducers.create_card_then(
    client_time_ms, owner_id, surface, packed_definition, stock, macro_zone, q, r, distance,
    move |ctx, res| { let _ = tx.send(reply_for(cid, res)); },   // res: Result<Result<(),String>, _>
);
```

This is BSATN (binary) over the existing WS connection, typed args, no
`serde_json::Value`, no `reqwest`. Composes with Part 1: typed wire `ClientCall` →
inject gate fields as typed locals → typed SDK call.

**What changes / what to handle with care:**

- **Reply model: sync status → async `_then` callback.** HTTP gave a blocking
  status; `create_card_then`'s callback fires later on the `run_threaded` loop. The
  closure captures `cid` + the client's `tx`, and sends `CallOk`/`CallErr` when it
  fires. Correlation is per-call (the `FnOnce` is bound to that request), so no
  manual cid↔event matching. This restructures `relay_call`/`apply.rs` from
  request/await into register-callback.
- **Injection moves from `Value` to typed locals.** The per-reducer field
  injection (tiles/distance/packed/stock/arrival_ms/player_id) stops being
  `obj.insert("k", json!(v))` and becomes ordinary typed values passed positionally
  to `X_then`. The logic is identical; the medium changes.
- **`apply_action` / `apply_action_tile`** (gate-generated, `apply.rs`) move the
  same way. `apply_action` has ~25 args (lots of `Vec`s) — the positional `_then`
  call is verbose but mechanical; `Reducer::ApplyAction { .. }.into()` is the
  alternative if the bulk-call API is cleaner.
- **Worldgen promise model is unaffected.** `request_zone`/`ensure_region` still
  resolve on the subscription bit-flip, not the call reply; the `_then` success
  just triggers `promises.accept` where the successful POST does today.
- **Identity.** HTTP `/call` was anonymous; SDK calls carry the gate's connection
  identity, so `ctx.sender` becomes the gate. Reducers don't check `sender` (the
  gate owns auth — see the `apply.rs:365` note), so this is inert, but confirm no
  reducer started trusting `ctx.sender`.
- **`claim_or_login`** stays a relay-then-read-player-row, but the call half moves
  to the SDK like the rest; the subsequent player-row read is already on the
  subscription side.
- **Drop `reqwest`/`http_client()`** for reducer calls once all paths are moved
  (it's still used for content/R2 — keep it there). `server_uri`'s `/call` use goes
  away.

End state: JSON survives only where it genuinely must — the content/R2 HTTP and
the wasm→view debug summaries. Neither game hop carries it.

## Dependencies

- Add `postcard = { version = "1", features = ["alloc"] }` to `shared/protocol`,
  `gateway`, `client/core`, `client/wasm`.
- **No SpacetimeDB module is affected** — none of `modules/{shard,players,chat}`
  link `shared/protocol`, so no `no_std`/feature-gate fallout. (`shared/protocol`
  is consumed only by gate + client.)
- `serde_json` **stays** in the gate (builds the JSON args for the SpacetimeDB
  HTTP POST + parses HTTP error bodies) and in client/wasm+core (the debug-stats
  and render-region JSON the wasm emits to the view).

## Risks / things to handle with care

1. **Positional fragility (the big one).** A field reorder or type change on
   either side, without a `PROTOCOL_VERSION` bump + handshake reject, = silent
   corruption with no key-name to catch it. The version guard (decision #5) is
   mandatory, and the row structs living in `shared/` (single definition) is what
   keeps gate and client in lockstep. Do not serialize SDK-codegen structs
   directly.
2. **Debuggability.** No more eyeballing JSON frames in the network tab — and no
   JSON escape hatch (that's the lazy-CS reflex; we don't burn ~4× the bytes so a
   human can read with their eyes). If frame-level visibility is ever needed: the
   debug panel already links the shared enums via wasm and can render the decoded
   `ClientMsg`/`GateMsg` from the real binary; wireshark handles the raw wire.
3. **Data is disposable pre-release** (`[[project_data_drop_policy]]`) — no
   migration/back-comat needed for stored data; this is purely the live wire, so a
   flag-day cutover (gate + client rebuilt together, version-gated) is fine.
4. **Don't strip the load-bearing optimizations** while in here
   (`[[feedback_dont_strip_optimizations]]`): the client matcher, bit-packing,
   incremental promote, zone tier cache are orthogonal — this changes encoding,
   not those.

## Phased plan

**Part 1 — client↔gate wire:**

1. **P0 — shared row structs + version handshake.** Lift canonical Card/Zone/
   Region/Chat/Player row structs into `shared/`, native types, explicit order.
   Wire the `shared`-hash handshake reject (reusing the baked `VERSIONS_JSON` /
   `__BUILD_VERSIONS__` value — no new hashing). No wire change yet (still JSON) —
   land + verify the structs round-trip and the handshake gates.
2. **P1 — `GateMsg`/`Row` → postcard (rx, first by impact).** Gate serializes
   `RowData` via postcard; client deserializes. Switch the GateMsg WS path to
   binary. Delete `row_json`/`normalize`/`de_str_num`. Measure rx drop on the zone
   sub.
3. **P2 — `ClientMsg::Call` typed + postcard (tx).** `ClientCall` enum +
   `to_args()` adapter; gate still on Value internals here. Measure call tx drop.
4. **P3 — `Sub` typed (`SubKind`).** Fast-follow; smaller frames, tx-side.

**Part 2 — gate↔SpacetimeDB call:**

5. **P4 — reducer calls via SDK bindings (BSATN).** Replace the `reqwest` `/call`
   POSTs (`relay_call`, `apply.rs`, `login_relay`) with `reducers.X_then(typed, cb)`
   on the pooled connection. Restructure the reply path (sync status → async
   callback). Injection moves from `Value` to typed locals — this retires the
   `to_args()` Value adapter from P2 for relayed reducers.
6. **P5 — cleanup.** Drop `reqwest`/`server_uri` `/call` usage; prune dead
   `serde_json` paths; confirm the view needed zero edits.

Each phase is a flag-day for that message type / hop (gate + client rebuilt
together, version-gated). The native NPC harness (`client/core`) is the cheapest
end-to-end check at each step before the browser. P4 depends on P2 (typed args);
P1 (rx) is independent and can land first regardless.

## Touchpoint inventory

| concern | file:line | change |
|---|---|---|
| `ClientMsg`/`GateMsg`/`RowOp` defs | `shared/protocol/src/protocol.rs:23,59` | drop tag attr; type Call/Sub/Row; native ints |
| `GateMsg::to_json` + reply builders | `shared/protocol/src/protocol.rs:130,144,153,164,175` | → postcard bytes |
| client row structs + `de_str_num` | `client/core/src/rows.rs:20,37,84,114` | move to `shared/`; drop coercion + camelCase |
| client tx serialize + stats | `client/wasm/src/lib.rs:686,689,695` | postcard + `send_with_u8_array` |
| client rx deserialize + stats | `client/wasm/src/lib.rs:255,515,519,520` | `ArrayBuffer` + `postcard::from_bytes` |
| wasm WS init | `client/wasm/src/lib.rs:~210` | `set_binary_type(Arraybuffer)` |
| native transport | `client/core/src/transport.rs:14,47,54` | `Vec<u8>` frames; `Message::Binary` |
| GateConnection | `client/core/src/gate.rs:30,45` | postcard |
| client Call construction | `client/core/src/client.rs:585,613+` | build `ClientCall`; hoist `client_time_ms` |
| gate rx deserialize | `gateway/src/ws.rs:224` | `Message::Binary` arm + `postcard::from_bytes` |
| gate tx send | `gateway/src/ws.rs:160,169` | `Message::Binary` |
| gate row down-convert | `gateway/src/ws.rs:406,414,450` | SDK row → shared row → postcard; delete `normalize` |
| gate relay_call args source (P2-wire) | `gateway/src/ws.rs:~932,1111,1142` | `ClientCall::to_args()`; injections unchanged for P1/P2-wire |
| relay routing / interception | `gateway/src/ws.rs:373,376,1098` | unchanged (variant→reducer-name in adapter) |
| **Part 2** — reducer call via SDK | `gateway/src/ws.rs:1111,1125,1142` | `reqwest .json` POST → `reducers.X_then(typed, cb)`; sync→async reply |
| **Part 2** — apply_action(_tile) call | `gateway/src/apply.rs:125,161,331,374` | same: HTTP `/call` → SDK typed call; ~25-arg `apply_action` |
| **Part 2** — login_relay call | `gateway/src/ws.rs:677,681` | `claim_or_login` POST → SDK call; player-row read already on sub side |
| **Part 2** — http_client / server_uri | `gateway/src/connections.rs:23,442` | drop `/call` usage (keep reqwest for content/R2) |

## Open decisions

- **`Row.old` before-image** — still consumed anywhere? If not, drop it.
- **Where do the shared row structs live** — `shared/protocol` (with the messages)
  or `shared/state` (with the domain)? Leaning `shared/protocol` since they're a
  wire contract.
- **`apply_action` SDK call shape** — positional `apply_action_then(~25 args, cb)`
  vs. `Reducer::ApplyAction { .. }.into()` bulk-call, whichever the generated API
  makes cleaner.

Settled: postcard (not hand-rolled casting); version guard reuses the `shared`
hash; no JSON escape hatch; both hops go binary (Part 1 postcard, Part 2 BSATN).
