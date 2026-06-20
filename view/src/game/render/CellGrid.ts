//! G4 render-cell grid — a uniform axis-aligned grid in WORLD pixels, the dirty /
//! bake / scissor unit (see docs/g4_renderer.md). Hexagons stay the gameplay
//! coordinate system; cells are the rendering system. A cell is `√3·R` wide × `R`
//! tall (R = hex radius), so the grid relates to the hex layout (cell width = the
//! hex column spacing; 3 cell rows per hex vertical period `3R`) while being a
//! plain uniform grid: no hex math lives here, only floor-division.
//!
//! Pure geometry, no PIXI/state — cheap to construct, trivially correct.

/** Inclusive cell-index range covering a world rect: cells `cx0..cx1` × `cy0..cy1`. */
export interface CellRange {
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
}

/** A world-pixel axis-aligned rect (the bounds of a cell or a coalesced batch). */
export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class CellGrid {
  /** Cell width in world px (`√3·R`). */
  readonly cw: number;
  /** Cell height in world px (`R`). */
  readonly ch: number;

  constructor(radius: number) {
    this.cw = Math.sqrt(3) * radius;
    this.ch = radius;
  }

  /** Cell column index containing world-x (may be negative). */
  cellX(worldX: number): number {
    return Math.floor(worldX / this.cw);
  }

  /** Cell row index containing world-y (may be negative). */
  cellY(worldY: number): number {
    return Math.floor(worldY / this.ch);
  }

  /** The inclusive cell range a world rect overlaps. Conservative on the far edge
   *  (a rect ending exactly on a boundary includes the boundary cell) — harmless,
   *  it just re-bakes one extra cell. Degenerate w/h ≤ 0 yields a single cell. */
  cellsInRect(x: number, y: number, w: number, h: number): CellRange {
    return {
      cx0: Math.floor(x / this.cw),
      cy0: Math.floor(y / this.ch),
      cx1: Math.floor((x + Math.max(0, w)) / this.cw),
      cy1: Math.floor((y + Math.max(0, h)) / this.ch),
    };
  }

  /** World-pixel bounds of a single cell `(cx, cy)`. */
  rectOf(cx: number, cy: number): WorldRect {
    return { x: cx * this.cw, y: cy * this.ch, w: this.cw, h: this.ch };
  }

  /** World-pixel bounds of a whole inclusive cell range — the bounding rect a
   *  coalesced dirty batch bakes in one scissored pass. */
  rectOfRange(r: CellRange): WorldRect {
    return {
      x: r.cx0 * this.cw,
      y: r.cy0 * this.ch,
      w: (r.cx1 - r.cx0 + 1) * this.cw,
      h: (r.cy1 - r.cy0 + 1) * this.ch,
    };
  }
}

/** Pack a cell `(cx, cy)` into a single string key for a Set/Map (dirty set). */
export function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
