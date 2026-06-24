//! Client ↔ gate wire protocol (JSON over the WS).
//!
//! **Shared, single source of truth.** The gateway *receives* [`ClientMsg`] and
//! *sends* [`GateMsg`]; the client (native NPC driver, and the wasm view-backing
//! build) does the mirror — so both message types derive `Serialize` +
//! `Deserialize` here, and nobody hand-mirrors the contract. Feature-gated
//! (`protocol`) so the SpacetimeDB modules that link this crate for its codec
//! don't pull `serde_json`.
//!
//! The client subscribes to tables (the gate fans out live rows from the shards)
//! and calls reducers; the gate routes a plain relay to the owning shard, while
//! `propose_action` / `claim_or_login` are intercepted and handled gate-side
//! (recipe validation + cross-shard apply, session establishment). A deliberately
//! thin, stable contract — table/reducer names may later give way to
//! intent-shaped messages.
//!
//! Numbers ride the postcard wire as native integers (the client core is Rust);
//! the lone exception is `ContentChanged.version`, a hex String mirroring the
//! `/content` HTTP endpoint's fingerprint — not a JS-safe-integer artifact.

use serde::{Deserialize, Serialize};

use crate::rows::RowData;

/// A message from a client to the gate.
///
/// Encoded with **postcard** (binary) — NOT internally-tagged (postcard is
/// positional + doesn't support `#[serde(tag)]` or `skip_serializing_if`). Field
/// ORDER is the wire contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ClientMsg {
    /// Subscribe to a table, optionally filtered (raw SQL `WHERE` body, e.g.
    /// `owner_id = 1024`; `None` → whole table).
    Sub {
        sid: u32,
        table: String,
        filter: Option<String>,
    },
    /// Drop a subscription.
    Unsub { sid: u32 },
    /// Call a reducer. The [`ClientCall`] variant IS the reducer (no name string
    /// on the wire); `client_time_ms` is the per-send clock the gate folds into
    /// the timed reducers' args.
    Call {
        cid: u32,
        client_time_ms: u64,
        call: ClientCall,
    },
}

impl ClientMsg {
    /// Encode to postcard bytes for the WS binary sink.
    pub fn to_bytes(&self) -> Vec<u8> {
        postcard::to_allocvec(self).unwrap_or_default()
    }
}

/// One client-callable reducer + its CLIENT-supplied args. Gate-injected fields
/// (tiles / distance / packed_definition / player_id / …) are NOT here — the gate
/// adds them. The variant is the reducer; [`to_args`](ClientCall::to_args) rebuilds
/// exactly the JSON the gate's relay/intercept path expects, so that path stays
/// `Value`-based and unchanged (and is the seam P4 swaps for typed SDK calls).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ClientCall {
    ClaimOrLogin { name: String },
    CreateCard { owner_id: u32, surface: u8, card_key: String, macro_zone: u64, q: u8, r: u8 },
    MoveCards { caller_player_id: u32, card_ids: Vec<u32>, macro_zones: Vec<u64>, micro_locations: Vec<u32>, stack_states: Vec<u8> },
    // Generic over any card with a navigation aspect (not just souls); the wire
    // arg names stay `soul_*` so the shard reducer's by-name arg binding is
    // unchanged.
    MoveCard { caller_player_id: u32, soul_id: u32, soul_def: u16, from_q: i32, from_r: i32, dest_surface: u8, dest_macro_zone: u64, dest_micro_location: u32, depart_ms: u64, arrival_ms: u64 },
    ProposeAction { recipe_id: u16, surface: u8, macro_zone: u64, micro_location: u32, root: u32, bindings: Vec<Vec<u32>>, caller_player_id: u32 },
    SendChatMessage { sender_player_id: u32, sender_name: String, body: String },
    RequestZone { macro_zone: u64 },
    EnsureRegion { macro_zone: u64 },
    AddContent { name: String, text: String },
    ModifyContent { lineage: String, text: String },
    ModifyLocale { domain: String, json: String },
    ModifyVisuals { name: String, text: String },
    UploadMaster { aspect: String, faction: String, variant: String, channel: String, data: String },
    Ping,
}

