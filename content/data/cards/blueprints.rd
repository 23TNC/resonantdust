; content/data/cards/blueprints.card
; Type `blueprint` (generic rect). Art = the blueprint pack, nd_furnace variant.

<card>
  ::blueprint_nd_furnace>
    :data>
      @define>
        blueprint &aspect.type set

  ; A reusable blueprint: placed in the world and fed dust (stacked on top of it),
  ; it assembles a `chord_soul` at its location and returns to the player's
  ; inventory (recipe `chord_soul_assemble`). Hosts the top stack (bit 2) so dust
  ; can be dropped onto it → bound at the recipe's `slot.2.0`.
  ::blueprint_chord_soul>
    :data>
      @define>
        blueprint &aspect.type set
        4 &aspect.stack_hosts set
