; content/data/recipes/02.rd
; cut_tree — the reference recipe for the new model. The <data_func> helpers live
; in content/data/functions/01.rd; the cards (axe/corpus_dim/log/forest) in
; content/data/cards/. @input is a guard-clause predicate (0 ret = match); @output
; is a sys.time timeline: acquire holds at t=0, mutate + release at t=10.
;
; Fells a tree (the forest tile under the root) with an axe: the actor holds the
; tile (use), claims a lit corpus, shares the axe, then at t=10 marks the corpus
; dead, decrements the tile's wood, and spawns a corpus_dim + a log into the
; actor's inventory.

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
      &slot.2.0.owner.slot.2.0.data $data_func::set_share call drop
      10 &sys.time set
      1 &slot.2.0.data.pstyle set
      &slot.2.0.data.dead inc
      &slot.1.0.data.wood dec
      &slot.2.0.owner 1 0 0 ^macro_zone call &macro_zone set
      *macro_zone $card::corpus_dim &slot.2.0.owner ^create call drop
      *macro_zone $card::log        &slot.2.0.owner ^create call drop
      &slot.1.0.data $data_func::release_use call drop
      &slot.2.0.data $data_func::release_claim call drop
      &slot.2.0.owner.slot.2.0.data $data_func::release_share call drop
