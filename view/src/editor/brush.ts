//! Brush-painting primitives for the Card Editor.
//!
//! A "surface" is one on-screen view of the sprite's master texel space — the
//! diffuse / albedo / normal squares and the card preview each show the SAME
//! texels at a different origin + scale. So a cursor over any surface maps to a
//! shared texel, and the brush outline is drawn in every surface at that texel.
//!
//! Painting itself (canvas copies, strokes, undo/redo) lives in `paintHistory`;
//! this module is just the surface geometry + the colour helper.

/** One view of the shared texel space: a clip rect plus the sprite's display
 *  origin + per-axis scale (display px per texel) within it. `stem` is the master
 *  variant this surface paints — the channel squares follow the SELECTED sprite,
 *  the preview is pinned to the card's main sprite, so they can differ. */
export interface Surface {
  rx: number; ry: number; rw: number; rh: number;
  ox: number; oy: number;
  sx: number; sy: number;
  texW: number; texH: number;
  stem: string;
}

/** Texel under a content-local point on `s`, or null when outside the sprite. */
export function surfaceTexel(s: Surface, lx: number, ly: number): { tx: number; ty: number } | null {
  if (lx < s.rx || ly < s.ry || lx > s.rx + s.rw || ly > s.ry + s.rh) return null;
  const tx = (lx - s.ox) / s.sx;
  const ty = (ly - s.oy) / s.sy;
  if (tx < 0 || ty < 0 || tx >= s.texW || ty >= s.texH) return null;
  return { tx, ty };
}

/** Display rect of a `brush`-texel square centred at texel `(tx, ty)` on `s`. */
export function outlineRect(s: Surface, tx: number, ty: number, brush: number): { x: number; y: number; w: number; h: number } {
  return {
    x: s.ox + (tx - brush / 2) * s.sx,
    y: s.oy + (ty - brush / 2) * s.sy,
    w: brush * s.sx,
    h: brush * s.sy,
  };
}

/** `0xRRGGBB` → `#rrggbb`. */
export function cssColor(tint: number): string {
  return `#${((tint >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`;
}
