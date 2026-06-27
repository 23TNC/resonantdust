; content/data/cards/souls.card
; Type `soul` (generic rect). Portrait = the soul pack (soul_white / soul), a
; single-sprite pack with no variant — so rect_card leaves the index unset and
; the client picks the portrait by seed (the card id), giving each soul its own
; face. (The resource-meter overlay is still engine chrome, not yet a prim.)
<card>
  ::human>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        soul &data.type set
        2 &data.soul set
        1 &data.builder set
        12 &data.move_speed set
        4 &data.inventory set
        2 &data.anchor_active set
        6 &data.anchor_hot set
        12 &data.anchor_warm set
        20 &data.anchor_cold set

  ::human_builder>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        soul &data.type set
        2 &data.soul set
        1 &data.builder set
        10 &data.move_speed set
        1 &data.inventory set
        2 &data.anchor_active set
        6 &data.anchor_hot set
        12 &data.anchor_warm set
        20 &data.anchor_cold set

  ::player_soul>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        soul &data.type set
        ; Pin the def_id to the top of the soul type → packed_definition 0xFFFF
        ; (reserved player-soul range 0xFFF0..=0xFFFF). The player_soul is then
        ; identified by definition alone — no `player_owned` flag — and the roster
        ; subscription filters `packed_definition >= 0xFFF0`.
        4095 &data.def_id set
        1 &data.soul set
        3 &data.inventory stock
        2 &data.inventory set

  ; A world soul carrying a `chord` — the product of the blueprint_chord_soul +
  ; dust assembly recipe (`chord_soul_assemble`). A plain soul like `human` plus a
  ; `chord` marker; created in the world AT the blueprint's location.
  ::chord_soul>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        soul &data.type set
        2 &data.soul set
        1 &data.chord set
        10 &data.move_speed set
        2 &data.inventory set
        2 &data.anchor_active set
        6 &data.anchor_hot set
        12 &data.anchor_warm set
        20 &data.anchor_cold set
