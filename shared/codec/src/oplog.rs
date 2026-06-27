//! Temporal aspect op-log — the pure fold core.
//!
//! An aspect's value over time is the **ordered replay** of the operations
//! recorded against it: process every op with `time ≤ at` in time order, where
//! `Set` resets the running value and `Inc`/`Dec` add/subtract. This is the one
//! mechanism that generalizes over BOTH commutative refcounts (`inc`/`dec`, where
//! the replay reduces to a plain sum and arrival order is irrelevant) and
//! value-dependent ops (`set`, where the ordering is exactly what makes a
//! late-inserted earlier op fold correctly).
//!
//! The table + materialization live in the shard; this module is the pure,
//! testable arithmetic the shard folds with. Pair it with [`crate::aspects`] to
//! write a folded value back into the `stock` u64's aspect field.
//!
//! GC collapses settled ops into a single `Set` checkpoint (the folded value at
//! the compaction watermark), so a live fold never replays unbounded history —
//! it starts from that checkpoint and replays only the live tail.

/// The operation an op-log row records. Discriminant is the wire `op` code (a
/// `u3` — room for `Mul`/`Div` later); never renumber.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AspectOp {
  /// Reset the running value to `modifier` — the anchor/barrier the fold and the
  /// GC checkpoint are built on.
  Set = 0,
  /// Add `modifier` (commutative).
  Inc = 1,
  /// Subtract `modifier` (commutative).
  Dec = 2,
}

impl AspectOp {
  /// The wire `op` code.
  pub fn code(self) -> u8 {
    self as u8
  }
  /// Resolve a wire `op` code, or `None` if undefined.
  pub fn from_code(code: u8) -> Option<Self> {
    Some(match code {
      0 => AspectOp::Set,
      1 => AspectOp::Inc,
      2 => AspectOp::Dec,
      _ => return None,
    })
  }
}

/// One recorded operation against a single `(card, aspect)`. `time` is the
/// future-stampable ms the op takes effect at; `modifier` is the operand (the
/// reset value for `Set`, the magnitude for `Inc`/`Dec`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Op {
  pub time: u64,
  pub op: AspectOp,
  pub modifier: i64,
}

impl Op {
  pub fn set(time: u64, value: i64) -> Self {
    Op { time, op: AspectOp::Set, modifier: value }
  }
  pub fn inc(time: u64, by: i64) -> Self {
    Op { time, op: AspectOp::Inc, modifier: by }
  }
  pub fn dec(time: u64, by: i64) -> Self {
    Op { time, op: AspectOp::Dec, modifier: by }
  }
}

/// Value of the aspect as of `at` — the ordered replay of every op with
/// `time ≤ at`. Input order is irrelevant: the replay sorts by `time` (then by a
/// stable tiebreak so two ops at the same stamp replay in slice order, matching
/// the within-reducer write order). Ops after `at` are ignored.
///
/// Commutative-only logs reduce to `Σ inc − Σ dec`; a `Set` anywhere resets the
/// running value, so a late-inserted op *before* an existing `Set` correctly does
/// not disturb anything after that `Set` (the barrier property the in-place
/// forward-prop can't honor).
pub fn fold(ops: &[Op], at: u64) -> i64 {
  // Stable index sort so equal-`time` ops keep their slice order (the order they
  // were appended within a reducer). Small N (one (card,aspect) window bounded by
  // the GC horizon), so the allocation is negligible.
  let mut idx: Vec<usize> = (0..ops.len()).filter(|&i| ops[i].time <= at).collect();
  idx.sort_by_key(|&i| ops[i].time);
  let mut value = 0i64;
  for i in idx {
    let o = ops[i];
    match o.op {
      AspectOp::Set => value = o.modifier,
      AspectOp::Inc => value += o.modifier,
      AspectOp::Dec => value -= o.modifier,
    }
  }
  value
}

/// Fold clamped to a `u8` field (the form a stock aspect needs) — negative folds
/// (over-release) clamp to 0, large folds clamp to `max`. `max` is the aspect
/// field's [`crate::aspects::StockField::max`].
pub fn fold_clamped(ops: &[Op], at: u64, max: u8) -> u8 {
  fold(ops, at).clamp(0, max as i64) as u8
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn op_code_roundtrips() {
    for code in 0..=2 {
      assert_eq!(AspectOp::from_code(code).unwrap().code(), code);
    }
    assert_eq!(AspectOp::from_code(3), None);
  }

  #[test]
  fn commutative_is_order_independent() {
    // acquire@0, acquire@5, release@10 — in any slice order, same result by time.
    let a = [Op::inc(0, 1), Op::inc(5, 1), Op::dec(10, 1)];
    let b = [Op::dec(10, 1), Op::inc(5, 1), Op::inc(0, 1)];
    for at in [0, 4, 5, 9, 10, 99] {
      assert_eq!(fold(&a, at), fold(&b, at), "at={at}");
    }
    assert_eq!(fold(&a, 0), 1);
    assert_eq!(fold(&a, 5), 2);
    assert_eq!(fold(&a, 9), 2);
    assert_eq!(fold(&a, 10), 1);
  }

  #[test]
  fn late_insert_before_existing_ops_folds_correctly() {
    // T=10 already applied; a late T=8 inc arrives. Value at 10 must reflect it.
    let before = [Op::inc(0, 1), Op::dec(10, 1)];
    assert_eq!(fold(&before, 10), 0);
    let after = [Op::inc(0, 1), Op::dec(10, 1), Op::inc(8, 1)]; // late, out of order
    assert_eq!(fold(&after, 9), 2, "the late op lifts the mid value");
    assert_eq!(fold(&after, 10), 1, "and shifts the post-release value");
  }

  #[test]
  fn set_is_a_barrier() {
    // A late inc BEFORE a set must not disturb anything at/after the set.
    let ops = [Op::set(10, 0), Op::inc(20, 1), Op::inc(5, 5)]; // inc@5 is pre-barrier
    assert_eq!(fold(&ops, 7), 5, "pre-barrier inc visible before the set");
    assert_eq!(fold(&ops, 10), 0, "set resets, swallowing the pre-barrier inc");
    assert_eq!(fold(&ops, 20), 1, "post-barrier inc builds on the set");
  }

  #[test]
  fn checkpoint_preserves_future_folds() {
    // The op-log GC collapses settled ops (time <= watermark) into one Set
    // checkpoint at the watermark. That must not change any fold at or after the
    // watermark — the invariant the shard `compact` relies on.
    let all = [Op::inc(0, 1), Op::inc(5, 1), Op::dec(20, 1), Op::inc(8, 1)];
    let watermark = 10;
    let cp = fold(&all, watermark); // settled value as-of the watermark
    let mut compacted = vec![Op::set(watermark, cp)];
    compacted.extend(all.iter().filter(|o| o.time > watermark).copied());
    for t in [10, 15, 20, 21, 999] {
      assert_eq!(fold(&compacted, t), fold(&all, t), "fold diverged at t={t}");
    }
  }

  #[test]
  fn fold_clamped_bounds_the_field() {
    assert_eq!(fold_clamped(&[Op::dec(0, 3)], 0, 7), 0, "over-release clamps to 0");
    assert_eq!(fold_clamped(&[Op::set(0, 99)], 0, 7), 7, "over-max clamps to max");
    assert_eq!(fold_clamped(&[Op::inc(0, 2)], 0, 7), 2);
  }
}
