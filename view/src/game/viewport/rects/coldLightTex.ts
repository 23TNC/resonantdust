import type { LightCore } from "../../lighting/lights";

/**
 * Per-rect COLD-LIGHT data/colour textures (docs/tiered_lighting.md TODO #1). The cold bake sums
 * lights on the GROUND normal into the lightmap — wrong for a card (it carries the ground/tree
 * normal). So hot prims instead read the cold lights as DATA here and evaluate them on the card's
 * OWN normal at display time. CPU-authored from the same `lightsForRect` binning the bake uses.
 *
 * Layout: two rgba8 textures, `COLD_TEX_LIGHTS·cols × rows`. Rect at slot (sx,sy) owns columns
 * `sx·32 .. sx·32+31` on row `sy`; light j of that rect is one texel. Positions are RECT-LOCAL
 * (biased `−128`), so a fragment and a light expressed rect-local difference to the light vector
 * with NO pan/world transform (both cancel the rect origin). Lights tolerate the quantization.
 * NEAREST-sampled (each texel is a distinct light — never interpolate between them).
 */
export const COLD_TEX_LIGHTS = 32; // cold lights per rect column (= MAX_COLD_LIGHTS)
export const COLD_POS_STEP = 6.0; // px per x/y step; ±128 steps ≈ ±768px ≈ ±5 rects of reach
export const COLD_RADIUS_SCALE = 4.0; // radius px = byte × this (≤ ~1020px)
export const COLD_BRIGHT_SCALE = 4.0; // brightness = (byte/255) × this (≤ 4)

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0);

/** Encode one cold light into the data + colour byte arrays at texel index `t`, rect-local to the
 *  rect world origin `(rwx, rwy)`. data = (x,y,z,radius); colour = (r,g,b,brightness). */
export function encodeColdLight(data: Uint8Array, color: Uint8Array, t: number, l: LightCore, rwx: number, rwy: number): void {
  const o = t * 4;
  data[o] = clampByte((l.x - rwx) / COLD_POS_STEP + 128);
  data[o + 1] = clampByte((l.y - rwy) / COLD_POS_STEP + 128);
  data[o + 2] = clampByte(l.height);
  data[o + 3] = clampByte(l.radius / COLD_RADIUS_SCALE); // 0 = empty slot (the display loop stops)
  color[o] = (l.color >> 16) & 0xff;
  color[o + 1] = (l.color >> 8) & 0xff;
  color[o + 2] = l.color & 0xff;
  color[o + 3] = clampByte((l.brightness / COLD_BRIGHT_SCALE) * 255);
}
