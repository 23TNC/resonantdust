<recipe>
  ::triple_corpus>
    @input>
      $card::corpus *slot.2.0.def_id eq if &slot.2.0 use
      $card::corpus *slot.2.1.def_id eq if &slot.2.1 claim
      $card::corpus *slot.2.2.def_id eq if &slot.2.2 claim

    @output>
      10 &sys.duration set
      rtl &slot.2.0.style set
      &slot.2.0 destroy

  ::dread_remover>
    @input>
      $card::dread *slot.2.0.def_id eq if &slot.2.0 use
      $card::dread *slot.2.1.def_id eq if &slot.2.1 claim

    @output>
      10 &sys.duration set
      ltr &slot.2.0.style set
      &slot.2.0 destroy
      &slot.2.1 destroy

  ::corpus_dust>
    @input>
      $card::corpus *slot.0.0.def_id eq if &slot.0.0 use
      $card::dust *slot.2.0.def_id eq if &slot.2.0 claim
    
    @output>
      10 &sys.duration set
      ltr &slot.2.0.style set
      $card::food &slot.0.0.owner.inventory create

  ::corpus_b_top>
    @input>
      $card::corpus *slot.2.0.def_id eq if &slot.2.0 use
      $card::corpus *slot.2.1.def_id eq if &slot.2.1 claim

    @output>
      10 &sys.duration set
      ltr &slot.2.0.style set
      &slot.2.0 destroy
      $card::corpus_dim &slot.2.0.owner.inventory create

  ::corpus_b_bottom>
    @input>
      $card::corpus *slot.3.0.def_id eq if &slot.3.0 use
      $card::corpus *slot.3.1.def_id eq if &slot.3.1 claim

    @output>
      10 &sys.duration set
      ltr &slot.3.0.style set
      &slot.3.0 destroy
      $card::corpus &slot.3.0.owner.inventory create

  ::despair_success>
    @input>
      $card::despair *slot.0.0.def_id eq if &slot.0.0 use
      $card::dread *slot.2.0.def_id eq if &slot.2.0 claim

    @output>
      10 &sys.duration set
      ltr &slot.2.0.style set
      &slot.2.0 destroy
      &slot.0.0 destroy
      $card::corpus &slot.2.0.owner.inventory create

  ::despair_failure>
    @input>
      $card::despair *slot.0.0.def_id eq if &slot.0.0 use

    @output>
      10 &sys.duration set
      ltr &slot.0.0.style set
      &slot.0.0 destroy
      $card::dread &slot.0.0.owner.inventory create

  ; `gloom` magnet recipes — the short-window twin of despair, for the harness
  ; magnetic FAILURE test. Success mirrors despair_success; failure (fired when the
  ; 4s window lapses with no candidate) destroys the magnet + spawns a dread in the
  ; owner's inventory. Short action durations (2s) keep the test fast.
  ::gloom_success>
    @input>
      $card::gloom *slot.0.0.def_id eq if &slot.0.0 use
      $card::dread *slot.2.0.def_id eq if &slot.2.0 claim

    @output>
      2 &sys.duration set
      &slot.2.0 destroy
      &slot.0.0 destroy
      $card::corpus &slot.2.0.owner.inventory create

  ::gloom_failure>
    @input>
      $card::gloom *slot.0.0.def_id eq if &slot.0.0 use

    @output>
      2 &sys.duration set
      &slot.0.0 destroy
      $card::dread &slot.0.0.owner.inventory create

  ::strike_success>
    @input>
      $card::strike *slot.0.0.def_id eq if &slot.0.0 use
      $card::corpus *slot.2.0.def_id eq if &slot.2.0 claim
      $card::corpus *slot.2.1.def_id eq if &slot.2.1 claim
      $card::corpus *slot.2.2.def_id eq if &slot.2.2 claim

    @output>
      10 &sys.duration set
      ltr &slot.0.0.style set
      &slot.2.0 destroy
      &slot.2.1 destroy
      &slot.2.2 destroy
      &slot.0.0 destroy
      $card::corpus_dim &slot.2.0.owner.inventory create
      $card::corpus_dim &slot.2.0.owner.inventory create
      $card::corpus_dim &slot.2.0.owner.inventory create

  ::strike_failure>
    @input>
      $card::strike *slot.0.0.def_id eq if &slot.0.0 use

    @output>
      10 &sys.duration set
      ltr &slot.0.0.style set
      &slot.0.0 destroy
      $card::dread &slot.0.0.owner.inventory create

  ::corpus_dim>
    @input>
      $card::corpus_dim *slot.0.0.def_id eq if &slot.0.0 use

    @output>
      30 &sys.duration set
      ltr &slot.0.0.style set
      &slot.0.0 destroy
      $card::corpus &slot.0.0.owner.inventory create

  ::fleeting>
    @input>
      *slot.0.0.aspect.fleeting 1 ge if &slot.0.0 borrow

    @output>
      *slot.0.0.aspect.fleeting &var.0 set

      5 &sys.duration set
      *var.0 2 ge if 10 &sys.duration set
      *var.0 3 ge if 15 &sys.duration set
      *var.0 4 ge if 20 &sys.duration set

      rtl &slot.0.0.style set
      &slot.0.0 destroy

  ; Stock read/write validation: a ROOT-ONLY recipe (operates on the root card,
  ; not a stack slot). While the tally's progress (per-card stock) is below 3,
  ; increment it. Reads `*slot.0.0.aspect.progress` (decoded from the card's stock
  ; u32) and writes it back via `inc` (→ Effect::Stock → SetCardStock).
  ; Self-terminating at 3.
  ::prime>
    @input>
      $card::tally *slot.0.0.def_id eq *slot.0.0.aspect.progress 3 lt and if &slot.0.0 use

    @output>
      &slot.0.0.aspect.progress inc

  ; `as` handle-binding validation: a ROOT-ONLY recipe firing once on an `anvil`
  ; (gated `forged < 1`, set to 1 to self-terminate). Creates a `widget` into the
  ; owner's inventory, binds it `&h as`, folds its progress stock 1→4 (same-card
  ; set, folds into the Create — no SetCardStock), then nests a `pip` into the
  ; widget's own inventory (owner carried as a tag the shard resolves to the
  ; minted widget id).
  ::forge>
    @input>
      $card::anvil *slot.0.0.def_id eq *slot.0.0.aspect.forged 1 lt and if &slot.0.0 use

    @output>
      $card::widget &slot.0.0.owner.inventory create &h as
      4 &h.aspect.progress set
      $card::pip &h.inventory create
      1 &slot.0.0.aspect.forged set

  ; Blueprint assembly: a `blueprint_chord_soul` (root) fed `dust` (co-located on
  ; its tile) assembles a `chord_soul` AT the blueprint's world cell, sends the
  ; reusable blueprint back to the player's inventory, and consumes the dust.
  ; Exercises the new `create … .location` (exact-cell spawn) + `move` verbs.
  ::chord_soul_assemble>
    @input>
      $card::blueprint_chord_soul *slot.0.0.def_id eq if &slot.0.0 use
      $card::dust *slot.2.0.def_id eq if &slot.2.0 claim

    @output>
      10 &sys.duration set
      ltr &slot.2.0.style set
      $card::chord_soul &slot.0.0.location create
      &slot.0.0 &slot.0.0.owner.inventory move
      &slot.2.0 destroy
