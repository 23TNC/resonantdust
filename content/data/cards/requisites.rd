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
        requisite &data.type set
        2 &data.fuel set
        2 &data.wood set
        14 &data.stack_hosts set
        6 &data.stack_joins set


  ::stick>
    :data>
      @define>
        requisite &data.type set
        1 &data.fuel set
        1 &data.wood set

  ::stone>
    :data>
      @define>
        requisite &data.type set

  ::dust>
    :data>
      @define>
        requisite &data.type set
        1 &data.aether set
        14 &data.stack_hosts set
        4 &data.stack_joins set

  ; Stacking-resolver test card: hosts NO stacks (0b0000), joins top+bottom
  ; (0b1100=12). Used by the harness stack tests — a leaf that caps a stack and
  ; forces drop-inversion (drop log onto test_dust → test_dust re-roots onto log).
  ::test_dust>
    :data>
      @define>
        requisite &data.type set
        1 &data.aether set
        0 &data.stack_hosts set
        12 &data.stack_joins set

  ::food>
    :data>
      @define>
        requisite &data.type set
        1 &data.food set

  ::reliquary>
    :data>
      @define>
        requisite &data.type set
        1 &data.anima set

  ::corpse>
    :data>
      @define>
        requisite &data.type set
        1 &data.corpse set
        1 &data.inventory set

  ::corpse_chorus>
    :data>
      @define>
        requisite &data.type set
        1 &data.corpse set
        1 &data.inventory set
        1 &data.chorus set

  ::corpse_chord>
    :data>
      @define>
        requisite &data.type set
        1 &data.corpse set
        1 &data.inventory set
        1 &data.chord set

  ::corpse_resonance>
    :data>
      @define>
        requisite &data.type set
        1 &data.corpse set
        1 &data.inventory set
        1 &data.resonance set

  ::axe>
    :data>
      @define>
        requisite &data.type set

  ::pickaxe>
    :data>
      @define>
        requisite &data.type set

  ; Test card for the per-card stock model: an 8-bit `progress` counter in stock
  ; (bits 0-7), seeded to 1 by its `@define` default (proves spawn-from-define).
  ; Driven by the `prime` recipe (read + increment) up to 3. Validates that a
  ; freshly-spawned card carries its stock default AND that recipes read/write a
  ; card's per-instance stock u32.
  ::tally>
    :data>
      @define>
        requisite &data.type set
        8 &data.progress stock
        1 &data.progress set

  ; `as` handle-binding test trio (see the `forge` recipe). `anvil` is the
  ; root-only marker: a 1-bit `forged` flag (default 0) the recipe sets to 1 so it
  ; fires exactly once. `widget` is the card `forge` creates + binds `as h`, then
  ; folds its progress stock (default 1) up to 4 — proving same-card stock folds
  ; into the Create row. `pip` is the inert child nested into the widget's
  ; inventory — its owner_id resolving to the widget's minted id proves the shard
  ; tag → id resolution.
  ::anvil>
    :data>
      @define>
        requisite &data.type set
        1 &data.forged stock
        0 &data.forged set
  ::widget>
    :data>
      @define>
        requisite &data.type set
        8 &data.progress stock
        1 &data.progress set
  ::pip>
    :data>
      @define>
        requisite &data.type set
