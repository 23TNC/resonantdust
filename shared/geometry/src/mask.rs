//! Decode a master PNG into a binary alpha mask + a dominant colour.

/// A thresholded silhouette mask plus the mean opaque colour.
pub struct Mask {
    pub width: u32,
    pub height: u32,
    /// Row-major `width × height`; `true` where alpha ≥ threshold (interior).
    pub solid: Vec<bool>,
    mean_rgb: [u8; 3],
}

impl Mask {
    /// Decode `png`, threshold its alpha, and accumulate the mean colour over the
    /// opaque pixels. Pure-Rust PNG decode (the `image` crate, `png` feature).
    pub fn decode(png: &[u8], alpha_threshold: u8) -> Result<Mask, String> {
        let img = image::load_from_memory(png).map_err(|e| format!("decode master: {e}"))?;
        let rgba = img.to_rgba8();
        let (width, height) = (rgba.width(), rgba.height());
        let mut solid = vec![false; (width as usize) * (height as usize)];
        let (mut rs, mut gs, mut bs, mut n) = (0u64, 0u64, 0u64, 0u64);
        for (i, px) in rgba.pixels().enumerate() {
            if px.0[3] >= alpha_threshold {
                solid[i] = true;
                rs += px.0[0] as u64;
                gs += px.0[1] as u64;
                bs += px.0[2] as u64;
                n += 1;
            }
        }
        let mean_rgb = if n == 0 {
            [0, 0, 0]
        } else {
            [(rs / n) as u8, (gs / n) as u8, (bs / n) as u8]
        };
        Ok(Mask { width, height, solid, mean_rgb })
    }

    /// Sample at padded coordinates: the mask is conceptually surrounded by a
    /// 1-px transparent border (see `contour::PAD`) so silhouettes touching the
    /// image edge still trace a closed loop. Out-of-bounds reads are empty.
    #[inline]
    pub fn solid_at(&self, x: i64, y: i64) -> bool {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return false;
        }
        self.solid[(y as usize) * (self.width as usize) + (x as usize)]
    }

    pub fn dominant_hex(&self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.mean_rgb[0], self.mean_rgb[1], self.mean_rgb[2])
    }
}
