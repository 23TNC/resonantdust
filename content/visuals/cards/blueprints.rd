; visual facets for blueprints.rd — split out of content/data.
<card>

  ::blueprint_nd_furnace>
    :visuals>
      @define>
        $shape.generic &shape set
        #0A3D73 &color.bg set
        #0B4F8A &color.title set
        #E6F1FF &color.text set
        $asset::blueprint &pack set
        nd_furnace &variant set
      @init>
        $functions::rect_card call drop
      @update>
        $functions::rect_card call drop
      @destroy>
        $functions::rect_card call drop

  ::blueprint_chord_soul>
    :visuals>
      @define>
        $shape.generic &shape set
        #0A3D73 &color.bg set
        #0B4F8A &color.title set
        #E6F1FF &color.text set
        ; A blueprint-styled soul (soul category, `golem.blueprint` object) — the
        ; existing blueprint art; `nd_furnace` has no master in the tree. Fitting
        ; for a blueprint that assembles a chord SOUL.
        $asset::soul &pack set
        golem.blueprint &variant set
      @init>
        $functions::rect_card call drop
      @update>
        $functions::rect_card call drop
      @destroy>
        $functions::rect_card call drop
