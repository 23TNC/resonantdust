/**
 * The silhouette-geometry sidecar shape, mirroring the Rust `Sidecar` /`Polygon`
 * in `shared/geometry` (the gate serializes them to JSON; the view deserializes).
 * Coordinates are normalized to the sprite content box (`0..1` per axis) — scale
 * by the rendered card size to place them.
 */

/** A point normalized to the sprite content box (`[x, y]`, each `0..1`). */
export type GeoPoint = [number, number];

/** One connected silhouette piece: an outer ring, its holes, and a triangulation. */
export interface GeoPolygon {
  /** Outer boundary, normalized, no repeated closing vertex. */
  contour: GeoPoint[];
  /** Inner boundaries (holes), normalized. */
  holes: GeoPoint[][];
  /** Triangle indices (triples) into the flattened `contour ++ holes` vertex list
   *  — holes excluded by earcut. Drives the placeholder fill and (later) shadows. */
  triangles: number[];
}

/** Per-sprite silhouette geometry. Coordinates are normalized by `bbox`. */
export interface Sidecar {
  /** Master sprite dimensions in px `[w, h]` — what the normalized coords divide by. */
  bbox: [number, number];
  /** Dominant (mean opaque) colour as `#rrggbb` — the placeholder fill. */
  color: string;
  /** Disjoint silhouette pieces (usually one). */
  polygons: GeoPolygon[];
}
