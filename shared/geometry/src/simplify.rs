//! A closed ring + Visvalingam–Whyatt simplification.

/// A closed polygon ring (no repeated closing vertex), with its signed area
/// (shoelace) cached — sign = winding, magnitude = enclosed area.
pub struct Ring {
    pub points: Vec<[f64; 2]>,
    pub area: f64,
}

impl Ring {
    pub fn new(points: Vec<[f64; 2]>) -> Self {
        let area = signed_area(&points);
        Ring { points, area }
    }

    pub fn recompute_area(&mut self) {
        self.area = signed_area(&self.points);
    }
}

/// Signed area via the shoelace formula (CCW positive in a y-up frame; the sign
/// is only used relatively, so the frame's handedness doesn't matter).
pub fn signed_area(p: &[[f64; 2]]) -> f64 {
    let n = p.len();
    if n < 3 {
        return 0.0;
    }
    let mut s = 0.0;
    for i in 0..n {
        let a = p[i];
        let b = p[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    s * 0.5
}

/// Visvalingam–Whyatt: repeatedly drop the vertex whose triangle (with its two
/// neighbours) has the smallest area — the least-significant point — until the
/// next removal would exceed `min_area` (the max per-vertex silhouette error) or
/// the ring hits `min_vertices`. The four cardinal extrema (min/max x, min/max y)
/// are protected so the bounding silhouette never collapses inward.
pub fn visvalingam(ring: &mut Ring, min_area: f64, min_vertices: usize) {
    let min_vertices = min_vertices.max(3);
    loop {
        let n = ring.points.len();
        if n <= min_vertices {
            break;
        }
        let protected = cardinal_extrema(&ring.points);
        let mut best: Option<(usize, f64)> = None;
        for i in 0..n {
            if protected.contains(&i) {
                continue;
            }
            let p = ring.points[(i + n - 1) % n];
            let c = ring.points[i];
            let q = ring.points[(i + 1) % n];
            let a = tri_area(p, c, q);
            if best.map_or(true, |(_, ba)| a < ba) {
                best = Some((i, a));
            }
        }
        let Some((idx, area)) = best else { break };
        if area >= min_area {
            break;
        }
        ring.points.remove(idx);
    }
    ring.recompute_area();
}

/// Indices of the current min-x, max-x, min-y, max-y vertices (first wins ties).
fn cardinal_extrema(p: &[[f64; 2]]) -> [usize; 4] {
    let (mut minx, mut maxx, mut miny, mut maxy) = (0usize, 0usize, 0usize, 0usize);
    for i in 1..p.len() {
        if p[i][0] < p[minx][0] {
            minx = i;
        }
        if p[i][0] > p[maxx][0] {
            maxx = i;
        }
        if p[i][1] < p[miny][1] {
            miny = i;
        }
        if p[i][1] > p[maxy][1] {
            maxy = i;
        }
    }
    [minx, maxx, miny, maxy]
}

#[inline]
fn tri_area(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs()
}
