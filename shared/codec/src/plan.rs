//! The action-plan contract — what the gate's recipe evaluation produces and
//! its apply step consumes.
//!
//! Ported from the legacy `resonantdust_content::recipe_plan` (just the data
//! types — the gate builds these from the vm `Plan` via its own translation, so
//! the legacy `compute_holds` / tape-walking planner doesn't come along). Plan
//! `01_gate_authority_pivot`.

/// A recipe `@output` effect, stamped at a `sys.time` (`TimedEffect::at`). The
/// new model is uniform: holds (claim/touch/…), lifecycle (dead/reap), gameplay
/// (wood/…) and progress style (pstyle) are ALL stock writes — `SetCardStock` for
/// a bound card, `ModifyTileStock` for the synthetic tile. Spawning is the only
/// non-stock effect. The gate future-stamps each at `start + at`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
  /// Mark a card dead (`destroy_card` — sets the dead flag the reaper acts on).
  /// The new model expresses destroy as `data.dead inc`; because the shard is
  /// content-agnostic (can't map a dead stock-bit to the flag) the GATE
  /// translates a `data.dead` write into this effect.
  Destroy { card_id: u32 },
  /// Spawn a card at a macro_zone (`^create`). `owner_id` is either a real
  /// `card_id` or a transient plan TAG (`codec::packed::is_tag`) naming a sibling
  /// `Create` this card nests in; the shard resolves the tag to the minted id.
  /// `tag` (0 = none) is THIS card's own tag, set when a sibling references it.
  /// `stock` is the def default with any same-plan `&h.data.x set` folded in.
  Create {
    def_key: String,
    surface: u8,
    macro_zone: u64,
    owner_id: u32,
    stock: u64,
    tag: u32,
    micro_location: Option<u32>,
  },
  /// Mutate the synthetic tile's per-cell stock `slot` (`set_tile_stock`) — the
  /// zone-savable u4 path.
  ModifyTileStock { slot: u8, op: StockOp, delta: u8 },
  /// Set a bound CARD's full per-card `stock` u64 to a gate-computed value
  /// (current stock with one slot's bits replaced) — the PER-DEF mutation
  /// (wood/pine/pstyle/…). GLOBAL aspects (holds / dead / reap) go through
  /// [`Effect::LogOp`] instead.
  SetCardStock { card_id: u32, stock: u64 },
  /// Append an op-log delta for a GLOBAL aspect (holds / `dead` / `reap`) and
  /// materialize its stock value — the op-log path that supersedes
  /// `SetCardStock`/`Destroy` for those. `aspect_id` is
  /// [`crate::aspects::StockAspect::id`]; `op` is [`crate::oplog::AspectOp::code`].
  /// The shard applies it via `oplog::apply_op` at this effect's stamp.
  LogOp { card_id: u32, aspect_id: u8, op: u8, modifier: i64 },
}

/// Tile-stock arithmetic for [`Effect::ModifyTileStock`]. `code()` is the u8 the
/// gate passes to the regions `set_tile_stock` reducer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StockOp {
  Sub,
  Add,
  Set,
}

impl StockOp {
  pub fn code(self) -> u8 {
    match self {
      StockOp::Sub => 0,
      StockOp::Add => 1,
      StockOp::Set => 2,
    }
  }
}

/// One effect plus the `sys.time` it fires at (in the DSL's time units, same as
/// `duration`). The gate future-stamps it at `start + at`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimedEffect {
  pub at: i64,
  pub effect: Effect,
}

/// The action plan the gate applies: the action's duration (max `sys.time`) plus
/// the time-stamped effect timeline. Holds and styles are gone — they're stock
/// writes in `effects` (claim/touch/pstyle aspects).
#[derive(Clone, Debug, Default)]
pub struct ActionPlan {
  /// Action duration in the DSL's time units (the max `sys.time` stamp).
  pub duration: u32,
  /// The effect timeline, in tape order; each carries its `at` stamp.
  pub effects: Vec<TimedEffect>,
}

impl ActionPlan {
  /// Milliseconds from start to completion (`duration * 1000`).
  pub fn duration_ms(&self) -> u64 {
    (self.duration as u64) * 1000
  }
}
