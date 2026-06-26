//! Typed wire row structs — the shard table rows as they ride the gate↔client
//! socket.
//!
//! These are the **binary** (postcard) row payloads: native integer fields in an
//! explicit, stable order (postcard is positional, so field order *is* the wire
//! contract — see the migration design doc). No camelCase, no number-stringify:
//! the JSON path coerced `u64` to/from strings for JS safety, but the client core
//! is Rust and the view never touches the wire, so numbers ride native.
//!
//! The gate builds these from its SDK binding rows (an explicit field copy) and
//! the client decodes straight into them — one definition, both sides, so they
//! can't drift. Placement / flag *meaning* is not decoded here; that's
//! `resonantdust_codec`'s job, reached through the helpers below so the bit layout
//! has one owner.

use resonantdust_codec::card_model::{self, Micro};
use resonantdust_codec::packed::{
    tile_def_id, unpack_zone_definition, valid_at_time, ZONE_TILE_COUNT, ZONE_TILE_U64_COUNT,
};
use serde::{Deserialize, Serialize};

/// A row event payload: which table the row belongs to is the enum variant (the
/// gate↔client `Row` frame no longer carries a `table` string — the variant tag
/// is it). One arm per table the client actually decodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RowData {
    Card(CardRow),
    Zone(ZoneRow),
    Region(RegionRow),
    Player(PlayerRow),
    Chat(ChatRow),
}

impl RowData {
    /// The table name — for the debug-HUD subscription stats (which key by table)
    /// and diagnostics. Not on the wire; derived from the variant.
    pub fn table(&self) -> &'static str {
        match self {
            RowData::Card(_) => "cards",
            RowData::Zone(_) => "zones",
            RowData::Region(_) => "regions",
            RowData::Player(_) => "players",
            RowData::Chat(_) => "chat_messages",
        }
    }
}

/// One version-row of the `cards` table. A card has many of these over time (the
/// bitemporal history); `valid_at` is the PK.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardRow {
    pub valid_at: u64,
    pub card_id: u32,
    pub macro_zone: u64,
    pub micro_location: u32,
    pub owner_id: u32,
    pub packed_definition: u16,
    /// Propagating flag word — state bits + placement + refcount holds.
    pub flags: u32,
    /// Non-propagating bookkeeping byte (dirty/preserve).
    pub flags_bk: u8,
    /// Per-card stock word.
    pub stock: u64,
}

impl CardRow {
    /// Wall-clock ms this row became valid (the high 48 bits of `valid_at`).
    pub fn time_ms(&self) -> u64 {
        valid_at_time(self.valid_at)
    }

    /// Decode this row's placement (loose coords or a stack-member of a root).
    pub fn micro(&self) -> Micro {
        Micro::of(self.micro_location, self.flags)
    }

    /// `dead` state bit set?
    pub fn is_dead(&self) -> bool {
        card_model::is_dead(self.flags)
    }
}

/// One version-row of the `zones` table — a zone's tile grid packed into
/// [`ZONE_TILE_U64_COUNT`] words.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneRow {
    pub valid_at: u64,
    pub zone_id: u32,
    pub macro_zone: u64,
    /// `[card_type:u4 | 0:u4]` — the tile card_type for this zone's tiles.
    pub packed_definition: u8,
    pub owner_id: u32,
    /// The packed tile grid (one fixed array instead of `t_0..t_12` — postcard
    /// encodes it as a flat run of `u64`s, no per-field overhead).
    pub tiles: [u64; ZONE_TILE_U64_COUNT],
}

impl ZoneRow {
    pub fn time_ms(&self) -> u64 {
        valid_at_time(self.valid_at)
    }

    /// The tile grid as the codec's packed array.
    pub fn tile_words(&self) -> [u64; ZONE_TILE_U64_COUNT] {
        self.tiles
    }

    /// The tile card_type for this zone's tiles (upper nibble of `packed_definition`).
    pub fn tile_card_type(&self) -> u8 {
        unpack_zone_definition(self.packed_definition)
    }

    /// The distinct non-empty tile `def_id`s present in this zone (the "unique
    /// tile attributes" search keys, before aspect resolution).
    pub fn unique_tile_def_ids(&self) -> Vec<u16> {
        let words = self.tiles;
        let mut seen: Vec<u16> = Vec::new();
        for idx in 0..ZONE_TILE_COUNT {
            let def_id = tile_def_id(&words, idx);
            if def_id != 0 && !seen.contains(&def_id) {
                seen.push(def_id);
            }
        }
        seen
    }
}

/// The `regions` table row — per-region spawn presence/availability bitfields.
/// Current-value (one row per `macro_region`, no `valid_at`). Feeds the zone
/// manager's region gate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegionRow {
    pub macro_region: u64,
    /// Bit `i` set → the zone at region slot `i` MAY be spawned.
    pub zone_presence: u64,
    /// Bit `i` set → the zone at region slot `i` HAS been spawned.
    pub zone_available: u64,
    /// Disk radius (tiles) the region is bounded by (presence + tile mask).
    pub distance: u16,
}

/// A `players` row, trimmed to what the client reads: it matches its own row by
/// `name` to learn its `player_id`. (The shard row also carries valid_at /
/// data_shard / last_login / flags; the gate copies only these two.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerRow {
    pub player_id: u32,
    pub name: String,
}

/// A `chat_messages` row — the append-only side feed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRow {
    pub sent_at: u64,
    pub sender_player_id: u32,
    pub sender_name: String,
    pub body: String,
}