impl ClientCall {
    /// A stable label for the debug-HUD call stats (keyed by reducer), without
    /// building the args.
    pub fn reducer(&self) -> &'static str {
        match self {
            ClientCall::ClaimOrLogin { .. } => "claim_or_login",
            ClientCall::CreateCard { .. } => "create_card",
            ClientCall::MoveCards { .. } => "move_cards",
            ClientCall::MoveCard { .. } => "move_card",
            ClientCall::ProposeAction { .. } => "propose_action",
            ClientCall::SendChatMessage { .. } => "send_chat_message",
            ClientCall::RequestZone { .. } => "request_zone",
            ClientCall::EnsureRegion { .. } => "ensure_region",
            ClientCall::AddContent { .. } => "add_content",
            ClientCall::ModifyContent { .. } => "modify_content",
            ClientCall::ModifyLocale { .. } => "modify_locale",
            ClientCall::ModifyVisuals { .. } => "modify_visuals",
            ClientCall::UploadMaster { .. } => "upload_master",
            ClientCall::Ping => "ping",
        }
    }

    /// The reducer name + the JSON args the gate relays/intercepts — the exact
    /// shape the old `ClientMsg::Call { reducer, args }` carried. `client_time_ms`
    /// is folded into the timed reducers (the rest ignore it). Gate-side only.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn to_args(&self, client_time_ms: u64) -> (&'static str, serde_json::Value) {
        use serde_json::json;
        match self {
            ClientCall::ClaimOrLogin { name } => (
                "claim_or_login",
                json!({ "client_time_ms": client_time_ms, "name": name }),
            ),
            ClientCall::CreateCard { owner_id, surface, card_key, macro_zone, q, r } => (
                "create_card",
                json!({ "client_time_ms": client_time_ms, "owner_id": owner_id, "surface": surface, "card_key": card_key, "macro_zone": macro_zone, "q": q, "r": r }),
            ),
            ClientCall::MoveCards { caller_player_id, card_ids, macro_zones, micro_locations, stack_states } => (
                "move_cards",
                json!({ "client_time_ms": client_time_ms, "caller_player_id": caller_player_id, "card_ids": card_ids, "macro_zones": macro_zones, "micro_locations": micro_locations, "stack_states": stack_states }),
            ),
            ClientCall::MoveCard { caller_player_id, soul_id, soul_def, from_q, from_r, dest_surface, dest_macro_zone, dest_micro_location, depart_ms, arrival_ms } => (
                "move_card",
                json!({ "client_time_ms": client_time_ms, "caller_player_id": caller_player_id, "soul_id": soul_id, "soul_def": soul_def, "from_q": from_q, "from_r": from_r, "dest": { "surface": dest_surface, "macro_zone": dest_macro_zone, "micro_location": dest_micro_location }, "depart_ms": depart_ms, "arrival_ms": arrival_ms }),
            ),
            ClientCall::ProposeAction { recipe_id, surface, macro_zone, micro_location, root, bindings, caller_player_id } => (
                "propose_action",
                json!({ "recipe_id": recipe_id, "surface": surface, "macro_zone": macro_zone, "micro_location": micro_location, "root": root, "bindings": bindings, "caller_player_id": caller_player_id, "client_time_ms": client_time_ms }),
            ),
            ClientCall::SendChatMessage { sender_player_id, sender_name, body } => (
                "send_chat_message",
                json!({ "sender_player_id": sender_player_id, "sender_name": sender_name, "body": body }),
            ),
            ClientCall::RequestZone { macro_zone } => (
                "request_zone",
                json!({ "client_time_ms": client_time_ms, "macro_zone": macro_zone }),
            ),
            ClientCall::EnsureRegion { macro_zone } => (
                "ensure_region",
                json!({ "client_time_ms": client_time_ms, "macro_zone": macro_zone }),
            ),
            ClientCall::AddContent { name, text } => {
                ("add_content", json!({ "name": name, "text": text }))
            }
            ClientCall::ModifyContent { lineage, text } => {
                ("modify_content", json!({ "lineage": lineage, "text": text }))
            }
            ClientCall::ModifyLocale { domain, json: j } => {
                ("modify_locale", json!({ "domain": domain, "json": j }))
            }
            ClientCall::ModifyVisuals { name, text } => {
                ("modify_visuals", json!({ "name": name, "text": text }))
            }
            ClientCall::UploadMaster { aspect, faction, variant, channel, data } => (
                "upload_master",
                json!({ "aspect": aspect, "faction": faction, "variant": variant, "channel": channel, "data": data }),
            ),
            ClientCall::Ping => ("ping", json!({})),
        }
    }
}

/// A row change op on a subscribed table. Serializes to `"insert"` / `"update"`
/// / `"delete"` — the round-trippable form of the gate's former `&'static str`,
/// so the client can deserialize it too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowOp {
    Insert,
    Update,
    Delete,
}

