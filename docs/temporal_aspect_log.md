# Temporal aspect op-log (server-internal, future-stamped, out-of-order, GC'd)

Status: **design + plan** — not built. The mechanism that gives **stock** aspects
forward propagation, so future-stamped holds / lifecycle (`acquire@0`,
`release@10`, `dead@deadline`) materialize correctly under out-of-order arrival.
Building this is the prerequisite for collapsing the separate `flags` word into
the stock u64 (see `docs/flags_in_dsl_plan.md` — this **supersedes** that plan's
separate-word approach).

## Decision: the log is SERVER-INTERNAL

The client only ever receives **materialized card rows** — the folded
value-as-of-now plus **future-stamped** card rows for the schedule — over the
existing card subscription. It plays those forward against its delayed clock with
the machinery it already has (`future_row_progress_kick`, the movement
future-stamp path). It never sees the log, never folds deltas.

The **server is the sole folder.** The op-log is a private shard table used only
to materialize card rows correctly. This deletes the entire client-facing half of
the original design — no client log subscription, no login-snapshot/live-tail
split, no `[tag|time|count]` static-boundary packing, no checkpoint-churn-on-sub
concern. Those existed only because the log was on the client.

Trade accepted: a materialized future row is heavier on the wire than a compact
`(op, modifier)` delta — but schedules are a couple of stamps per aspect, progress
interpolates locally, and **re-materialization is rare** (only late ops and recipe
fire), so the dumber client + far simpler GC is worth the bytes.

## Problem

`@output` is a timeline; stamps arrive **out of order** (RTT-midpoint stamping,
skew, late clients): an op stamped T=8 can land after T=10 was applied. The
materialized value must still be correct, and some ops compute off the value they
read, so a late earlier insert can invalidate later results.

## Core: store the delta, not the result

Storing the *result* of `inc` bakes in the base read at compute time, so a
late-discovered earlier op forces a carry-forward rewrite. Store the **operation**
and read by folding:

```
value-as-of(T) = (latest set ≤ T) + Σ(deltas with set.time < op.time ≤ T)
```

A `set` is the reset/anchor barrier; deltas accumulate on top.

| Class | Ops | Late insert before existing ops |
|---|---|---|
| **Commutative** | `inc` / `dec` | Just another addend — **no re-fold**. Order-independent. |
| **Value-dependent** | `set` / `mul` / `div` | Later results were computed off a base the late op changed → **re-fold the tail** from the earliest disturbed time. |

Every hold/lifecycle aspect — `claim`, `borrow`, `pos_hold`, `touch_user`,
`touch_server`, `dead`, `reap` — is a commutative refcount (PN-counter). They need
the **fold**, never replay. That's what makes this tractable.

### Guardrail: effects branch only on settled state

The op-log models pure arithmetic. If correcting a past value would require
**re-running an `@output`** that branched on it (`*v 2 gt if … create`), that's
transactional rollback of side effects — an `(op, modifier)` row can't represent
it. So: a recipe may read the **settled** value to decide whether to fire, but the
unsettled (future / out-of-order) window carries **commutative deltas only**. Then
a late correction is always a fold, never an effect replay. If a feature can't
honor this, surface it — it's a bigger conversation than the log.

## Architecture (server-internal)

Two tiers, both on the shard:

1. **Materialized card rows** — the packed stock u64 (value-as-of-now) for hot
   reads (matcher, `card_view`), plus future-stamped card rows for each scheduled
   stamp. This is the *only* thing clients subscribe to.
2. **The op-log table** (new, ST-only) — append-only deltas per `(card, aspect)`,
   the source the server folds from.

Generalizes what already exists: `propagate_hold_forward` is today a *hardcoded*
op-log for the hold refcount fields in `flags` (walks future rows, ±1). The log
makes that general and moves it onto stock aspects.

### Log row shape

```
op_log(card_id, aspect_id:u4, valid_at:i64, op:u3, modifier, reserved_checkpoint)
```

- **`aspect_id:u4`** — the **global** op-requiring aspects (~8: the holds +
  `dead`/`reap`); the codec global registry maps `aspect_id → (shift, width)` in
  the stock u64 prefix. Works *because* they're global (fixed offset) — the same
  property that lets the content-agnostic shard fold without content.
- **`op:u3`** — `set`/`inc`/`dec`(/`mul`/`div`).
- Per-def magnitude aspects (pine/wood) stay **whole-value `SetCardStock`** — they
  don't need ops, so they don't enter the log. `aspect_id` stays u4-bounded.

### Materialization

- Maintain the stock u64 column by **applying deltas** (`col += δ`), never
  recompute-overwrite (overwriting re-introduces the absolute-storage bug).
- **Future-promote** when the clock crosses a stamp (the existing future-row
  promote, now delta-driven).
