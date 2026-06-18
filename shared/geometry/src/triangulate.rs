//! Classify rings into outer/hole by nesting, assign holes to outers, and earcut.

use crate::simplify::Ring;
use crate::{Point, Polygon};

/// Turn a flat list of simplified rings into triangulated [`Polygon`]s.
///
/// Winding from the (undirected) stitch is unreliable, so outer/hole is decided
/// by **nesting depth**: a ring contained in an even number of other rings is an
/// outer, odd is a hole. Each hole is assigned to the smallest-area outer that
/// contains it (its immediate parent). Each outer+holes group is earcut'd (which
/// normalizes winding itself), so holes are excluded from the triangles.
pub fn assemble(rings: Vec<Ring>) -> Result<Vec<Polygon>, String> {
    let n = rings.len();
    if n == 0 {
        return Ok(Vec::new());
    }

    // A strictly-interior point per ring (near its own boundary, so a donut's
    // outer rep sits in the solid annulus, not the central hole).
    let reps: Vec<[f64; 2]> = rings.iter().map(|r| interior_point(&r.points)).collect();

    let depth: Vec<usize> = (0..n)
        .map(|i| (0..n).filter(|&j| j != i && contains(&rings[j].points, reps[i])).count())
        .collect();
    let is_outer = |i: usize| depth[i] % 2 == 0;

    // Each hole's immediate parent = the smallest-area outer containing it.
    let parent: Vec<Option<usize>> = (0..n)
        .map(|h| {
            if is_outer(h) {
                return None;
            }
            let mut best: Option<(usize, f64)> = None;
            for o in 0..n {
                if o == h || !is_outer(o) {
                    continue;
                }
                if contains(&rings[o].points, reps[h]) {
                    let a = rings[o].area.abs();
                    if best.map_or(true, |(_, ba)| a < ba) {
                        best = Some((o, a));
                    }
                }
            }
            best.map(|(o, _)| o)
        })
        .collect();

    let mut polygons = Vec::new();
    for oi in 0..n {
        if !is_outer(oi) {
            continue;
        }
        let outer = &rings[oi];
        let mut flat: Vec<f64> = Vec::with_capacity(outer.points.len() * 2);
        for p in &outer.points {
            flat.push(p[0]);
            flat.push(p[1]);
        }
        let mut hole_starts: Vec<usize> = Vec::new();
        let mut hole_pts: Vec<Vec<Point>> = Vec::new();
        let mut vert = outer.points.len();
        for h in 0..n {
            if parent[h] != Some(oi) {
                continue;
            }
            hole_starts.push(vert);
            vert += rings[h].points.len();
            for p in &rings[h].points {
                flat.push(p[0]);
                flat.push(p[1]);
            }
            hole_pts.push(rings[h].points.iter().map(|p| [p[0] as f32, p[1] as f32]).collect());
        }

        let tris = earcutr::earcut(&flat, &hole_starts, 2).map_err(|e| format!("earcut: {e:?}"))?;

        polygons.push(Polygon {
            contour: outer.points.iter().map(|p| [p[0] as f32, p[1] as f32]).collect(),
            holes: hole_pts,
            triangles: tris.into_iter().map(|i| i as u32).collect(),
        });
    }

    Ok(polygons)
}

/// A point strictly inside `ring`: the first edge's midpoint nudged a hair along
/// the inward normal (whichever side the ring's own even-odd test calls inside).
/// Robust to concavity and to a ring's own holes (it stays next to the boundary).
fn interior_point(ring: &[[f64; 2]]) -> [f64; 2] {
    let n = ring.len();
    let a = ring[0];
    let b = ring[1 % n];
    let mid = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
    let edge = [b[0] - a[0], b[1] - a[1]];
    let len = (edge[0] * edge[0] + edge[1] * edge[1]).sqrt().max(1e-12);
    let normal = [-edge[1] / len, edge[0] / len];
    const EPS: f64 = 1.0e-4; // normalized — smaller than any real feature
    let plus = [mid[0] + normal[0] * EPS, mid[1] + normal[1] * EPS];
    if contains(ring, plus) {
        plus
    } else {
        [mid[0] - normal[0] * EPS, mid[1] - normal[1] * EPS]
    }
}

/// Ray-cast point-in-polygon (even-odd). `poly` is a closed ring.
fn contains(poly: &[[f64; 2]], pt: [f64; 2]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[i][0], poly[i][1]);
        let (xj, yj) = (poly[j][0], poly[j][1]);
        if (yi > pt[1]) != (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}
