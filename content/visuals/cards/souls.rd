; visual facets for souls.rd — split out of content/data.
<card>

  ::human>
    :visuals>
      @define>
        $shape.generic &shape set
        #a8e0e6 &color.bg set
        #ecd6aa &color.title set
        #0b1426 &color.text set
        $asset::soul_white &pack set
      @init>
        $functions::rect_card call drop
      @update>
        $functions::rect_card call drop
      @destroy>
        $functions::rect_card call drop
        $functions::card_death call drop

  ::human_builder>
    :visuals>
      @define>
        $shape.generic &shape set
        #a8e0e6 &color.bg set
        #ecd6aa &color.title set
        #0b1426 &color.text set
        $asset::soul_white &pack set
      @init>
        $functions::rect_card call drop
      @update>
        $functions::rect_card call drop
      @destroy>
        $functions::rect_card call drop
        $functions::card_death call drop

  ::player_soul>
    :visuals>
      @define>
        $shape.generic &shape set
        #4455AA &color.bg set
        #ecd6aa &color.title set
        #0b1426 &color.text set
        $asset::soul &pack set
      @init>
        $functions::rect_card call drop
      @update>
        $functions::rect_card call drop
      @destroy>
        $functions::rect_card call drop
        $functions::card_death call drop
