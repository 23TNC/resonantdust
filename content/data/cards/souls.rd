; content/data/cards/souls.card
; Type `soul` (generic rect). Portrait = the soul pack (soul_white / soul), a
; single-sprite pack with no variant — so rect_card leaves the index unset and
; the client picks the portrait by seed (the card id), giving each soul its own
; face. (The resource-meter overlay is still engine chrome, not yet a prim.)
<card>
  ::human>
    :data>
      @define>
        soul &aspect.type set
        2 &aspect.soul set
        1 &aspect.builder set
        12 &aspect.move_speed set
        4 &aspect.inventory set
        2 &aspect.anchor_active set
        6 &aspect.anchor_hot set
        12 &aspect.anchor_warm set
        20 &aspect.anchor_cold set

  ::human_builder>
    :data>
      @define>
        soul &aspect.type set
        2 &aspect.soul set
        1 &aspect.builder set
        10 &aspect.move_speed set
        1 &aspect.inventory set
        2 &aspect.anchor_active set
        6 &aspect.anchor_hot set
        12 &aspect.anchor_warm set
        20 &aspect.anchor_cold set

  ::player_soul>
    :data>
      @define>
        soul &aspect.type set
        ; Pin the def_id to the top of the soul type → packed_definition 0xFFFF
        ; (reserved player-soul range 0xFFF0..=0xFFFF). The player_soul is then
        ; identified by definition alone — no `player_owned` flag — and the roster
        ; subscription filters `packed_definition >= 0xFFF0`.
        4095 &aspect.def_id set
        1 &aspect.soul set
        1 &aspect.inventory set
