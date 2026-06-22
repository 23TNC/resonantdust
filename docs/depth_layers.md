# Depth — the layer model (RGB depth key)

How the world renderer's **depthRT** orders billboards for 2.5D occlusion. The depth RT
is baked per-rect in `RectComposite.bakeRect` (one quad per standing prim, `discard`
fringe, sorted back-to-front overwrite — the frontmost prim's exact bytes survive per
pixel). Encoding lives in `view/src/game/lighting/depthShaders.ts`.

## The key: `(R, G, B)`

Each prim stamps a 3-byte sort key across its silhouette (rides the mesh tint).

| chan | meaning | encode |
|------|---------|--------|
| **R** | rect row (the rect COUNT in y), wrapped | `mod(floor(worldY/rectH), 255)` |
| **G** | px offset INTO that rect | `worldY − row·rectH`, `[0, rectH)` (rectH=88 < 256, raw) |
| **B** | **layer** (the vertical axis) | one of the `BLUE_*` bands below |

`R+G` together are the **ground position** (which cell, where within it). R is modular —
it repeats every 255 rects (~22k px ≫ any viewport) so on-screen prims never alias; the
compare treats a > half-period (127) R gap as a wraparound (the smaller value wrapped past
the top, so it's in front). G is the raw within-rect pixel offset (not scaled — stays
small, "essentially zero", so `R·rectH + G` reads as a clean fixed-point).

**Bigger = more front on every axis.**

## B = the layer axis

`B` orders prims that share a ground cell — a hex stack, a card's sub-stacks, an object
riding a tile. The byte is split into **4 bands of 64** (`band = B >> 6`):

```
band 0   0..63    the card / tile / stack COLUMN
band 1   64..127  standing objects
band 2   128..191 spare
band 3   192..255 spare
```

Band-0 layout (`BLUE_*` constants):

```
 63 ───────────── spare (above root)
 48  BLUE_ROOT     a card's root layer
 47..31            top + bottom sub-stacks (~16 each way; doubled from today's 16-max)
 30  BLUE_HEX_TILE a lone hex tile = top of the hex column
 30..0             the hex stack: each added card takes a slot toward 0, pushing the
                   tile DOWN (max ~16 cards → 30..14 used, 13..0 spare)
```

Band 1: `BLUE_OBJECT = 80`, centred so manual per-object sort has room up (→127) and down
(→64).

## The comparison (`depthFront`, the source of truth)

The blue **band picks the primary key; the other axis is the tiebreak.** Implemented &
unit-tested in `depthShaders.ts::depthFront(a, b)` (returns +1 if `a` is in front):

```
sameBand = (a.B >> 6) == (b.B >> 6)
if sameBand:                       # intra-column → layer dominates
    if a.B != b.B: return a.B <=> b.B        # blue (bigger front)
    else:          return ground(a, b)        # tie → ground R+G
else:                              # cross-kind → ground dominates
    g = ground(a, b)
    return g != 0 ? g : (a.B <=> b.B)         # ground, then blue tiebreak

ground(a, b):                      # wraparound R, then G
    dR = a.R - b.R
    if dR >  127: dR -= 255
    if dR < -127: dR += 255
    return dR != 0 ? sign(dR) : sign(a.G - b.G)
```

Why this shape works:
- **blue 5 vs blue 200** (different bands) → ground decides (then blue if ground ties).
- **blue 5 vs blue 10** (same band) → blue decides.
- **two trees on different rows** (both blue 80, same band) → blue ties → ground decides
  (the case a naive "same band → blue only" rule would break).
- **object on its own tile** (band 1 vs band 0, same cell) → ground ties → blue tiebreak →
  object (80) in front of tile (30).
- **hex stack** (same band) → top card's higher blue is in front of the sunk tile.

The GLSL mover-occlusion consumer MUST mirror `depthFront` exactly: it samples the depthRT
at the mover's screen pos, builds the mover's own `(R,G,B)` (R,G from its feet world-Y;
B = its layer, e.g. `BLUE_OBJECT`), and discards the mover pixel where the stored key is in
front of it.

## Implemented now

- `R`, `G`, `B` channels stamped; `encodeDepthTint(worldY, rectH, blue)` packs all three.
- Standing objects bake at `BLUE_OBJECT` (80). Depth RT silhouettes now carry blue.
- `depthFront` reference comparison + unit coverage.

## Deferred (needs real stacks / a consumer to verify)

1. **Tiles & hex stacks write depth.** Today `bakeRect` skips `groundLayer` (flat ground
   never occludes). Once hex-card stacks render, the skip becomes "skip only the flat,
   unstacked base"; raised stack members write depth so a mover behind the pile is
   occluded. **Critical:** a raised card must stamp the **tile's ground feet-Y** into R,G
   (NOT its raised sprite bottom-edge, which would mis-tag it a row norther) — the
   elevation goes into B only.
2. **Hex push-down.** Drive `B` from the stack: tile sinks `30 → 30−N`, cards fill above.
3. **Bake sort.** `bakeRect` sorts prims by `zIndex` (≈ feet-Y) = the ground proxy, correct
   while everything is one band/blue. When stacks land, the sort must order by the full
   `depthFront` key so the overwrite stores the true frontmost.
4. **Mover consumer.** Cards in `cardLayer` sample depthRT + the wraparound/band compare to
   `discard` where behind (soul-walks-behind-tree/stack).
