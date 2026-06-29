; content/data/recipes/02.rd
; Crafting recipes (migrated from ../backup/02.rd into the new model). The
; <data_func> helpers live in content/data/functions/01.rd; the cards
; (axe/pickaxe/corpus*/log/stick/stone + the tiles) in content/data/cards/.
; @input is a guard-clause predicate (0 ret = match); @output is a sys.time
; timeline: acquire holds at t=0, mutate + release at t=10. The old `use`/`claim`
; map to can_claim/set_use|set_claim, `share` to can_borrow/set_share; `destroy`
; → `data.dead inc`; `create … .inventory` → `^macro_zone` (surface 1 = the
; owner's inventory) + `^create`; the progress bar is `start_bar`/`end_bar`
; (sets/clears `data.pstatus` bit 0; style is client-side, defaults ltr).
;
; - cut_tree — fells the forest tile under the root with an axe → corpus_dim + log.
; - stick    — splits a wood source (≥2 wood) + a lit corpus with an axe into a
;              corpus_dim and 2–3 sticks (a 3rd if the source carries >2 wood).
; - break_rock — breaks a stone tile with a pickaxe, claiming a corpus → corpus_dim
;              + stone.

<recipe>
  ::cut_tree>
    @input>
      *slot.1.0.data.wood 1 ge !if 1 ret
      &slot.1.0.data $data_func::can_claim call !if 1 ret
      *slot.2.0.data.corpus_lit 1 ge !if 1 ret
      &slot.2.0.data $data_func::can_claim call !if 1 ret
      $card::axe *slot.2.0.owner.slot.2.0.def_id eq !if 1 ret
      &slot.2.0.owner.slot.2.0.data $data_func::can_borrow call !if 1 ret
      0 ret

    @output>
      0 &sys.time set
      &slot.1.0.data $data_func::set_use call drop
      &slot.2.0.data $data_func::set_claim call drop
      &slot.2.0.data $data_func::start_bar call drop
      &slot.2.0.owner.slot.2.0.data $data_func::set_share call drop
      10 &sys.time set
      &slot.2.0.data $data_func::end_bar call drop
      &slot.2.0.data.dead inc
      &slot.1.0.data.wood dec
      &slot.2.0.owner 1 0 0 ^macro_zone call &macro_zone set
      *macro_zone 0 0 &slot.2.0.owner $card::corpus_dim ^create call drop
      *macro_zone 0 0 &slot.2.0.owner        $card::log ^create call drop
      &slot.1.0.data $data_func::release_use call drop
      &slot.2.0.data $data_func::release_claim call drop
      &slot.2.0.owner.slot.2.0.data $data_func::release_share call drop

  ; A wood source (≥2 wood) on the bottom stack + a lit corpus, split with the
  ; actor's axe into a corpus_dim and 2–3 sticks (a 3rd if the source carries >2
  ; wood). The source + corpus are both consumed; the actor shares the axe.
  ::stick>
    @input>
      *slot.3.0.data.wood 2 ge !if 1 ret
      &slot.3.0.data $data_func::can_claim call !if 1 ret
      *slot.3.1.data.corpus_lit 1 ge !if 1 ret
      &slot.3.1.data $data_func::can_claim call !if 1 ret
      $card::axe *slot.3.0.owner.slot.2.0.def_id eq !if 1 ret
      &slot.3.0.owner.slot.2.0.data $data_func::can_borrow call !if 1 ret
      0 ret

    @output>
      0 &sys.time set
      &slot.3.0.data $data_func::set_use call drop
      &slot.3.1.data $data_func::set_claim call drop
      &slot.3.1.data $data_func::start_bar call drop
      &slot.3.0.owner.slot.2.0.data $data_func::set_share call drop
      10 &sys.time set
      &slot.3.1.data $data_func::end_bar call drop
      *slot.3.0.data.wood &w set
      &slot.3.0.data.dead inc
      &slot.3.1.data.dead inc
      &slot.3.1.owner 1 0 0 ^macro_zone call &macro_zone set
      *macro_zone 0 0 &slot.3.1.owner $card::corpus_dim ^create call drop
      *w 2 gt if *macro_zone 0 0 &slot.3.1.owner $card::stick ^create call drop
      *macro_zone 0 0 &slot.3.1.owner $card::stick ^create call drop
      *macro_zone 0 0 &slot.3.1.owner $card::stick ^create call drop
      &slot.3.0.data $data_func::release_use call drop
      &slot.3.1.data $data_func::release_claim call drop
      &slot.3.0.owner.slot.2.0.data $data_func::release_share call drop

  ; A stone tile under the root, broken with a pickaxe while claiming a corpus →
  ; a corpus_dim + a stone into the actor's inventory; the tile loses one stone.
  ::break_rock>
    @input>
      *slot.1.0.data.stone 1 ge !if 1 ret
      &slot.1.0.data $data_func::can_claim call !if 1 ret
      $card::corpus *slot.2.0.def_id eq !if 1 ret
      &slot.2.0.data $data_func::can_claim call !if 1 ret
      $card::pickaxe *slot.2.0.owner.slot.2.0.def_id eq !if 1 ret
      &slot.2.0.owner.slot.2.0.data $data_func::can_borrow call !if 1 ret
      0 ret

    @output>
      0 &sys.time set
      &slot.1.0.data $data_func::set_use call drop
      &slot.2.0.data $data_func::set_claim call drop
      &slot.2.0.data $data_func::start_bar call drop
      &slot.2.0.owner.slot.2.0.data $data_func::set_share call drop
      10 &sys.time set
      &slot.2.0.data $data_func::end_bar call drop
      &slot.2.0.data.dead inc
      &slot.1.0.data.stone dec
      &slot.2.0.owner 1 0 0 ^macro_zone call &macro_zone set
      *macro_zone 0 0 &slot.2.0.owner $card::corpus_dim ^create call drop
      *macro_zone 0 0 &slot.2.0.owner      $card::stone ^create call drop
      &slot.1.0.data $data_func::release_use call drop
      &slot.2.0.data $data_func::release_claim call drop
      &slot.2.0.owner.slot.2.0.data $data_func::release_share call drop
