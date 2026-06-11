; content/data/cards/requisites.card
; Type `requisite` (generic rect). :data = static aspects; :visuals sets the
; shape (generic), colours, and the art source (&pack + &variant), then calls
; $functions::rect_card to build the body/title/art prims. The requisite pack is
; a variant LUT ($asset::requisite, variant = log/stick/…); the corpse cards use
; the single-sprite soul_offline pack (no variant).
<card>
  ::log>
    :data>
      @define>
        requisite &aspect.type set
        2 &aspect.fuel set
        2 &aspect.wood set
        12 &aspect.stack_hosts set
        6 &aspect.stack_joins set


  ::stick>
    :data>
      @define>
        requisite &aspect.type set
        1 &aspect.fuel set
        1 &aspect.wood set

  ::stone>
    :data>
      @define>
        requisite &aspect.type set

  ::dust>
    :data>
      @define>
        requisite &aspect.type set
        1 &aspect.aether set

  ; Stacking-resolver test card: hosts NO stacks (0b0000), joins top+bottom
  ; (0b1100=12). Used by the harness stack tests — a leaf that caps a stack and
  ; forces drop-inversion (drop log onto test_dust → test_dust re-roots onto log).
  ::test_dust>
    :data>
      @define>
        requisite &aspect.type set
        1 &aspect.aether set
        0 &aspect.stack_hosts set
        12 &aspect.stack_joins set

  ::food>
    :data>
      @define>
        requisite &aspect.type set
        1 &aspect.food set

  ::reliquary>
    :data>
      @define>
        requisite &aspect.type set
        1 &aspect.anima set

  ::corpse>
    :data>
      @define>
        requisite &aspect.type set
        1 &aspect.corpse set
        1 &aspect.inventory set

  ::corpse_chorus>
    :data>
      @define>
        requisite &aspect.type set
        1 &aspect.corpse set
        1 &aspect.inventory set
        1 &aspect.chorus set

  ::corpse_chord>
    :data>
      @define>
        requisite &aspect.type set
        1 &aspect.corpse set
        1 &aspect.inventory set
        1 &aspect.chord set

  ::corpse_resonance>
    :data>
      @define>
        requisite &aspect.type set
        1 &aspect.corpse set
        1 &aspect.inventory set
        1 &aspect.resonance set

  ::axe>
    :data>
      @define>
        requisite &aspect.type set

  ::pickaxe>
    :data>
      @define>
        requisite &aspect.type set

  ; Test card for the per-card stock model: an 8-bit `progress` counter in stock
  ; (bits 0-7), seeded to 1 by its `@define` default (proves spawn-from-define).
  ; Driven by the `prime` recipe (read + increment) up to 3. Validates that a
  ; freshly-spawned card carries its stock default AND that recipes read/write a
  ; card's per-instance stock u32.
  ::tally>
    :data>
      @define>
        requisite &aspect.type set
        8 &aspect.progress stock
        1 &aspect.progress set
