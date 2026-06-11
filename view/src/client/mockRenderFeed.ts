//! TEMPORARY dev stand-in for the wasm `client` core's region query.
//!
//! The real client will answer a `RenderRegion` from its read-only world
//! snapshot. Until that ships, this synthesises a flat field of world tiles so
//! the viewport — pan, cull, streaming, the DSL draw path — can be exercised end
//! to end. It invents NO game state beyond "every cell in the asked region is an
//! empty tile": packed def `0` (the viewport's `decode` misses → fallback hex),
//! zero stock. When the wasm region query lands, delete this file and route the
//! worker's render handler into it instead. Gated behind `MOCK` in the worker.

import type { RenderRegion, Renderable } from "./render";

/** Every cell in the region's axial bounding box as an empty world tile. The
 *  box is a parallelogram in screen space (axial r-rows shear in q); over-
 *  covering the corners is harmless — the viewport culls to its display rect. */
export function mockRenderFeed(region: RenderRegion): Renderable[] {
  const out: Renderable[] = [];
  const cq = Math.round(region.q);
  const cr = Math.round(region.r);
  for (let dr = -region.halfRows; dr <= region.halfRows; dr++) {
    const r = cr + dr;
    // Shear the q-window by half the row offset so the covered band tracks the
    // pointy-top column skew rather than drifting off-screen at the edges.
    const qCentre = cq - Math.round(dr / 2);
    for (let dq = -region.halfCols; dq <= region.halfCols; dq++) {
      const q = qCentre + dq;
      out.push({ layer: "tile", q, r, packed: 0, stock0: 0, stock1: 0 });
    }
  }
  return out;
}
