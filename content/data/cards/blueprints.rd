; content/data/cards/blueprints.card
; Type `blueprint` (generic rect). Art = the blueprint pack, nd_furnace variant.

<card>
  ::blueprint_nd_furnace>
    :data>
      @define>
        blueprint &aspect.type set

  ; A reusable blueprint: placed in the world and fed dust (co-located on its
  ; tile), it assembles a `chord_soul` at its location and returns to the player's
  ; inventory (recipe `chord_soul_assemble`). Mirrors `corpus`'s plain shape — the
  ; matcher binds co-located cards into the recipe's stack slots, no stack bits.
  ::blueprint_chord_soul>
    :data>
      @define>
        blueprint &aspect.type set
