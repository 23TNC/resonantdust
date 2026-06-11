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
