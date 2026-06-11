//! Pointy-top axial hex coordinate math for the world viewport. Pure geometry —
//! `(q, r)` world cell ↔ world pixel, fractional pixel → nearest cell, and the
//! cell rect a display rectangle covers. No PIXI, no game state. Ported from the
//! old `HexGrid` so the viewport reads/writes the same world layout.

/** A world hex of display radius `R`. `cellWidth = √3·R`, `cellHeight = 2·R`;
 *  the column step per Δq is `cellWidth`, the row step per Δr is `1.5·R`. */
export class HexMath {
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** Vertical step between hex rows (Δr). */
  readonly rowStep: number;

  constructor(readonly radius: number) {
    this.cellWidth = Math.sqrt(3) * radius;
    this.cellHeight = radius * 2;
    this.rowStep = 1.5 * radius;
  }

  /** Cell `(q, r)` → its centre in world pixels. Linear in `(q, r)`, so the same
   *  formula applied to a `(Δq, Δr)` yields a pixel displacement. */
  cellToPixel(q: number, r: number): { x: number; y: number } {
    const R = this.radius;
    return {
      x: R * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
      y: R * (1.5 * r),
    };
  }

  /** World pixels → fractional cell coords (inverse of {@link cellToPixel}).
   *  Linear with no constant term, so it also converts a pixel *delta* to a
   *  cell *delta* — used for drag-pan. */
  pixelToCellFractional(x: number, y: number): { q: number; r: number } {
    const R = this.radius;
    return {
      q: x / (R * Math.sqrt(3)) - y / (3 * R),
      r: (2 * y) / (3 * R),
    };
  }

  /** Round fractional axial coords to the nearest hex via cube rounding (naive
   *  axial rounding picks the wrong hex on triangle boundaries). */
  roundCell(q: number, r: number): { q: number; r: number } {
    const fx = q;
    const fz = r;
    const fy = -q - r;
    let rx = Math.round(fx);
    let ry = Math.round(fy);
    let rz = Math.round(fz);
    const dx = Math.abs(rx - fx);
    const dy = Math.abs(ry - fy);
    const dz = Math.abs(rz - fz);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    return { q: rx, r: rz };
  }

  /** Whole-cell half-extents needed to cover a `width × height` display centred
   *  on a cell, plus `margin` rings of overscan (so tiles build just outside the
   *  view and pan in already drawn). The horizontal cover folds in the row-shear
   *  term (`0.5·cellWidth` per Δr) so wide rows at the top/bottom still reach the
   *  screen edges. */
  coverHalfExtents(
    width: number,
    height: number,
    margin: number,
  ): { halfCols: number; halfRows: number } {
    const halfRows = Math.ceil(height / 2 / this.rowStep) + margin;
    // Each extra row shifts its column window by half a cell; widen cols by the
    // row reach so the sheared corners stay covered.
    const halfCols =
      Math.ceil(width / 2 / this.cellWidth + halfRows / 2) + 1 + margin;
    return { halfCols, halfRows };
  }
}
