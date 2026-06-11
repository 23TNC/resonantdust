; visual facets for tiles.rd — split out of content/data.
<card>

  ::inventory>
    :visuals>
      @define>
        #0b1426 &color.bg set
        #0b1426 &color.title set
        #0b1426 &color.text set
      @init>
        $functions::ring_prims call drop
      @update>
        $functions::ring_prims call drop
      @destroy>
        $functions::ring_prims call drop

  ::empty>
    :visuals>
      @define>
        #0b1426 &color.bg set
        #0b1426 &color.title set
        #0b1426 &color.text set
      @init>
        $functions::ring_prims call drop
      @update>
        $functions::ring_prims call drop
      @destroy>
        $functions::ring_prims call drop

  ::concrete>
    :visuals>
      @define>
        #9b9a96 &color.bg set
        #0b1426 &color.title set
        #0b1426 &color.text set
        ; ground texture deferred — solid colour for now (needs a hex-clipped
        ; textured fill).
      @init>
        $functions::ring_prims call drop
      @update>
        $functions::ring_prims call drop
      @destroy>
        $functions::ring_prims call drop

  ::forest>
    :visuals>
      @define>
        #395C39 &color.bg set
        #2A2A2A &color.title set
        #0B1426 &color.text set
      @init>
        $functions::ring_prims call drop
      @update>
        $functions::ring_prims call drop
      @destroy>
        $functions::ring_prims call drop

  ::plains>
    :visuals>
      @define>
        #C9D75F &color.bg set
        #0b1426 &color.title set
        #0b1426 &color.text set
      @init>
        $functions::ring_prims call drop
      @update>
        $functions::ring_prims call drop
      @destroy>
        $functions::ring_prims call drop

  ::desert>
    :visuals>
      @define>
        #D4A464 &color.bg set
        #0b1426 &color.title set
        #0b1426 &color.text set
      @init>
        $functions::ring_prims call drop
      @update>
        $functions::ring_prims call drop
      @destroy>
        $functions::ring_prims call drop

  ::mountain>
    :visuals>
      @define>
        #6B6859 &color.bg set
        #0b1426 &color.title set
        #0b1426 &color.text set
      @init>
        $functions::ring_prims call drop
      @update>
        $functions::ring_prims call drop
      @destroy>
        $functions::ring_prims call drop

  ::building_nd_furnace>
    :visuals>
      @define>
        #799E50 &color.bg set
        #0b1426 &color.title set
        #0b1426 &color.text set
        $asset::nd_furnace &pack set
      @init>
        $functions::tile_object call drop
      @update>
        $functions::tile_object call drop
      @destroy>
        $functions::tile_object call drop

  ::building_workbench>
    :visuals>
      @define>
        #799E50 &color.bg set
        #0b1426 &color.title set
        #0b1426 &color.text set
        $asset::workbench &pack set
      @init>
        $functions::tile_object call drop
      @update>
        $functions::tile_object call drop
      @destroy>
        $functions::tile_object call drop

  ::alter>
    :visuals>
      @define>
        #C0A060 &color.bg set
        #0b1426 &color.title set
        #0b1426 &color.text set
        $asset::alter &pack set        ; ground texture deferred (solid colour)
      @init>
        $functions::tile_object call drop
      @update>
        $functions::tile_object call drop
      @destroy>
        $functions::tile_object call drop

  ::anima_fountain>
    :visuals>
      @define>
        #FFD966 &color.bg set
        #0b1426 &color.title set
        #0b1426 &color.text set
        $asset::fountain &pack set
        anima &variant set
      @init>
        $functions::tile_object call drop
      @update>
        $functions::tile_object call drop
      @destroy>
        $functions::tile_object call drop

  ::aether_fountain>
    :visuals>
      @define>
        #7D96E3 &color.bg set
        #0b1426 &color.title set
        #0b1426 &color.text set
        $asset::fountain &pack set
        aether &variant set
      @init>
        $functions::tile_object call drop
      @update>
        $functions::tile_object call drop
      @destroy>
        $functions::tile_object call drop

  ::table>
    :visuals>
      @define>
        #8B5E3C &color.bg set
        #0b1426 &color.title set
        #0b1426 &color.text set
        $asset::table_slab &pack set   ; ground texture deferred (solid colour)
      @init>
        $functions::tile_object call drop
      @update>
        $functions::tile_object call drop
      @destroy>
        $functions::tile_object call drop
