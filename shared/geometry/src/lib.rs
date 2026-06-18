//! Silhouette geometry sidecars derived from a master sprite's alpha channel.
//!
//! A [`Sidecar`] holds, per sprite, a simplified set of boundary polygons and a
//! triangulation of them — normalized to the sprite's content box so the runtime
//! scales by the card's current size. It drives two consumers:
//!   - **first-frame placeholder** — fill the triangulation with `color` while the
//!     real texture loads (replaces the transparent fallback);
//!   - **cast shadows** — project the triangulation through a light and rasterize
//!     it (holes excluded by earcut, so no stencil).
//!
//! Generation (`generate`, behind the `generate` feature) is server-side only
//! (the gate): decode alpha → threshold → marching-squares contours (incl. holes)
//! → Visvalingam–Whyatt simplify → group holes into outers → earcut. The wasm
//! client compiles only the types and deserializes them.

use serde::{Deserialize, Serialize};

#[cfg(feature = "generate")]
mod contour;
#[cfg(feature = "generate")]
mod mask;
#[cfg(feature = "generate")]
mod simplify;
#[cfg(feature = "generate")]
mod triangulate;

/// A 2D point, normalized to the sprite content box (`0..1` in each axis;
/// multiply by the rendered card size to place it).
pub type Point = [f32; 2];

/// One connected silhouette piece: an outer ring, its holes, and a triangulation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Polygon {
    /// Outer boundary, normalized, no repeated closing vertex.
    pub contour: Vec<Point>,
    /// Inner boundaries (holes), normalized.
    pub holes: Vec<Vec<Point>>,
    /// Triangle indices (triples) into the flattened vertex list
    /// `contour ++ holes[0] ++ holes[1] ++ …`. Holes are excluded by earcut.
    pub triangles: Vec<u32>,
}

impl Polygon {
    /// The flattened vertex list `triangles` indexes into — `contour` followed by
    /// each hole in order. The consumer rebuilds this the same way.
    pub fn vertices(&self) -> Vec<Point> {
        let mut v = self.contour.clone();
        for h in &self.holes {
            v.extend_from_slice(h);
        }
        v
    }
}

/// Per-sprite silhouette geometry. Coordinates are normalized by `bbox`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sidecar {
    /// Master sprite dimensions in px `[w, h]` — what the normalized coords divide
    /// by, so a consumer can recover master-pixel positions if it needs them.
    pub bbox: [u32; 2],
    /// Dominant (mean opaque) colour as `#rrggbb` — the placeholder fill.
    pub color: String,
    /// Disjoint silhouette pieces. Usually one; multiple when a sprite's opaque
    /// region is in separate blobs.
    pub polygons: Vec<Polygon>,
}

/// Tuning for [`generate`]. Defaults are sensible for pixel-art masters.
#[cfg(feature = "generate")]
#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// Alpha (0..=255) at/above which a pixel is opaque (silhouette interior).
    pub alpha_threshold: u8,
    /// Visvalingam–Whyatt stop: drop a vertex only while the triangle area it
    /// contributes is below this, **in normalized² units** — the max silhouette
    /// error per removed vertex. Larger → coarser polygons.
    pub simplify_area: f32,
    /// Never simplify a ring below this many vertices (holes included).
    pub min_ring_vertices: usize,
    /// Drop a contour/hole whose area (normalized²) is below this — denoises
    /// stray specks and pinhole holes the alpha threshold leaves behind.
    pub min_feature_area: f32,
}

#[cfg(feature = "generate")]
impl Default for Options {
    fn default() -> Self {
        Self {
            alpha_threshold: 128,
            simplify_area: 2.0e-5,
            min_ring_vertices: 4,
            min_feature_area: 5.0e-4,
        }
    }
}