/// A message from the gate to a client.
///
/// Encoded with **postcard** (binary) — NOT internally-tagged: postcard is
/// positional/non-self-describing and doesn't support `#[serde(tag)]`, and the
/// variant index is the discriminant anyway. Field ORDER is the wire contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GateMsg {
    /// The subscription `sid` is applied (initial rows have been delivered).
    Applied { sid: u32 },
    /// A row event on a subscribed table. The table is the [`RowData`] variant —
    /// no `table` string rides the wire. (The `old` before-image was unused by
    /// the client and is dropped.)
    Row { sid: u32, op: RowOp, row: RowData },
    /// Reducer call `cid` succeeded. Carries the gate's wall clock at reply time
    /// (`server_micros`) so the client gets a server-time sample piggybacked on
    /// its own round-trip — the "spacetime way" (the SDK rode the timestamp on
    /// reducer events). Active clients sync their clock from this for free; the
    /// standalone [`Time`](GateMsg::Time) frame then only fills idle gaps.
    CallOk { cid: u32, server_micros: u64 },
    /// Reducer call `cid` failed. Also carries `server_micros` — a rejected call
    /// is still a round-trip, so it's a valid clock sample.
    CallErr {
        cid: u32,
        error: String,
        server_micros: u64,
    },
    /// Reducer call `cid` was ACCEPTED for asynchronous resolution — the
    /// protocol's async primitive. The gate replies this instead of a premature
    /// `CallOk` when a call's true outcome isn't known at call time (it lands
    /// later via a subscription row or a side effect). The gate will send a
    /// follow-up `CallOk`/`CallErr` for this same `cid` once the real outcome is
    /// known, or by `timeout_ms` at the latest. The client holds the call in an
    /// **awaiting** state until then — it does NOT retry — and falls back to a
    /// retry only if the promise is never kept. Like the other replies it carries
    /// `server_micros` (a promise is still a round-trip → a clock sample).
    CallPromise {
        cid: u32,
        timeout_ms: u64,
        server_micros: u64,
    },
    /// A protocol-level error not tied to a specific request.
    Error { error: String },
    /// Server-clock keepalive: the gate's wall clock in microseconds since the
    /// unix epoch. Emitted
    /// **only after the socket has been idle** for the keepalive interval (the
    /// first one fires immediately on connect for a fast initial lock); active
    /// clients get their samples from `call_ok`/`call_err` instead, so this
    /// never costs an active connection a byte. The client feeds it to its clock
    /// discipline (`serverNowMs`) so it tracks the timeline the gate
    /// future-stamps on. For one gate the gate's wall clock IS the canonical
    /// clock; multi-gate, the gate first syncs to a master clock and forwards
    /// that here (this frame is unchanged).
    Time { server_micros: u64 },
    /// The served DSL content changed (runtime `add_content` / `modify_content`).
    /// Carries the new corpus version fingerprint (hex). Broadcast to every
    /// connected client; each re-fetches `/content` and rebuilds. Replaces
    /// polling `/content-version`.
    ContentChanged { version: String },
    /// Live OBSERVER count for a world `macro_zone` — distinct connections whose
    /// card-subscription covers it (gate-derived). Broadcast when it changes; a
    /// client gates its move-sync on it: a move in a zone with `observers > 1` is
    /// shared space and must sync, `≤ 1` stays client-local.
    ZoneObservers { macro_zone: u64, observers: u32 },
}

impl GateMsg {
    /// Encode to postcard bytes for the WS binary sink.
    pub fn to_bytes(&self) -> Vec<u8> {
        // A well-formed GateMsg never fails postcard encoding (no custom
        // serialize errors); an empty frame on the impossible error is harmless
        // (the client ignores an undecodable frame).
        postcard::to_allocvec(self).unwrap_or_default()
    }
}

// ── Gate-side reply builders ───────────────────────────────────────────────
// These stamp the gate's wall clock, so they're host-only: `SystemTime::now()`
// panics on `wasm32-unknown-unknown`, and only the gateway (native) sends these
// frames anyway. The wasm client gets the pure types above and never calls them.
#[cfg(not(target_arch = "wasm32"))]
impl GateMsg {
    /// Build a stamped `call_ok` reply, encoded for the sink. Stamps the gate's
    /// wall clock at call time so the client's round-trip carries a fresh
    /// server-time sample (see [`CallOk`](GateMsg::CallOk)).
    pub fn call_ok(cid: u32) -> Vec<u8> {
        GateMsg::CallOk {
            cid,
            server_micros: now_micros(),
        }
        .to_bytes()
    }

    /// Build a stamped `call_err` reply, encoded for the sink.
    pub fn call_err(cid: u32, error: String) -> Vec<u8> {
        GateMsg::CallErr {
            cid,
            error,
            server_micros: now_micros(),
        }
        .to_bytes()
    }

    /// Build a stamped `call_promise` reply, encoded for the sink — accept a call
    /// for async resolution, promising a follow-up within `timeout_ms`.
    pub fn call_promise(cid: u32, timeout_ms: u64) -> Vec<u8> {
        GateMsg::CallPromise {
            cid,
            timeout_ms,
            server_micros: now_micros(),
        }
        .to_bytes()
    }

    /// Build a `content_changed` broadcast frame, encoded for the sink.
    pub fn content_changed(version: String) -> Vec<u8> {
        GateMsg::ContentChanged { version }.to_bytes()
    }

    /// Build a `zone_observers` broadcast frame, encoded for the sink.
    pub fn zone_observers(macro_zone: u64, observers: u32) -> Vec<u8> {
        GateMsg::ZoneObservers { macro_zone, observers }.to_bytes()
    }
}

/// The gate's wall clock in microseconds since the unix epoch. Rides the postcard
/// wire as a native `u64` (the client core is Rust and decodes it directly — no
/// JS-safe-integer stringification). The single source of `server_micros` for both
/// the `call_ok`/`call_err` piggyback and the idle `Time` keepalive. Host-only
/// (see the gate-side reply builders above).
#[cfg(not(target_arch = "wasm32"))]
pub fn now_micros() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}
