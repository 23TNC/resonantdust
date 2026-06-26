# Temporal aspect op-log (future-stamped, out-of-order, GC'd)

Status: **design only** — not built. Captures the model worked out for the
next-gen recipe DSL (see `content/data/recipes/02.rd`), where holds, lifecycle,
and presentation become **aspects** mutated by time-stamped operations rather
than hardcoded flags set/released in place.

## Problem

The new DSL `@output` is a **timeline**: effects are stamped at a future
`sys.time` (acquire holds at t=0, mutate at t=10, release at t=10). The server
applies operations as its clock crosses each stamp; clients receive the schedule
and play it forward against their own (delayed) clock.

Two forces collide:

1. **Future-stamped + out-of-order arrival.** An op stamped T=8 can arrive after
   an op stamped T=10 has already been applied (clock skew, RTT-midpoint
   stamping, late client requests). The materialized value must still be correct.
2. **Dependent operations.** Some ops compute off the value they read, so a late
   insert before them invalidates their results.

## Core decision: store the delta, not the result

The cascade-recompute problem is an artifact of storing **absolutes**. If a row
stores the *result* of `inc` (e.g. "claim = 1"), it has baked in the base it read
at compute time, so a later-discovered earlier op can't retroactively shift it —
you'd have to carry-forward-rewrite every later row.

Store the **operation** instead (`op`, `modifier`), and read by folding:

```
value-as-of(T) = (value of latest `set` ≤ T) + Σ(deltas with set.time < op.time ≤ T)
```

A `set` is the reset/anchor barrier; deltas accumulate on top of it.

### Commutative vs value-dependent ops

| Class            | Ops              | Late insert before existing ops      |
|------------------|------------------|--------------------------------------|
| **Commutative**  | `inc` / `dec`    | Just another addend — **no re-fold.** Existing entries are still `+1`/`−1`; the fold picks up the new one. Order-independent. |
| **Value-dependent** | `set` / `mul` / `div` | Existing later results were computed off a base the late op changed → **re-fold the tail** from the earliest disturbed time. True forward propagation (the `1 2 4 8 16 → 1 2 5 10 20` case). |

All the hold/lifecycle aspects — `claim`, `borrow`, `pos_hold`, `touch_user`,
`touch_server`, `dead`, `reap` — are commutative refcounts (PN-counters). They
need the **fold**, never cascade replay. Reserve replay for genuinely
value-dependent persisted ops, and only after confirming they're **pure
value-folds** (see Trap below).

### Trap: pure value-fold vs effectful re-run

The op-log only models pure arithmetic. If correcting a past value would require
**re-running a recipe `@output`** that branched on it (`*v 2 gt if … create`),
that's transactional rollback of side effects (un-create / restore cards), not a
fold — and an `(op, bit, modifier)` row can't represent it.

**Architectural rule: effects branch only on settled state.** The unsettled
(future / out-of-order) window carries commutative deltas only. Then a past
correction never has to replay an effect. If this rule can't hold for some
feature, that's a much larger design conversation than this log — surface it
before building.

## Materialization & reads

Reads are hot (every matcher pass, every `card_view`). Do **not** fold a growing
log per read.

- Keep a materialized **value-as-of-now** column (the packed stock u64 slot) for
  fast reads.
- Maintain it by **applying deltas**, never recompute-and-overwrite (overwriting
  re-introduces the absolute-storage bug for `inc` too):
  - future op promotes (`col += δ`) when the clock crosses its time;
  - late *past* commutative op applies immediately (`col += δ`);
  - late *non-commutative* op (or a late op landing before an existing
    `set`/`mul`) re-folds the unsettled tail into the column.
- **Bound the unsettled window** by the late-arrival horizon (`now −
  max_late_arrival`, ≈ clock-skew + RTT — pin this number down). Everything older
  is settled and compacted.

## Client login & playback

Client logs in at now=6, log = `{ set@0, ++@8, ++@10 }`:

1. Subscription delivers the tail **including future-stamped rows** (`++@8`,
   `++@10`). The client gets its near-future up front — this is what makes the
   `client_delay` clock work (events are buffered before the local clock reaches
   their stamp, so they apply with no pop-in).
2. Anchor on latest `set ≤ now` (`set@0` → base). The `set`/checkpoint is what
   lets a mid-stream joiner fold without replaying all history.
3. `value-as-of(6) = base`.
4. Enqueue a **local clock-driven re-evaluation at each future stamp** (8, 10).

At T=8 a local timer fires (NOT a row arrival — the row's been in hand since
login), re-folds → `base+1`, and updates everything derived from the aspect
(locks, local match-eligibility, visuals). No server round-trip: server and
client fold the same deterministic log, so they agree. This is the
`future_row_progress_kick` problem generalized — `ValidAtTable.promote` only
fires on *current-row* change, so future rows sitting in the buffer need an
explicit local scheduler keyed on the next pending stamp.

A new op streaming in mid-window is inserted and re-folded (commutative → cheap,
schedule unchanged; non-commutative → re-fold tail, maybe reschedule). Same rules
as the server, client-side.

## GC / compaction

GC always retains **one row in the past** per (card, aspect): the collapsed
`set` checkpoint. More-than-one past rows collapse into it. On login the client
reads that checkpoint + the live tail and plays forward.

### Checkpoint churn must never ride a standing subscription

Collapsing N past rows into one `set` fans out to every standing subscriber even
though they already hold the materialized value. Same failure as
`region_version_delete_bug` (supersede-delete churn). Cure is the same shape:
**one mutable checkpoint row, updated in place.**

Split into:
- **One-shot snapshot read at login** — the checkpoint(s). GC churn here never
  touches standing subs.
- **Standing subscription on the live window** — the append-only tail only.

Give the checkpoint a **fixed reserved key per (card, aspect)** so GC **upserts
in place** instead of insert-new + delete-old. In-place update of a row outside
the live filter = zero fan-out *and* no supersede churn. Those reserved ids also
serve as the dedup key across the snapshot/live seam.

### Encoding the split as a *static* filter

STDB subscriptions can't express `WHERE time > now` — `now` moves. The
discriminator must be a **constant** and must **outrank the time bits**, or the
filter partitions by wall-clock instead of by role.

- **Reserved tag above time:** `[tag | time | count]`, tag highest. Live sub =
  `col < BOUNDARY`; login snapshot = `col >= BOUNDARY`. Static boundary, never
  moves; each partition still sorts time-then-count internally.
- Reserving high bits *of the count* while time is the high half (`[time |
  count]`) does **not** work: `< boundary` filters by time, so a checkpoint at
  time=5 still sorts below a live row at time=6. The discriminator must dominate.

### Mechanics / gotchas

1. **The one-shot is subscribe → read → unsubscribe**, via the gate gather path —
   must release the handle or it leaks (`gate_gather_subs`). Reuses existing,
   already-fixed machinery.
2. **Seam order: live sub first, snapshot second, dedup by count id.** An op
   landing mid-login can't fall in the gap; overlap is idempotent (commutative +
   dedup).
3. **GC absorbs-into-checkpoint and deletes the live row in one reducer** (STDB
   atomic), so clients see both together and re-fold to an invariant value.
   Corollary: the client must read a **compaction-delete as "settled, keep the
   value," not "retract/subtract."** The checkpoint already absorbed it.
4. **Compaction watermark == live-window floor.** Only collapse rows past `now −
   max_late_arrival`; the live window must extend at least that far down, or
   you'd compact a row a late op still wants to reorder against. One number drives
   both.

## Reduces to

One mutable checkpoint row + an append-only live tail per (card, aspect) — a
shape this codebase already keeps cheap (regions current-value table, anchor/sub
watermarks). Commutative deltas are the fast path (late insert = one addition);
replay-the-tail is reserved for value-dependent ops under the settled-state rule.