/// Generate a [`Sidecar`] from a master PNG's alpha. Pure-Rust; runs in the gate.
///
/// Pipeline: decode → threshold alpha → marching-squares rings (outer + holes,
/// padded so edge-touching silhouettes still close) → Visvalingam–Whyatt simplify
/// (protected cardinal extrema, hole + min-vertex preservation) → assign holes to
/// the smallest containing outer → earcut each polygon. Coordinates are
/// normalized by the master dimensions.
#[cfg(feature = "generate")]
pub fn generate(master_png: &[u8], opts: &Options) -> Result<Sidecar, String> {
    let m = mask::Mask::decode(master_png, opts.alpha_threshold)?;
    let (w, h) = (m.width, m.height);
    if w == 0 || h == 0 {
        return Err("master has a zero dimension".to_string());
    }

    // Rings in padded-grid pixel space; classify by winding and normalize.
    let rings = contour::trace(&m);
    let inv = [1.0 / w as f64, 1.0 / h as f64];
    let mut simplified: Vec<simplify::Ring> = Vec::new();
    for mut r in rings {
        // padded grid → master px → normalized
        for p in &mut r.points {
            p[0] = (p[0] - contour::PAD as f64) * inv[0];
            p[1] = (p[1] - contour::PAD as f64) * inv[1];
        }
        r.recompute_area();
        if r.area.abs() < opts.min_feature_area as f64 {
            continue; // speck or pinhole — denoise
        }
        simplify::visvalingam(&mut r, opts.simplify_area as f64, opts.min_ring_vertices);
        if r.points.len() >= 3 {
            simplified.push(r);
        }
    }

    let polygons = triangulate::assemble(simplified)?;
    if polygons.is_empty() {
        return Err("no silhouette contours found (fully transparent master?)".to_string());
    }

    Ok(Sidecar {
        bbox: [w, h],
        color: m.dominant_hex(),
        polygons,
    })
}

#[cfg(all(test, feature = "generate"))]
mod tests {
    use super::*;
    use image::{ImageEncoder, Rgba, RgbaImage};

    fn png(img: &RgbaImage) -> Vec<u8> {
        let mut buf = Vec::new();
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(
                img.as_raw(),
                img.width(),
                img.height(),
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        buf
    }

    #[test]
    fn solid_square() {
        let mut img = RgbaImage::new(32, 32);
        for p in img.pixels_mut() {
            *p = Rgba([200, 30, 30, 255]);
        }
        let s = generate(&png(&img), &Options::default()).unwrap();
        assert_eq!(s.bbox, [32, 32]);
        assert_eq!(s.polygons.len(), 1, "one solid blob");
        assert!(s.polygons[0].holes.is_empty(), "no holes");
        assert_eq!(s.polygons[0].triangles.len() % 3, 0);
        assert!(!s.polygons[0].triangles.is_empty());
        assert_eq!(s.color, "#c81e1e");
        // Coords are normalized into [0,1] (allowing the half-pixel padding slop).
        for p in &s.polygons[0].contour {
            assert!(p[0] > -0.1 && p[0] < 1.1 && p[1] > -0.1 && p[1] < 1.1);
        }
    }

    #[test]
    fn square_with_hole() {
        let mut img = RgbaImage::new(40, 40);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let in_body = x >= 4 && x < 36 && y >= 4 && y < 36;
            let in_hole = x >= 14 && x < 26 && y >= 14 && y < 26;
            *p = if in_body && !in_hole {
                Rgba([10, 200, 10, 255])
            } else {
                Rgba([0, 0, 0, 0])
            };
        }
        let s = generate(&png(&img), &Options::default()).unwrap();
        assert_eq!(s.polygons.len(), 1, "one outer blob");
        assert_eq!(s.polygons[0].holes.len(), 1, "one hole");
        assert_eq!(s.polygons[0].triangles.len() % 3, 0);
        assert!(!s.polygons[0].triangles.is_empty());
    }

    #[test]
    fn two_disjoint_blobs() {
        let mut img = RgbaImage::new(64, 32);
        for (x, _y, p) in img.enumerate_pixels_mut() {
            let left = x >= 4 && x < 24;
            let right = x >= 40 && x < 60;
            *p = if left || right {
                Rgba([90, 90, 90, 255])
            } else {
                Rgba([0, 0, 0, 0])
            };
        }
        let s = generate(&png(&img), &Options::default()).unwrap();
        assert_eq!(s.polygons.len(), 2, "two separate blobs → two polygons");
    }

    #[test]
    fn fully_transparent_errors() {
        let img = RgbaImage::new(16, 16); // all zero alpha
        assert!(generate(&png(&img), &Options::default()).is_err());
    }
}
