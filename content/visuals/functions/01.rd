; content/data/functions/01.rd
; <globals> — shared constants the DSL + client read instead of hardcoding sizes
; in engine code. `$globals::id` resolves to the `&value` (a px size, a count,
; …). A later global can be a function of an earlier one (title_height from
; card_height). Card dimensions live here now, so the generic card sizes itself
; from content, not from RECT_CARD_* constants.
<globals>
  ::card_width>
    @define>
      72 &value set
  ::card_height>
    @define>
      96 &value set
  ; title bar is 25% of the card height — a function of card_height, not a magic
  ; number. (Was RECT_CARD_TITLE_HEIGHT = 24 = 96 * 25 / 100.)
  ::title_height>
    @define>
      $globals::card_height 25 mul 100 div &value set
  ; the BODY is the square that remains once the title strip is taken out of the
  ; total card_height — 96 - 24 = 72, so the body is 72×72 and the card (body +
  ; one title strip above OR below) stays 72×96.
  ::body_height>
    @define>
      $globals::card_height $globals::title_height sub &value set
  ; the queue/debounce bar — a thin strip along the title bar's body edge.
  ::queue_height>
    @define>
      3 &value set

  ; inventory rect cell — the slot a content card snaps into. A content card is
  ; body-centred on the snap point, but its full face is card_width × card_height
  ; (the 72 body PLUS the 24 title strip ABOVE it), so its visual centre sits half
  ; a title above the snap. The slot must surround that full face, not just the
  ; body — so the cell is the card face plus `cell_margin` on EVERY side, and the
  ; slot tile is shifted up half a title (see `rect_tile`) to re-centre on the
  ; face. cell_width/height are also the snap spacing (set client-side in
  ; `GridInventory`: GRID_W/GRID_H = CARD_* + 2·margin), so slots meet edge-to-edge
  ; with `cell_margin` visible uniformly around each card. Keep `cell_margin` in
  ; sync with `GridInventory`'s GRID_MARGIN.
  ::cell_margin>
    @define>
      8 &value set
  ::cell_width>
    @define>
      $globals::card_width $globals::cell_margin 2 mul add &value set
  ::cell_height>
    @define>
      $globals::card_height $globals::cell_margin 2 mul add &value set

  ; world hex cell — pointy-top, derived from the CARD so cards intersect the
  ; hexagon (not float in an oversized one). The hex inscribes a card-sized rect
  ; (card_width wide × card_width + 2·title_height tall = 72×120); for a pointy-
  ; top hex inscribing W×H (H>R), R = W/(2√3) + H/2 ≈ 80.78. width = √3·r,
  ; height = 2·r (matches the client WORLD_HEX_RADIUS in hexSize.ts — keep synced).
  ::hex_radius>
    @define>
      $globals::card_width 2 3 sqrt mul div $globals::card_width $globals::title_height 2 mul add 2 div add &value set
  ::hex_width>
    @define>
      $globals::hex_radius 3 sqrt mul &value set
  ::hex_height>
    @define>
      $globals::hex_radius 2 mul &value set

