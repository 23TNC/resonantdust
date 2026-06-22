//! The x/y RECTANGLE grid the world renderer caches + dirty-tracks on. Pure
//! geometry — no PIXI, no game state. Rectangles are an axis-aligned lattice in
//! WORLD PIXELS (not q/r): width `W = √3·R`, height `H = R` (`R = hex_radius`).
//!
//! On the pointy-top hex grid this aligns by construction: a hex is `√3·R` wide
//! (= 1 rect column) and `2·R` tall (= 2 rect rows), and hex centres land on the
//! `W/2` + `H/2` half-grids. So every primitive's world AABB maps deterministically
//! to the small set of rectangles it overlaps — the unit the composite bakes,
//! caches and copies. Hexagons stay the gameplay/coordinate system; rectangles are
//! purely the rendering + dirty system (convert at the boundary, in world px).

import { worldHexRadius, worldHexWidth } from "../hex/hexSize";

/** Rectangle width in world px — `√3·R`, one hex column. */
export const rectW = (): number => worldHexWidth();
/** Rectangle height in world px — `R`, half a hex row. */
export const rectH = (): number => worldHexRadius();

/** Lattice phase (world px): the rect grid's origin offset from world (0,0). Kept
 *  at the origin — a zero-offset lattice has every hex straddle the column lines, so
 *  a hex occupies **3 or 4** rectangles (vs a `W/2` shift's lopsided 2-or-6). The
 *  composite addressing AND the debug overlay both read these, so the drawn grid is
 *  the real bake lattice. */
export const rectOffX = (): number => 0;
export const rectOffY = (): number => 0;

/** An inclusive range of rect cells `[col0..col1] × [row0..row1]`. */
export interface RectRange {
  col0: number;
  row0: number;
  col1: number;
  row1: number;
}

/** The rect cell a world point falls in (floor division, lattice-phased). */
export function worldToRect(x: number, y: number): { col: number; row: number } {
  return { col: Math.floor((x - rectOffX()) / rectW()), row: Math.floor((y - rectOffY()) / rectH()) };
}

/** The inclusive rect range a world-space AABB `[x0,y0]–[x1,y1]` covers. The
 *  `-ε` on the far edges keeps an AABB whose right/bottom sits exactly on a rect
 *  boundary from claiming the next (empty) rect. */
export function rectsForAABB(x0: number, y0: number, x1: number, y1: number): RectRange {
  const w = rectW();
  const h = rectH();
  const ox = rectOffX();
  const oy = rectOffY();
  const eps = 1e-4;
  return {
    col0: Math.floor((x0 - ox) / w),
    row0: Math.floor((y0 - oy) / h),
    col1: Math.floor((x1 - ox - eps) / w),
    row1: Math.floor((y1 - oy - eps) / h),
  };
}

/** World-px top-left of rect cell `(col, row)` — `off + cell·size`. The lattice
 *  the composite bakes from and copies to (physical slots are 0-based; this is the
 *  WORLD position of a cell, used by the bake transform, display dest + overlay). */
export function rectWorldX(col: number): number {
  return rectOffX() + col * rectW();
}
export function rectWorldY(row: number): number {
  return rectOffY() + row * rectH();
}

/** True modulo (always non-negative) — the torus wrap maps a world rect col/row
 *  to its physical composite slot via `mod(worldCol, COLS)`. JS `%` keeps the
 *  sign, which would index out of the composite for negative world coords. */
export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}
