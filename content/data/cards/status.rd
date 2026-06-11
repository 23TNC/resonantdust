; content/data/cards/status.card
; Port of cards/data/status/mental.json — revery (rect) + event (hex) cards.
; Magnetic cards: a server-side magnetic player owns them, anchors within
; `magnetic.radius`, and within `magnetic.duration` pulls in-range cards onto the
; magnet to complete `magnetic.recipe` (success) or fires `magnetic.failure`.

<card>
  ::dread>
    :data>
      @define>
        revery &aspect.type set

  ::test>
    :data>
      @define>
        event &aspect.type set
        2 &aspect.stack_joins set

  ::despair>
    :data>
      @define>
        event &aspect.type set
        2 &aspect.stack_joins set
        12 &aspect.stack_hosts set
        $recipe::despair_success &magnetic.recipe set
        $recipe::despair_failure &magnetic.failure set
        3 &magnetic.radius set
        60000 &magnetic.duration set

  ::strike>
    :data>
      @define>
        event &aspect.type set
        2 &aspect.stack_joins set
        12 &aspect.stack_hosts set
        $recipe::strike_success &magnetic.recipe set
        $recipe::strike_failure &magnetic.failure set
        3 &magnetic.radius set
        60000 &magnetic.duration set
