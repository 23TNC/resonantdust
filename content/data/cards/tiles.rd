; content/data/cards/tiles.card
; Type `tile` — per-hex terrain. Port of cards/data/tiles/*.json.
;
; Terrains with rarity tiers (forest/plains/desert/mountain) are FOLDED into a
; single card each: @init buckets on *biome.rarity (0-10 / 10-20 / 20-30 / def)
; pick which stock aspects exist, `within if .. range` climate-gates them, and
; :norm normalizes each from its biome axis. Folding keeps one representative
; style per terrain (per-tier tints are lost — accepted).
;
; Rendering (all generic `&prims`): terrain tiles call $functions::ring_prims —
; a hex body + a sprite per stock object, art pulled from the <aspect> registry
; (`*rec.art`). Buildings call $functions::tile_object (hex body + one placeable
; from &pack). empty/concrete are body-only (ring_prims with no stock). Ground
; textures (concrete/alter/fountains/table) are deferred — solid colour for now
; (needs a hex-clipped textured fill).

<card>
  ::inventory>
    :data>
      @define>
        tile &aspect.type set
        2 &aspect.stack_joins set
        10 &aspect.cost set

  ::empty>
    :data>
      @define>
        tile &aspect.type set
        2 &aspect.stack_joins set
        10 &aspect.cost set

  ::concrete>
    :data>
      @define>
        tile &aspect.type set
        2 &aspect.stack_joins set
        10 &aspect.cost set

  ::forest>
    :data>
      @define>
        ; only TWO stock slots store per tile (packed u16 = def|stock0|stock1),
        ; mapped positionally to these declarations. Forest carries pine+flora;
        ; a 3rd aspect (e.g. stone) could never be stored or rendered, so don't
        ; declare one. Stone is a mountain/desert aspect, not a forest one.
        2    &aspect.pine stock
        2    &aspect.flora stock
        tile &aspect.type set
        2 &aspect.stack_joins set
        30   &aspect.cost set
      @init>
        ; scatter maps `input` from the band [lo,hi] onto the slot range, rounds,
        ; and jitters ±1 by ^seed. pine uses *seed, flora *seed+7 (decorrelated).
        ;
        ; PINE GROVES: pine density follows the fine-scale `cluster` mask (a ~7-cell
        ; noise channel, finer than any climate axis), scattered 0..max — so a forest
        ; grows as GROVES (dense cluster centres) fading to CLEARINGS (low cluster →
        ; 0), not a tree on every tile. The earlier coarse `aether` gate (1/15) made
        ; ~15-tile all-or-nothing patches — too big; `cluster` (1/7) gives groves a
        ; few cells across. The rarity tier sets the grove's MAX density; the cluster
        ; band [lo,hi] shifts the clump/clearing balance (raise `lo` for more
        ; clearings, widen for softer edges). flora (undergrowth) follows humidity
        ; UNgated, so clearings keep their grass/leaf cover.
        ^biome call &biome set
        ^seed call &seed set

        *biome.rarity 0 10 within !if :r10 goto
          0 1 &aspect.pine  range
          &aspect.pine  *biome.cluster 48 88 *seed scatter
          0 2 &aspect.flora range
          &aspect.flora *biome.humidity 40 85 *seed 7 add scatter
          0 ret

        :r10>
        *biome.rarity 10 20 within !if :r20 goto
          0 2 &aspect.pine  range
          &aspect.pine  *biome.cluster 48 88 *seed scatter
          0 1 &aspect.flora range
          &aspect.flora *biome.humidity 40 85 *seed 7 add scatter
          0 ret

        :r20>
        *biome.rarity 20 30 within !if :def goto
          0 2 &aspect.pine  range
          &aspect.pine  *biome.cluster 48 88 *seed scatter
          0 2 &aspect.flora range
          &aspect.flora *biome.humidity 55 80 *seed 7 add scatter
          0 ret

        :def>
        0 2 &aspect.pine  range
        &aspect.pine  *biome.cluster 48 88 *seed scatter
        0 1 &aspect.flora range
        &aspect.flora *biome.humidity 50 80 *seed 7 add scatter

  ::plains>
    :data>
      @define>
        2 &aspect.flora stock
        2 &aspect.berry stock
        tile &aspect.type set
        2 &aspect.stack_joins set
        5 &aspect.cost set
      @init>
        ^biome call &biome set

        *biome.rarity 0 10 within !if :r10 goto
        0 1 &aspect.flora range
        0 1 &aspect.berry range
        :norm goto

        :r10>
        *biome.rarity 10 20 within !if :r20 goto
        0 2 &aspect.flora range
        0 1 &aspect.berry range
        :norm goto

        :r20>
        *biome.rarity 20 30 within !if :def goto
        *biome.humidity 30 50 within if 0 3 &aspect.berry range
        0 1 &aspect.flora range
        :norm goto

        :def>
        *biome.humidity 40 55 within if 0 3 &aspect.flora range
        *biome.humidity 40 55 within if 0 2 &aspect.berry range

        :norm>
        &aspect.flora *biome.humidity normalize
        &aspect.berry *biome.humidity normalize

  ::desert>
    :data>
      @define>
        2    &aspect.stone stock
        1    &aspect.flora stock
        2    &aspect.water stock
        2    &aspect.food  stock
        2    &aspect.fuel  stock
        tile &aspect.type  set
        12   &aspect.cost  set
      @init>
        ^biome call &biome set

        *biome.rarity 0 10 within !if :r10 goto
        *biome.elevation 30 65 within if 0 1 &aspect.stone range
        *biome.humidity 0 30 within if 0 1 &aspect.flora range
        :norm goto

        :r10>
        *biome.rarity 10 20 within !if :r20 goto
        *biome.elevation 30 65 within if 0 2 &aspect.stone range
        *biome.humidity 0 25 within if 0 1 &aspect.flora range
        :norm goto

        :r20>
        *biome.rarity 20 30 within !if :def goto
        *biome.humidity 15 30 within if 0 3 &aspect.water range
        *biome.humidity 15 30 within if 0 2 &aspect.food range
        :norm goto

        :def>
        *biome.elevation 30 55 within if 0 3 &aspect.stone range
        *biome.temperature 80 100 within if 0 2 &aspect.fuel range

        :norm>
        &aspect.stone *biome.elevation normalize
        &aspect.flora *biome.humidity normalize
        &aspect.water *biome.humidity normalize
        &aspect.food *biome.humidity normalize
        &aspect.fuel *biome.temperature normalize

  ::mountain>
    :data>
      @define>
        2 &aspect.stone stock
        1 &aspect.flora stock
        2 &aspect.metal stock
        tile &aspect.type set
        2 &aspect.stack_joins set
        15 &aspect.cost set
      @init>
        ^biome call &biome set
        
        *biome.rarity 0 10 within !if :r10 goto
        *biome.elevation 70 100 within if 0 2 &aspect.stone range
        0 1 &aspect.flora range
        :norm goto

        :r10>
        *biome.rarity 10 20 within !if :r20 goto
        *biome.elevation 75 100 within if 0 2 &aspect.stone range
        *biome.elevation 75 100 within if 0 1 &aspect.metal range
        :norm goto

        :r20>
        *biome.rarity 20 30 within !if :def goto
        *biome.elevation 80 100 within if 0 3 &aspect.stone range
        *biome.elevation 80 100 within if 0 2 &aspect.metal range
        :norm goto

        :def>
        *biome.elevation 90 100 within if 0 3 &aspect.stone range
        *biome.humidity 20 80 within if 0 1 &aspect.flora range
        1 &trait.height set

        :norm>
        &aspect.stone *biome.elevation normalize
        &aspect.flora *biome.humidity normalize
        &aspect.metal *biome.elevation normalize

  ::building_nd_furnace>
    :data>
      @define>
        tile &aspect.type set
        2 &aspect.stack_joins set
        2 &aspect.fire stock
        50 &aspect.cost set

  ::building_workbench>
    :data>
      @define>
        tile &aspect.type set
        2 &aspect.stack_joins set
        2 &aspect.fire stock
        50 &aspect.cost set

  ::alter>
    :data>
      @define>
        tile &aspect.type set
        2 &aspect.stack_joins set
        1 &aspect.level set
        50 &aspect.cost set

  ::anima_fountain>
    :data>
      @define>
        tile &aspect.type set
        2 &aspect.stack_joins set
        1 &aspect.anima set
        50 &aspect.cost set

  ::aether_fountain>
    :data>
      @define>
        tile &aspect.type set
        2 &aspect.stack_joins set
        1 &aspect.aether set
        50 &aspect.cost set

  ::table>
    :data>
      @define>
        tile &aspect.type set
        2 &aspect.stack_joins set
        30 &aspect.cost set