- **Late past commutative** op → apply δ immediately + re-materialize the affected
  future card rows; re-emit only the *changed* rows (existing card sub fans out).
- **Late value-dependent** op → re-fold the unsettled tail, re-materialize, re-emit.
- **Bound the unsettled window** at `now − max_late_arrival` (≈ clock-skew + RTT;
  relate to `STALE_SAMPLE_MS` / `client_delay`). Older = settled.

## GC / compaction (server-internal — no client fan-out)

Per `(card, aspect)` keep **one mutable checkpoint row** (the collapsed `set`
anchor) at a **fixed reserved key**; GC **upserts in place**. Collapse log rows
older than the watermark (`now − max_late_arrival`, same number as the unsettled
floor) into it, then delete them.

Because compaction doesn't change the *materialized value*, **no card row changes,
so nothing reaches the client** — the whole churn-on-subscription problem
disappears. Reads fold checkpoint + live tail.

## Implementation plan

Server-side (shard) + rules/codec translate + gate. Each phase unit-testable.

### Phase 1 — log table + global aspect registry
`spacetime` shard, `shared/codec`
- `op_log` shard table (`card_id, aspect_id, valid_at, op, modifier, reserved`),
  indexed `(card_id, aspect_id, valid_at)`; **no client subscription**.
- codec global registry const: `aspect_id:u4 → (shift, width)` in the stock u64
  prefix (shared, so the shard folds content-free). Same layout as the flags work.
- **Verify:** table compiles; registry unit test (`aspect_id ↔ bits`).

### Phase 2 — write path: `translate()` → log ops
`shared/codec/src/plan.rs`, `shared/rules`, `gateway`, `spacetime`
- codec `Effect::LogOp { aspect_id, op, modifier, at }`; keep `SetCardStock` for
  per-def whole-value aspects.
- `translate()`: global-aspect timeline writes (`claim inc`@0, `release`@win,
  `dead inc`@deadline) → `LogOp`s at their stamps; per-def writes stay `SetCardStock`.
- gate threads `LogOp`s to the reducer; shard appends the log row + applies the δ.
- **Verify:** rules test (cut_tree → `LogOp(claim,+1,@0)` / `(claim,-1,@win)` /
  `(dead,+1,@deadline)`).

### Phase 3 — fold + materialize (core)
`spacetime` shard
- `value_as_of(card, aspect, T)` = checkpoint + Σ deltas; maintain the stock column
  by applying δ; future-promote on clock cross; emit future-stamped card rows per
  pending stamp.
- **Verify:** fold unit tests (commutative order-independence; future rows correct).

### Phase 4 — out-of-order + re-emit
`spacetime` shard
- Late commutative → apply δ + re-materialize affected future rows, re-emit changed
  rows only. Late value-dependent → re-fold tail. Enforce the settled-state guard
  (reject unsettled value-dependent ops that would need effect replay).
- **Verify:** harness injects out-of-order ops; materialized value + future rows
  converge to the in-order result.

### Phase 5 — GC / compaction
`spacetime` shard `gc.rs`
- Reserved per-`(card,aspect)` checkpoint key; in-place upsert; collapse rows past
  the watermark; pin `max_late_arrival`.
- **Verify:** N past ops → 1 checkpoint, current value invariant, **no card-row
  emit** on compaction.

### Phase 6 — migrate global aspects onto the log; retire hardcoded forward-prop
`spacetime` shard, `content/**`, DSL
- Replace `propagate_hold_forward` (hardcoded `flags` hold fields) with the general
  log for `claim/borrow/touch/pos_hold`; move `dead`/`reap` onto the log in the
  stock u64 prefix; the reaper reads materialized `dead` at the global stock offset
  (content-free) instead of the flag bit.
- Retire the `flags` word's hold refcount fields + `dead` bit (now folded from the
  log into stock); `flags_bk` (dirty) stays. **This is the flags-into-stock
  collapse** — global aspects named as `data.*` (global) per the flags-in-DSL
  decision.
- **Verify:** cut_tree end-to-end (acquire/release/`dead` via the log); reaper on
  stock-prefix `dead`; claude redeploy + browser.

## Relationship to the flags work

This **supersedes** `docs/flags_in_dsl_plan.md`'s separate-`flags`-word approach.
Phase 6 here IS the flags-into-stock collapse: once stock aspects forward-propagate
via the log, `dead`/`reap`/holds become global stock aspects and the separate
`flags` word retires. If a `flags.*` DSL *namespace* is still wanted, it's a naming
marker over the global stock prefix — not separate storage.

## Reduces to

One mutable checkpoint + an append-only live tail per `(card, aspect)`, folded by
the server into materialized current + future-stamped card rows — a shape this
codebase already keeps cheap (regions current-value table, the existing future-row
promote). Commutative deltas are the fast path; replay is reserved for
value-dependent ops under the settled-state guard.
