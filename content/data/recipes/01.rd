; content/data/recipes/01.rd
; Re-implemented in the new model from ../backup/01.rd. @input is a guard-clause
; predicate (each line `<pred> !if 1 ret`, then `… can_* call !if 1 ret` for hold
; eligibility, ending `0 ret`); @output acquires holds at sys.time 0 (set_*),
; mutates + spawns at the action window, then releases (release_*). `destroy`
; → `data.dead inc`; `create` → `^macro_zone` + `^create`; style → `data.pstyle`
; (ltr=1 / rtl=2).
;
; Magnetic status outcomes (despair/strike/gloom success+failure) referenced by
; cards/status.rd. The magnet is the root (slot.0.0); the pulled candidate is on
; the top stack (slot.2.x).
;
; DEFERRED (need model features not yet ported): chord_soul_assemble (uses the
; retired `move` verb + `create … .location` exact-cell spawn) and chorus_attune
; (writes a `faction` aspect, a deferred registry). triple_corpus / dread_remover
; / corpus_dust / corpus_b_* crafting recipes are gameplay-triggered and not yet
; re-implemented.

<recipe>
  ; --- despair: pull a dread, consume both, yield a corpus (success); on the
  ; 60s deadline, spawn a dread (failure). ---
  ::despair_success>
    @input>
      $card::despair *slot.0.0.def_id eq !if 1 ret
      &slot.0.0.data $data_func::can_claim call !if 1 ret
      $card::dread *slot.2.0.def_id eq !if 1 ret
      &slot.2.0.data $data_func::can_claim call !if 1 ret
      0 ret
    @output>
      0 &sys.time set
      &slot.0.0.data $data_func::set_use call drop
      &slot.2.0.data $data_func::set_claim call drop
      10 &sys.time set
      1 &slot.2.0.data.pstyle set
      &slot.2.0.data.dead inc
      &slot.0.0.data.dead inc
      &slot.2.0.owner 1 0 0 ^macro_zone call &z set
      *z $card::corpus &slot.2.0.owner ^create call drop
      &slot.0.0.data $data_func::release_use call drop
      &slot.2.0.data $data_func::release_claim call drop

  ::despair_failure>
    @input>
      $card::despair *slot.0.0.def_id eq !if 1 ret
      &slot.0.0.data $data_func::can_claim call !if 1 ret
      0 ret
    @output>
      0 &sys.time set
      &slot.0.0.data $data_func::set_use call drop
      10 &sys.time set
      1 &slot.0.0.data.pstyle set
      &slot.0.0.data.dead inc
      &slot.0.0.owner 1 0 0 ^macro_zone call &z set
      *z $card::dread &slot.0.0.owner ^create call drop
      &slot.0.0.data $data_func::release_use call drop

  ; --- gloom: despair's short-window (4s) twin for the harness failure path. ---
  ::gloom_success>
    @input>
      $card::gloom *slot.0.0.def_id eq !if 1 ret
      &slot.0.0.data $data_func::can_claim call !if 1 ret
      $card::dread *slot.2.0.def_id eq !if 1 ret
      &slot.2.0.data $data_func::can_claim call !if 1 ret
      0 ret
    @output>
      0 &sys.time set
      &slot.0.0.data $data_func::set_use call drop
      &slot.2.0.data $data_func::set_claim call drop
      2 &sys.time set
      &slot.2.0.data.dead inc
      &slot.0.0.data.dead inc
      &slot.2.0.owner 1 0 0 ^macro_zone call &z set
      *z $card::corpus &slot.2.0.owner ^create call drop
      &slot.0.0.data $data_func::release_use call drop
      &slot.2.0.data $data_func::release_claim call drop

  ::gloom_failure>
    @input>
      $card::gloom *slot.0.0.def_id eq !if 1 ret
      &slot.0.0.data $data_func::can_claim call !if 1 ret
      0 ret
    @output>
      0 &sys.time set
      &slot.0.0.data $data_func::set_use call drop
      2 &sys.time set
      &slot.0.0.data.dead inc
      &slot.0.0.owner 1 0 0 ^macro_zone call &z set
      *z $card::dread &slot.0.0.owner ^create call drop
      &slot.0.0.data $data_func::release_use call drop

  ; --- strike: pull THREE corpus, consume all + the magnet, yield three
  ; corpus_dim (success); on deadline, spawn a dread (failure). ---
  ::strike_success>
    @input>
      $card::strike *slot.0.0.def_id eq !if 1 ret
      &slot.0.0.data $data_func::can_claim call !if 1 ret
      $card::corpus *slot.2.0.def_id eq !if 1 ret
      &slot.2.0.data $data_func::can_claim call !if 1 ret
      $card::corpus *slot.2.1.def_id eq !if 1 ret
      &slot.2.1.data $data_func::can_claim call !if 1 ret
      $card::corpus *slot.2.2.def_id eq !if 1 ret
      &slot.2.2.data $data_func::can_claim call !if 1 ret
      0 ret
    @output>
      0 &sys.time set
      &slot.0.0.data $data_func::set_use call drop
      &slot.2.0.data $data_func::set_claim call drop
      &slot.2.1.data $data_func::set_claim call drop
      &slot.2.2.data $data_func::set_claim call drop
      10 &sys.time set
      1 &slot.0.0.data.pstyle set
      &slot.2.0.data.dead inc
      &slot.2.1.data.dead inc
      &slot.2.2.data.dead inc
      &slot.0.0.data.dead inc
      &slot.2.0.owner 1 0 0 ^macro_zone call &z set
      *z $card::corpus_dim &slot.2.0.owner ^create call drop
      *z $card::corpus_dim &slot.2.0.owner ^create call drop
      *z $card::corpus_dim &slot.2.0.owner ^create call drop
      &slot.0.0.data $data_func::release_use call drop
      &slot.2.0.data $data_func::release_claim call drop
      &slot.2.1.data $data_func::release_claim call drop
      &slot.2.2.data $data_func::release_claim call drop

  ::strike_failure>
    @input>
      $card::strike *slot.0.0.def_id eq !if 1 ret
      &slot.0.0.data $data_func::can_claim call !if 1 ret
      0 ret
    @output>
      0 &sys.time set
      &slot.0.0.data $data_func::set_use call drop
      10 &sys.time set
      1 &slot.0.0.data.pstyle set
      &slot.0.0.data.dead inc
      &slot.0.0.owner 1 0 0 ^macro_zone call &z set
      *z $card::dread &slot.0.0.owner ^create call drop
      &slot.0.0.data $data_func::release_use call drop

  ; --- prime: root-only stock read/write probe. While tally's progress < 3,
  ; increment it (self-terminating). ---
  ::prime>
    @input>
      $card::tally *slot.0.0.def_id eq !if 1 ret
      *slot.0.0.data.progress 3 lt !if 1 ret
      &slot.0.0.data $data_func::can_claim call !if 1 ret
      0 ret
    @output>
      0 &sys.time set
      &slot.0.0.data $data_func::set_use call drop
      &slot.0.0.data.progress inc
      &slot.0.0.data $data_func::release_use call drop

  ; --- forge: root-only ^create-handle probe. Once (forged < 1), create a widget
  ; into the owner's inventory, fold its progress 1→4 (same-card set folds into the
  ; Create), nest a pip in the widget, then set forged to self-terminate. ---
  ::forge>
    @input>
      $card::anvil *slot.0.0.def_id eq !if 1 ret
      *slot.0.0.data.forged 1 lt !if 1 ret
      &slot.0.0.data $data_func::can_claim call !if 1 ret
      0 ret
    @output>
      0 &sys.time set
      &slot.0.0.data $data_func::set_use call drop
      &slot.0.0.owner 1 0 0 ^macro_zone call &z set
      *z $card::widget &slot.0.0.owner ^create call &h set
      4 &h.data.progress set
      &h 1 0 0 ^macro_zone call &hz set
      *hz $card::pip &h ^create call drop
      1 &slot.0.0.data.forged set
      &slot.0.0.data $data_func::release_use call drop