; Shared functions a card calls from its `:visuals` hooks. All output the
; engine-owned `prims` draw list (see CONVENTIONS "VISUAL PRIMITIVES"): a card
; constructs primitives with the `^hex`/`^rect`/`^sprite` intrinsics and
; configures them through the returned handle. The builders below compose the
; standard faces — rect_card / hex_card (card faces), ring_prims (a tile's stock
; scatter), tile_object (a tile's single placeable). Sizes come from `<globals>`
; + the asset; nothing is hardcoded engine-side.
;
; `<functions>` catalogues each `::name>` function the same way `<card>`
; catalogues `::name>` cards — one `<>`/`::` grammar across every space, so
; functions version like cards ($functions::ring_prims → lineage head).
<functions>

  ; hex_body — the bare hex tile body prim (prims.0): a ^hex filling the cell
  ; (hex_width × hex_height px), tint *color.bg. Extracted so every hex surface
  ; (ring_prims, tile_object, the forest_cards experiment) makes its hexagon ONE
  ; way. `^hex` is "the thing that gives us a hexagon"; this names + sizes it. The
  ; handle is left in `&h` for the caller, but callers that re-use `&h` just
  ; overwrite it — push order is paint order, so the body stays prims.0.
  ::hex_body>
    ^hex call &h set
    0.0 0.0 &h.pos vec2
    $globals::hex_width $globals::hex_height &h.size vec2   ; body fills the cell (px)
    *color.bg &h.tint set

  ; ring_prims — a tile's stock scatter: prims.0 = the hex tile body (fills the
  ; cell, tint color.bg), then one sprite prim per stock object dropped into one
  ; of 7 precomputed slots (centre + a jittered 6-point ring) at random. The
  ; sprite's texture is the aspect's render OBJECT name (`*rec.art.object`); the
  ; CLIENT picks the LOD variant + faction by seed. Px from `$globals::hex_*`;
  ; each object is sized by the asset's `scale` envelope. Object counter var.0
  ; (0..6); `^seed` (the tile's (q,r) hash) drives the scatter.
  ::ring_prims>
    ; the hex tile body (prims.0) — the shared hexagon builder. Each ^sprite below
    ; likewise pushes a prim and hands back &h — push order IS paint order, so no
    ; index bookkeeping.
    $functions::hex_body call drop

    ; ring geometry in PX, derived from the cell globals (constant per tile):
    ; centre = cell/2, radii ~28%/25% of the cell width/height. var.4/5 = centre,
    ; var.9/10 = radii.
    $globals::hex_width 2 div &var.4 set
    $globals::hex_height 2 div &var.5 set
    $globals::hex_width 28 mul 100 div &var.9 set
    $globals::hex_height 25 mul 100 div &var.10 set

    ; Precompute 7 placement slots: slot 0 = centre, slots 1..6 on the ring at a
    ; seeded start angle, each separated by 60° ± 10° of jitter (so neighbouring
    ; tiles scatter differently and the ring never reads as a rigid hexagon).
    ; Objects are later dropped into these slots at random, one per slot.
    ^seed call &seed set
    *var.4 *var.5 &slot.0 vec2
    *seed 101 add random 360 mod &var.24 set            ; start angle 0..359°
    *var.24 pi mul 180.0 div &var.20 set                ; → radians
    1 &var.21 set
    :ring>
      *var.21 7 ge if :ring_done goto
      *var.4 *var.9 *var.20 cos mul add &var.22 set     ; centre_x + radius_x·cos
      *var.5 *var.10 *var.20 sin mul add &var.23 set    ; centre_y + radius_y·sin
      *var.22 *var.23 &slot.*var.21 vec2
      *seed *var.21 add 200 add random 21 mod 10 sub 60 add &var.24 set   ; step 50..70°
      *var.24 pi mul 180.0 div *var.20 add &var.20 set                    ; angle += step
      &var.21 inc
      :ring goto
    :ring_done>

    0 &var.0 set
    0 &var.2 set

    :aspect>
      *var.2 &aspect count ge if 0 ret
      *var.0 7 ge if 0 ret
      &aspect *var.2 key &name set
      *name aspect recall &rec set
      *rec.art.object 0 eq if :next goto
      0 &var.1 set

      :place>
        *var.1 *aspect.*var.2 ge if :next goto
        *var.0 7 ge if 0 ret
        ^sprite call &h set
        *rec.art.object &h.texture set
        ; pivot from the ASSET (not a hardcoded centre) so each object controls
        ; where the slot sits on it — e.g. a tree uses bottom-centre (50 100) so
        ; its BASE plants on the slot and the canopy spills UP into the cell above,
        ; rather than centring (and spilling its base into the cell below).
        *rec.art.anchor.x *rec.art.anchor.y &h.anchor vec2
        ; per-object scale: roll within the asset's `scale` envelope (hundredths,
        ; e.g. pine 80..100), defaulting to 100% when the pack declares none — so a
        ; clump of pines varies in size. Size px = native (`*rec.art.size`) · pick/100.
        *rec.art.scale.min &var.11 set
        *rec.art.scale.max &var.12 set
        *var.12 0 eq if 100 &var.12 set                                      ; no envelope → native
        *var.11 0 eq if *var.12 &var.11 set
        *var.12 *var.11 sub 1 add &var.13 set                                ; span = max-min+1
        *seed *var.0 add 400 add random *var.13 mod *var.11 add &var.14 set   ; pick in [min,max]
        *rec.art.size *var.14 mul 100.0 div &var.3 set
        *var.3 *var.3 &h.size vec2
        ; drop into a random unused slot — linear probe forward from a seeded
        ; start so each object lands in its own slot (≤7 objects, 7 slots).
        *seed *var.0 add 300 add random 7 mod &var.30 set
        :probe>
          *used.*var.30 0 eq if :slotted goto
          *var.30 1 add 7 mod &var.30 set
          :probe goto
        :slotted>
        1 &used.*var.30 set
        *slot.*var.30.x *slot.*var.30.y &h.pos vec2
        &var.0 inc
        &var.1 inc
        :place goto

      :next>
      &var.2 inc
      :aspect goto

  ; rect_tile — the inventory slot background: a rect filling the cell (cell_width
  ; × cell_height, tint *color.bg). The rect-grid analogue of `ring_prims`' hex
  ; body, but for a slot — no stock scatter, no title bar. Sized to the full cell
  ; (not card_width × body_height like `rect_card`) so adjacent slots meet
  ; edge-to-edge.
  ;
  ; Y SHIFT: a content card is BODY-centred on the snap (= cell centre), with its
  ; title strip hanging half-a-card above — so its full face is centred half a
  ; title ABOVE the snap. The tile box corner sits at the cell corner, so a plain
  ; pos (0,0) would centre the slot on the snap and leave it sitting ~title/2 low
  ; under the card. Shift the rect UP by title_height/2 so the slot re-centres on
  ; the card's FACE, giving an equal `cell_margin` above the title and below the
  ; body. (x stays 0 — the face is already horizontally centred on the snap.)
  ::rect_tile>
    0 $globals::title_height 2 div sub &var.0 set            ; -title_height/2
    ^rect call &h set
    0.0 *var.0 &h.pos vec2
    $globals::cell_width $globals::cell_height &h.size vec2
    *color.bg &h.tint set

  ; stack_layout — read `^card_data` and set the layout vars every card builder
  ; uses, so the stack math lives in ONE place. The body is drawn top-left at
  ; (0, *stack_dy), height card_height; the TITLE BAR is a separate title_height
  ; strip flush ABOVE the body (top-stack member, hex, loose root) or flush BELOW
  ; it (bottom-stack member). The chain paints ROOT IN FRONT, root's title on top.
  ;   &stack_dy  the card's fan y-offset (px). Units are title_height: a TOP-stack
  ;              member offsets by its chain `step` (it must clear the root's top
  ;              title bar); a BOTTOM member by `step-1` (nothing to clear below
  ;              the root). dir: -1 up / +1 down / 0 hex|loose. So consecutive
  ;              cards' title bars stack one title_height apart.
  ;   &band_y    the title strip's top-left y (already includes *stack_dy).
  ; `call` runs functions inline over the same store, so the vars are visible to
  ; the caller (and to `title`).
  ::stack_layout>
    ^card_data call &d set
    *d.stack.index &units set
    *d.stack.dir 0 gt if *d.stack.index 1 sub &units set
    *units *d.stack.dir mul $globals::title_height mul &stack_dy set
    ; title strip top-left y: flush ABOVE the body, or BELOW for a bottom member.
    *stack_dy $globals::title_height sub &band_y set                       ; above the body
    *d.stack.dir 0 gt if *stack_dy $globals::body_height add &band_y set   ; below, for a bottom member
    ; queue bar top-left y: the title bar's edge that BORDERS the body — the body's
    ; top (title above) or the body's bottom (title below).
    *stack_dy $globals::queue_height sub &queue_y set                      ; just inside the top title's bottom edge
    *d.stack.dir 0 gt if *stack_dy $globals::body_height add &queue_y set  ; bottom title's top edge

  ; title — the card's name strip (the title BAR), placed at `*band_y` (above or
  ; below the body — see stack_layout). Three prims in paint order:
  ;   1. the bar background (full width × title_height, tint *color.title);
  ;   2. the `^progress` FILL over it (the title bar IS the progress bar) — the
  ;      engine fills it live from progress row 0 and HIDES it when none is active,
  ;      so a card always emits it (no conditional); the DSL only names the row +
  ;      style, never a fraction;
  ;   3. the title TEXT, centred in the bar, on top (a locale KEY `*sys.label` =
  ;      `cards.<type>.<key>.label`; the client resolves + bakes/scales it).
  ; Every rect_card / hex_card titles itself from here.
  ::title>
    ^rect call &h set                                        ; bar background
    ; extend 1px each side (like the body) so the two fills overlap at the seam —
    ; closes the residual ~1px transparent line between the title bar and body.
    ; x rides *card_ox (0 for a normal card; a tile offsets the card in its cell).
    *card_ox   *band_y 1 sub   &h.pos vec2
    $globals::card_width   $globals::title_height 2 add   &h.size vec2
    *color.title &h.tint set

    ^card_data call &d set                                   ; progress fill (behind the text)
    ^progress call &p set
    *card_ox *band_y &p.pos vec2
    $globals::card_width $globals::title_height &p.size vec2
    #6cf &p.tint set
    *d.progress.0.id &p.target set
    *d.progress.0.style &p.style set

    ^text call &h set                                        ; title text, on top
    *sys.label &h.text set
    *card_ox $globals::card_width 2 div add   *band_y $globals::title_height 2 div add   &h.pos vec2
    $globals::card_width   $globals::title_height 70 mul 100 div   &h.size vec2
    50.0 50.0 &h.anchor vec2
    *color.text &h.tint set

    ; queue bar — a thin WHITE ltr bar on the title's body-bordering edge, showing
    ; the action QUEUE/debounce before a recipe is proposed (`source 1` = the
    ; debounce fraction, NOT a recipe row). Engine self-hides it when no queue.
    ^progress call &q set
    1 &q.source set
    *card_ox *queue_y &q.pos vec2
    $globals::card_width $globals::queue_height &q.size vec2
    #ffffff &q.tint set
    1 &q.style set

  ; rect_card — the generic-path version of a standard rectangular card face. The
  ; BODY is the full card box (tint *color.bg) with the art centred in it; the
  ; title BAR is a separate strip above/below (via `$functions::title`). All
  ; sizes/coords are PX from `$globals::card_*`. A card calls this from `:visuals
  ; @init`/`@update`/`@destroy` after setting *color.* + its art (&pack/&variant).
  ;
  ; STACK FAN: `stack_layout` sets `*stack_dy` (the card's fan offset) + `*band_y`
  ; (the title strip y). The body + art ride `*stack_dy`; the title bar + text sit
  ; on `*band_y` (which already includes the fan).
  ::rect_card>
    $functions::stack_layout call drop
    $functions::card_face call drop

  ; card_face — draws a standard card FACE (body + centred art + title strip) at
  ; the current layout vars: `*stack_dy` (the fan y, set by stack_layout or a
  ; caller), `*band_y`/`*queue_y` (the title strip), and `*card_ox` — an X ORIGIN
  ; that DEFAULTS TO 0 (unset → 0), so a normal card draws card-local (origin 0)
  ; exactly as before, while a tile sets `*card_ox` to place the card WITHIN its
  ; cell. Reads *color.* / *pack / *sys.label from the store, so any surface that
  ; populates those + the layout vars draws an identical card face. The
  ; forest_cards experiment reuses this instead of re-rolling its own rects.
  ::card_face>
    ^rect call &h set                                        ; body fill (the 72×72 square)
    ; extend the body 1px on each side so it underlaps the title bar — adjacent
    ; sprites leave a ~1px transparent seam (edge AA / atlas half-texel) otherwise.
    ; The title (higher z) covers the overlap; centre is unchanged.
    *card_ox   *stack_dy 1 sub   &h.pos vec2
    $globals::card_width   $globals::body_height 2 add   &h.size vec2
    *color.bg &h.tint set

    ^sprite call &h set                                      ; card art, centred in the body
    ; the card set &pack (the asset ref) and, for a variant pack, &variant (the
    ; LUT key). Resolve here: object folder from *pack.object, variant index from
    ; *pack.texture.*variant. A card with no &pack → no texture → the sprite hides
    ; itself (body only).
    *pack.object &h.texture set
    ; pin the variant index ONLY for a variant pack (one with a texture LUT);
    ; a single-sprite pack (souls, soul_offline) leaves index unset → the client
    ; picks by seed (the card id), so e.g. each soul gets its own portrait.
    *pack.texture count 0 gt if *pack.texture.*variant &h.index set
    *card_ox $globals::card_width 2 div add   *stack_dy $globals::body_height 2 div add   &h.pos vec2
    $globals::card_width 85 mul 100 div &var.0 set          ; square art ≈85% of card width
    *var.0 *var.0 &h.size vec2
    50.0 50.0 &h.anchor vec2

    $functions::title call drop                             ; title bar strip (bg + progress + text)

  ; card_death — the shared death exit: append a roll-up MASK over the whole card.
  ; Add it AFTER the card's normal draw in `:visuals @destroy` so the card keeps
  ; rendering while it rolls, e.g.
  ;   @destroy> $functions::rect_card call drop  $functions::card_death call drop
  ; The `^mask` prim CLIPS the rest of the card's prims (the client sets it as the
  ; layer mask); easing its height full → 0, top-anchored, rolls the card up
  ; bottom→top. When the ease settles the client finalizes the death (dead=2).
  ; Mask is a CARD (self-mounted) feature — don't add to tiles (they render into
  ; the shared world sort layer, which has no per-tile container to clip).
  ::card_death>
    $functions::stack_layout call drop                     ; (re)establish *stack_dy
    ^mask call &m set
    ; top-left at the title strip's top (rides the stack fan); full card width.
    0   *stack_dy $globals::title_height sub   &m.pos vec2
    ; TARGET = zero height (rolled away); START (enter) = full card height.
    $globals::card_width   0   &m.size vec2
    $globals::card_height &m.enter.h set

  ; tile_object — a hex tile with ONE explicit object (a building), no stock ring.
  ; Hex body (tint *color.bg) + a single centred sprite from the card's &pack
  ; (+ &variant for a variant pack), sized to the asset's native px. For tiles
  ; whose art is a fixed placeable, not aspect-stock scatter (cf. ring_prims).
  ::tile_object>
    $functions::hex_body call drop

    ^sprite call &h set
    *pack.object &h.texture set
    *pack.texture count 0 gt if *pack.texture.*variant &h.index set   ; variant packs only
    $globals::hex_width 2 div $globals::hex_height 2 div &h.pos vec2
    *pack.size *pack.size &h.size vec2
    50.0 50.0 &h.anchor vec2

  ; hex_card — a card-sized hex face (events). ^hex body filling the card box,
  ; tinted *color.bg. The `^hex gives us a hex` path — same primitive forest's
  ; tile body uses, just sized to the card box instead of the cell.
  ::hex_card>
    ; stack fan + title band — same as rect_card; a hex face stacks too.
    $functions::stack_layout call drop

    ^hex call &h set
    0.0   *stack_dy 1 sub   &h.pos vec2
    $globals::card_width   $globals::body_height 2 add   &h.size vec2
    *color.bg &h.tint set

    $functions::title call drop                             ; title bar strip (bg + progress + text)
