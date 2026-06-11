<recipe>
  ::chorus_attune>
    @input>
      $card::alter *slot.1.0.def_id eq if &slot.1.0 use
      *slot.2.0.aspect.corpse 1 ge if &slot.2.0 claim

    @output>
      10 &sys.duration set
      ltr &slot.2.0.style set
      $faction.chorus &slot.1.0.owner.aspect.faction set
      &slot.2.0 destroy
