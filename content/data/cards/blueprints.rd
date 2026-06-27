; content/data/cards/blueprints.card
; Type `blueprint` (generic rect). Art = the blueprint pack, nd_furnace variant.

<card>
  ::blueprint_nd_furnace>
    :data>
      @define>
        blueprint &data.type set

  ; A reusable blueprint: placed in the world and fed dust (stacked on top of it),
  ; it assembles a `chord_soul` at its location and returns to the player's
  ; inventory (recipe `chord_soul_assemble`). Standard rect host bits (0b1110 =
  ; hex+top+bottom): hex so it can rest on a world tile (the tile joins its hex
  ; stack), top so dust can be dropped onto it → bound at the recipe's `slot.2.0`.
  ::blueprint_chord_soul>
    :data>
      @define>
        blueprint &data.type set
        14 &data.stack_hosts set
