; content/data/cards/status.card
; Port of cards/data/status/mental.json — revery (rect) + event (hex) cards.
; Magnetic cards: a server-side magnetic player owns them, anchors within
; `magnetic.radius`, and within `magnetic.duration` pulls in-range cards onto the
; magnet to complete `magnetic.recipe` (success) or fires `magnetic.failure`.

<card>
  ::dread>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        revery &data.type set

  ::test>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        event &data.type set
        2 &data.stack_joins set

  ::despair>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        event &data.type set
        2 &data.stack_joins set
        12 &data.stack_hosts set
        $recipe::despair_success &magnetic.recipe set
        $recipe::despair_failure &magnetic.failure set
        3 &magnetic.radius set
        60000 &magnetic.duration set

  ::strike>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        event &data.type set
        2 &data.stack_joins set
        12 &data.stack_hosts set
        $recipe::strike_success &magnetic.recipe set
        $recipe::strike_failure &magnetic.failure set
        3 &magnetic.radius set
        60000 &magnetic.duration set

  ; `gloom` is a SHORT-window magnet (4s) for harness coverage of the magnetic
  ; FAILURE/deadline path — placed with no candidate in range, its window lapses
  ; fast and `gloom_failure` fires (vs `despair`'s 60s gameplay window). Same shape
  ; as despair otherwise.
  ::gloom>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        event &data.type set
        2 &data.stack_joins set
        12 &data.stack_hosts set
        $recipe::gloom_success &magnetic.recipe set
        $recipe::gloom_failure &magnetic.failure set
        3 &magnetic.radius set
        4000 &magnetic.duration set
