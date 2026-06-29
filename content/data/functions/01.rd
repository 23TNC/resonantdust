; content/data/functions/01.rd
; <data_func> — pure aspect-mutating helpers, called `$data_func::name`. Args are
; passed on the operand stack and retrieved with `pop`; an address arg (`&data`,
; `&slot.1.0.data`) becomes a Ref the callee aliases, so the helper reads/writes
; THROUGH to the card's data aspects. A distinct registry from <functions> (the
; visual prim builders).
;
; The hold/lifecycle model: claim = exclusive (slot) hold; borrow = non-exclusive
; hold; touch = refcount namespace (.user/.server budgets, cap 3); pos_hold =
; position pin; dead = lifecycle refcount (dead != 0 doesn't immediately remove
; the card — it's reaped later, which is why releases still run on a killed card);
; pstatus = progress-bar presence bitmap (start_bar/end_bar). A recipe's @input
; reads holds via can_*; @output acquires via set_* and releases via release_*.

<data_func>
  ; Declare per-card UI stock (`&data` passed in). The holds + lifecycle
  ; (claim/borrow/touch/pos_hold/dead/reap) are NO LONGER declared here — they're
  ; op-log GLOBAL stock aspects (codec::aspects, fixed bits 42-63), so declaring
  ; them as schema slots was both vestigial AND harmful: on a card with many
  ; per-def aspects the schema grew up into the global region and a slot's default
  ; landed on the Dead field → false `is_dead`. `pstatus` (progress-bar presence
  ; bitmap) is a real per-card aspect a recipe sets, so it stays — 4 bits = up to 4
  ; concurrent bar channels (bit N = channel N active).
  ::aspect_flags>
    pop &a set
    4 &a.pstatus stock
    0 ret

  ; Default stacking bit-fields (FLAT `stack_hosts`/`stack_joins` — the names the
  ; engine reads, see dsl::defs::stack_bits). Override after the call for a card
  ; with custom bits. tile = hosts none, joins hex; rect = hosts hex+top+bottom,
  ; joins top+bottom.
  ::aspect_stack_tile>
    pop &a set
    0 &a.stack_hosts set
    2 &a.stack_joins set
    0 ret
  ::aspect_stack_rect>
    pop &a set
    14 &a.stack_hosts set
    12 &a.stack_joins set
    0 ret

  ; --- claim: exclusive (slot) hold. `use` = exclusive but unpinned; `claim` =
  ; exclusive + position-pinned. ---
  ::can_claim>
    pop &a set
    *a.dead   0 eq !if 0 ret
    *a.claim  0 eq !if 0 ret
    *a.borrow 0 eq !if 0 ret
    *a.touch.user 3 lt !if 0 ret
    1 ret

  ::set_claim>
    pop &a set
    &a.claim inc
    &a.pos_hold inc
    &a.touch.user inc
    0 ret
  ::release_claim>
    pop &a set
    &a.claim dec
    &a.pos_hold dec
    &a.touch.user dec
    0 ret

  ::set_use>
    pop &a set
    &a.claim inc
    &a.touch.user inc
    0 ret
  ::release_use>
    pop &a set
    &a.claim dec
    &a.touch.user dec
    0 ret

  ; --- progress bar: `pstatus` channel 0 (the build/completion bar). `start_bar`
  ; sets the bit in the hold-acquire partition (sys.time 0); `end_bar` clears it in
  ; the completion partition (sys.time = duration). The bit rides forward across the
  ; window's rows via clone-from-prior; the clear forms the interval's end boundary
  ; the client scans for. Always pair them — a missing `end_bar` leaves the bit set
  ; forever and the bar never completes. ---
  ::start_bar>
    pop &a set
    1 &a.pstatus set
    0 ret
  ::end_bar>
    pop &a set
    0 &a.pstatus set
    0 ret

  ; --- borrow: non-exclusive hold. `borrow` = unpinned; `share` = position-pinned.
  ; Same eligibility (just "not exclusively claimed"), so can_share = can_borrow. ---
  ::can_borrow>
    pop &a set
    *a.dead   0 eq !if 0 ret
    *a.claim  0 eq !if 0 ret
    *a.touch.user 3 lt !if 0 ret
    1 ret

  ::set_borrow>
    pop &a set
    &a.borrow inc
    &a.touch.user inc
    0 ret
  ::release_borrow>
    pop &a set
    &a.borrow dec
    &a.touch.user dec
    0 ret

  ::set_share>
    pop &a set
    &a.borrow inc
    &a.pos_hold inc
    &a.touch.user inc
    0 ret
  ::release_share>
    pop &a set
    &a.borrow dec
    &a.pos_hold dec
    &a.touch.user dec
    0 ret

  ; Relocation helper: `<zone> <micro> <stack> &card $data_func::place call drop` —
  ; wraps the `^place` syscall (relocate a bound card with the placement intent; the
  ; shard resolves the cell+stack and re-owns it to the zone owner). `zone` is a
  ; `^macro_zone` handle or a concrete macro_zone; `micro` a loose cell; `stack` the
  ; target slot (0 loose). Sends a consumed blueprint back to inventory.
  ::place>
    pop &z set
    pop &m set
    pop &s set
    pop &c set
    *z *m *s &c ^place call drop
    0 ret
