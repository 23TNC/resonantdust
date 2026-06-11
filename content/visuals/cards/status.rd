; visual facets for status.rd — split out of content/data.
<card>

  ::dread>
    :visuals>
      @define>
        $shape.generic &shape set
        #3a3a4a &color.bg set
        #ecd6aa &color.title set
        #0b1426 &color.text set
      @init>
        $functions::rect_card call drop
      @update>
        $functions::rect_card call drop
      @destroy>
        $functions::rect_card call drop

  ::test>
    :visuals>
      @define>
        $shape.generic &shape set
        #3a3a4a &color.bg set
        #2a2a3a &color.title set
        #0b1426 &color.text set
      @init>
        $functions::hex_card call drop
      @update>
        $functions::hex_card call drop
      @destroy>
        $functions::hex_card call drop

  ::despair>
    :visuals>
      @define>
        $shape.generic &shape set
        #3a3a4a &color.bg set
        #2a2a3a &color.title set
        #0b1426 &color.text set
      @init>
        $functions::hex_card call drop
      @update>
        $functions::hex_card call drop
      @destroy>
        $functions::hex_card call drop

  ::strike>
    :visuals>
      @define>
        $shape.generic &shape set
        #3a3a4a &color.bg set
        #2a2a3a &color.title set
        #0b1426 &color.text set
      @init>
        $functions::hex_card call drop
      @update>
        $functions::hex_card call drop
      @destroy>
        $functions::hex_card call drop
