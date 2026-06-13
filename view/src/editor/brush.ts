//! Brush-painting primitives for the Card Editor.
//!
//! A "surface" is one on-screen view of the sprite's master texel space — the
//! diffuse / albedo / normal squares and the card preview each show the SAME
//! texels at a different origin + scale. So a cursor over any surface maps to a
//! shared texel, and the brush outline is drawn in every surface at that texel.
//!
//! Painting itself (canvas copies, strokes, undo/redo) lives in `paintHistory`;
//! this module is just the surface geometry + the colour helper.

/** The texture a surface shows — its channel, or `lit` for the composited card
 *  preview. The paint bucket reads region geometry from the CLICKED surface's
 *  pixels (so `channel` says which texture to sample), then fills the SELECTED
 *  layer. */
export type SurfaceChannel = "diffuse" | "albedo" | "normal" | "emissive" | "lit";

/** Brush footprint shape. */
export type BrushShape = "square" | "round";

/** A stroke's configuration, captured at mouse-down. `erase` restores the
 *  channel's backing (master) pixels instead of laying down `color`. */
export interface Brush {
  size: number;
  shape: BrushShape;
  /** 0–1: fraction of the radius that stays fully opaque before the edge feathers
   *  out (1 = a hard edge, 0 = feathered all the way to the centre). */
  hardness: number;
  /** 0–1: the dab's peak alpha. Below 1, strokes lay down translucent and build
   *  up where they overlap — the main lever for soft blending. */
  opacity: number;
  color: string;
  erase: boolean;
}

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
  channel: SurfaceChannel;
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

/** Build a `size`×`size` white alpha-mask stamp for the brush — a `round`
 *  (Euclidean) or `square` (Chebyshev) falloff where alpha holds at 1 inside
 *  `hardness` of the radius then ramps to 0 at the edge. Painting tints it with
 *  the stroke colour; erasing uses it to mask the restored backing. */
export function makeBrushStamp(size: number, shape: BrushShape, hardness: number): HTMLCanvasElement {
  const s = Math.max(1, Math.round(size));
  const c = document.createElement("canvas");
  c.width = s; c.height = s;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const img = ctx.createImageData(s, s);
  const d = img.data;
  const r = s / 2;
  const cc = (s - 1) / 2;
  const h = Math.min(1, Math.max(0, hardness));
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = x - cc;
      const dy = y - cc;
      const dist = shape === "round" ? Math.hypot(dx, dy) : Math.max(Math.abs(dx), Math.abs(dy));
      const nd = dist / r; // 0 at centre, ~1 at the edge
      // Smoothstep falloff across [hardness, 1] — a gentle S-curve edge that reads
      // far softer than a linear ramp.
      const t = (nd - h) / (1 - h || 1);
      const a = nd <= h ? 1 : nd >= 1 ? 0 : 1 - t * t * (3 - 2 * t);
      const i = (y * s + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** 4-connected flood fill of `src` from `(sx, sy)`, matching pixels within
 *  per-channel `tolerance` (0–255) of the seed. Returns a white mask canvas
 *  (opaque where filled, transparent elsewhere) at `src`'s resolution. */
export function floodFill(src: ImageData, sx: number, sy: number, tolerance: number): HTMLCanvasElement {
  const w = src.width, h = src.height, d = src.data;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const out = ctx.createImageData(w, h);
  const o = out.data;
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return c;
  const seed = (y0 * w + x0) * 4;
  const r0 = d[seed], g0 = d[seed + 1], b0 = d[seed + 2], a0 = d[seed + 3];
  const t2 = tolerance * tolerance * 4; // boundary at a uniform per-channel diff of `tolerance`
  const seen = new Uint8Array(w * h);
  const stack = [y0 * w + x0];
  while (stack.length) {
    const p = stack.pop() as number;
    if (seen[p]) continue;
    seen[p] = 1;
    const i = p * 4;
    const dr = d[i] - r0, dg = d[i + 1] - g0, db = d[i + 2] - b0, da = d[i + 3] - a0;
    if (dr * dr + dg * dg + db * db + da * da > t2) continue;
    o[i] = 255; o[i + 1] = 255; o[i + 2] = 255; o[i + 3] = 255;
    const px = p % w, py = (p / w) | 0;
    if (px > 0) stack.push(p - 1);
    if (px < w - 1) stack.push(p + 1);
    if (py > 0) stack.push(p - w);
    if (py < h - 1) stack.push(p + w);
  }
  ctx.putImageData(out, 0, 0);
  return c;
}
