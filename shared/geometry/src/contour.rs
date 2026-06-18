//! Marching-squares contour extraction from a binary mask.
//!
//! The mask is treated as surrounded by a 1-px transparent border (`PAD`), so a
//! silhouette touching the image edge still traces a closed loop. Each 2×2 cell
//! of samples emits 0–2 boundary segments (the 16 marching-squares cases, the two
//! saddles resolved consistently); segments are stitched into closed rings by
//! matching shared cell-edge identities exactly (integer keys, no float compare).

use std::collections::HashMap;

use crate::mask::Mask;
use crate::simplify::Ring;

/// Transparent border padding (in samples) around the mask. Coordinates come out
/// in padded space; the caller subtracts `PAD` to get master-pixel space.
pub const PAD: i64 = 1;

/// A cell-edge identity — the stitch key. `H(x,y)` is the horizontal edge whose
/// midpoint is `(x+0.5, y)`; `V(x,y)` is the vertical edge at `(x, y+0.5)`. A
/// given edge is shared by at most two cells, so every key has degree ≤ 2 → the
/// segment graph is a disjoint set of simple cycles.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Ek {
    H(i64, i64),
    V(i64, i64),
}

impl Ek {
    #[inline]
    fn coord(self) -> [f64; 2] {
        match self {
            Ek::H(x, y) => [x as f64 + 0.5, y as f64],
            Ek::V(x, y) => [x as f64, y as f64 + 0.5],
        }
    }
}

/// The (up to two) boundary segments for a marching-squares case. Corner bits:
/// `TL=8 TR=4 BR=2 BL=1`. Edges: `top=H(cx,cy) bottom=H(cx,cy+1)
/// left=V(cx,cy) right=V(cx+1,cy)`.
fn segments(case: u8, cx: i64, cy: i64) -> &'static [(EdgeSel, EdgeSel)] {
    use EdgeSel::*;
    let _ = (cx, cy);
    match case {
        0 | 15 => &[],
        1 => &[(L, B)],
        2 => &[(B, R)],
        3 => &[(L, R)],
        4 => &[(T, R)],
        5 => &[(T, R), (L, B)], // saddle (TR,BL): isolate each filled corner
        6 => &[(T, B)],
        7 => &[(T, L)],
        8 => &[(T, L)],
        9 => &[(T, B)],
        10 => &[(T, L), (B, R)], // saddle (TL,BR)
        11 => &[(T, R)],
        12 => &[(L, R)],
        13 => &[(B, R)],
        14 => &[(L, B)],
        _ => &[],
    }
}

#[derive(Clone, Copy)]
enum EdgeSel {
    T,
    B,
    L,
    R,
}

impl EdgeSel {
    #[inline]
    fn key(self, cx: i64, cy: i64) -> Ek {
        match self {
            EdgeSel::T => Ek::H(cx, cy),
            EdgeSel::B => Ek::H(cx, cy + 1),
            EdgeSel::L => Ek::V(cx, cy),
            EdgeSel::R => Ek::V(cx + 1, cy),
        }
    }
}

#[inline]
fn norm(a: Ek, b: Ek) -> (Ek, Ek) {
    // Order-independent key for the used-set (Ek isn't Ord; compare coords).
    let (ca, cb) = (a.coord(), b.coord());
    if (ca[0], ca[1]) <= (cb[0], cb[1]) {
        (a, b)
    } else {
        (b, a)
    }
}

/// Trace every closed contour in `mask` (outer boundaries and holes, undistinguished
/// here — the caller classifies by winding). Points are in padded-grid space.
pub fn trace(mask: &Mask) -> Vec<Ring> {
    let w = mask.width as i64;
    let h = mask.height as i64;

    // Sample at padded coord (sx,sy): real pixel (sx-PAD, sy-PAD), border = empty.
    let sample = |sx: i64, sy: i64| mask.solid_at(sx - PAD, sy - PAD);

    let mut adj: HashMap<Ek, Vec<Ek>> = HashMap::new();
    let mut segs: Vec<(Ek, Ek)> = Vec::new();

    // Cells span the padded grid: corners at samples in [0, w+1]×[0, h+1].
    for cy in 0..=h {
        for cx in 0..=w {
            let tl = sample(cx, cy) as u8;
            let tr = sample(cx + 1, cy) as u8;
            let br = sample(cx + 1, cy + 1) as u8;
            let bl = sample(cx, cy + 1) as u8;
            let case = (tl << 3) | (tr << 2) | (br << 1) | bl;
            for &(a, b) in segments(case, cx, cy) {
                let (ka, kb) = (a.key(cx, cy), b.key(cx, cy));
                adj.entry(ka).or_default().push(kb);
                adj.entry(kb).or_default().push(ka);
                segs.push((ka, kb));
            }
        }
    }

    let mut used: std::collections::HashSet<(Ek, Ek)> = std::collections::HashSet::new();
    let mut rings = Vec::new();

    for &(a, b) in &segs {
        if used.contains(&norm(a, b)) {
            continue;
        }
        used.insert(norm(a, b));
        let mut keys = vec![a];
        let (mut prev, mut cur) = (a, b);
        loop {
            keys.push(cur);
            if cur == a {
                break;
            }
            let next = adj.get(&cur).and_then(|ns| {
                ns.iter().copied().find(|&n| n != prev && !used.contains(&norm(cur, n)))
            });
            let Some(n) = next else { break };
            used.insert(norm(cur, n));
            prev = cur;
            cur = n;
        }
        if keys.last() == Some(&a) {
            keys.pop(); // drop the closing duplicate
        }
        if keys.len() >= 3 {
            rings.push(Ring::new(keys.iter().map(|k| k.coord()).collect()));
        }
    }

    rings
}
