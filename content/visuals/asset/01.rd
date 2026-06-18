; content/visuals/asset/01.rd
; Asset packs — render config for sprite art. Each ::pack names the texture's
; `"category` + default `"object` (string literals via the `"` sigil) plus render
; params: `size` = native px; `scale` = a min/max envelope in HUNDREDTHS (`80 100`
; = 0.8..1.0); `anchor` = pivot `{x,y}` via `vec2` (`50 50` = center). Defaults
; (scale 100/100, anchor 50/50, index 0 = seed-picked, part 0) are omitted.
;
; Cards put `$asset::<pack>` in `&pack`; `card_face`/`tile_object` resolve the
; texture STEM with `^r2` from `*pack.category` + the object (the card's `&variant`
; if it picks a specific object in a multi-object category, else `*pack.object`)
; + host seed/faction/biome. `&index` (optional) pins a fixed variation.

<asset>
  ::pine>
    @define>
      "objects &category set
      "conifer &object set
      256 &size set
      80 90 &scale range
      50 100 &anchor vec2          ; bottom-centre: base plants on the slot, canopy spills up

  ::stone>
    @define>
      "objects &category set
      "stone &object set
      128 &size set
      50 80 &scale range
      50 50 &anchor vec2

  ::berry>
    @define>
      "objects &category set
      "berry &object set
      128 &size set
      40 50 &scale range
      50 60 &anchor vec2

  ::flora>
    @define>
      "objects &category set
      "flora &object set
      128 &size set
      50 60 &scale range
      50 60 &anchor vec2

  ::soul>
    @define>
      "soul &category set
      "human &object set
      256 &size set

  ; soul_white / soul_offline kept for existing card refs — both resolve to the
  ; soul category; the palette that was baked into the old per-colour packs is now
  ; the host FACTION (resonant=1/chord=2/chorus=3), so they share one object.
  ::soul_white>
    @define>
      "soul &category set
      "human &object set
      256 &size set

  ::soul_offline>
    @define>
      "soul &category set
      "human &object set
      256 &size set

  ::requisite>
    @define>
      "requisite &category set
      "log &object set            ; default; cards pick the item via &variant
      128 &size set

  ::dust>
    @define>
      "requisite &category set
      "dust &object set
      128 &size set

  ::reliquary>
    @define>
      "requisite &category set
      "reliquary &object set
      128 &size set

  ::alter>
    @define>
      "structure &category set
      "alter &object set
      256 &size set
      50 75 &anchor vec2

  ::fountain>
    @define>
      "structure &category set
      "fountain &object set
      128 &size set

  ::table_slab>
    @define>
      "structure &category set
      "table_slab &object set
      128 &size set

  ; buildings + blueprint kept for existing card refs; their art isn't in the
  ; normalized tree yet, so they resolve empty (white) until regenerated.
  ::nd_furnace>
    @define>
      "structure &category set
      "nd_furnace &object set
      256 &size set

  ::workbench>
    @define>
      "structure &category set
      "workbench &object set
      256 &size set

  ::blueprint>
    @define>
      "structure &category set
      "nd_furnace &object set
      128 &size set

  ::concrete>
    @define>
      "tiles &category set
      "concrete &object set
      256 &size set

  ; Ground texture for grassy tiles (forest/plains). Set as a tile's `&ground`
  ; pack; `hex_body` resolves it via `^r2` and the view clips it to the hex.
  ; `grass_hex` (vs square `grass`) is authored hex-shaped, so its normal map
  ; reads correctly at the hex edges — a square normal clipped to a hex looks off.
  ::grass>
    @define>
      "tiles &category set
      "grass_hex &object set
      256 &size set

  ::symbols>
    @define>
      "symbols &category set
      "anima &object set          ; default; cards pick the glyph via &variant
      128 &size set
