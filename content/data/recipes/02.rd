<data_func>
  ::aspect_flags>
    pop &a set
    3 &a.claim stock
    3 &a.borrow stock
    2 &a.touch.user stock
    2 &a.touch.server stock
    3 &a.pos_hold stock
    3 &a.dead stock
    2 &a.pstyle stock
    0 ret

  ::aspect_stack_tile>
    pop &a set
    0 &a.stack.hosts set
    2 &a.stack.joins set
    0 ret
  ::aspect_stack_rect>
    pop &a set
    14 &a.stack.hosts set
    12 &a.stack.joins set
    0 ret

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

<card>
  ::axe>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        &data $data_func::aspect_stack_rect call drop
        requisite &data.type set
  ::corpus>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        &data $data_func::aspect_stack_rect call drop
        faculty &data.type set
        1 &data.corpus_lit set
  ::log>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        &data $data_func::aspect_stack_rect call drop
        requisite &data.type set
        2 &data.fuel set
        2 &data.wood set

  ::forest>
    :data>
      @define>
        2 &data.pine stock
        2 &data.flora stock
        &data $data_func::aspect_flags call drop
        &data $data_func::aspect_stack_tile call drop
        ; only TWO stock slots store per tile (packed u16 = def|stock0|stock1),
        ; mapped positionally to these declarations. Forest carries pine+flora;
        ; a 3rd aspect (e.g. stone) could never be stored or rendered, so don't
        ; declare one. Stone is a mountain/desert aspect, not a forest one.
        tile &data.type set
        30   &data.cost set
      @init>
        ; scatter maps `input` from the band [lo,hi] onto the slot range, rounds,
        ; and jitters ±1 by ^seed. pine uses *seed, flora *seed+7 (decorrelated).
        ;
        ; PINE GROVES: pine density follows the fine-scale `cluster` mask (a ~7-cell
        ; noise channel, finer than any climate axis), scattered 0..max — so a forest
        ; grows as GROVES (dense cluster centres) fading to CLEARINGS (low cluster →
        ; 0), not a tree on every tile. The earlier coarse `aether` gate (1/15) made
        ; ~15-tile all-or-nothing patches — too big; `cluster` (1/7) gives groves a
        ; few cells across. The rarity tier sets the grove's MAX density; the cluster
        ; band [lo,hi] shifts the clump/clearing balance (raise `lo` for more
        ; clearings, widen for softer edges). flora (undergrowth) follows humidity
        ; UNgated, so clearings keep their grass/leaf cover.
        ^biome call &biome set
        ^seed call &seed set

        *biome.rarity 0 10 within !if :r10 goto
          0 1 &data.pine  range
          &data.pine  *biome.cluster 48 88 *seed scatter
          0 2 &data.flora range
          &data.flora *biome.humidity 40 85 *seed 7 add scatter
          0 ret

        :r10>
        *biome.rarity 10 20 within !if :r20 goto
          0 2 &data.pine  range
          &data.pine  *biome.cluster 48 88 *seed scatter
          0 1 &data.flora range
          &data.flora *biome.humidity 40 85 *seed 7 add scatter
          0 ret

        :r20>
        *biome.rarity 20 30 within !if :def goto
          0 2 &data.pine  range
          &data.pine  *biome.cluster 48 88 *seed scatter
          0 2 &data.flora range
          &data.flora *biome.humidity 55 80 *seed 7 add scatter
          0 ret

        :def>
        0 2 &data.pine  range
        &data.pine  *biome.cluster 48 88 *seed scatter
        0 1 &data.flora range
        &data.flora *biome.humidity 50 80 *seed 7 add scatter


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