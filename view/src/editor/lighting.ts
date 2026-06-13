//! CPU normal-mapped lighting for the Card Editor preview.
//!
//! The earlier GPU filter was fragile (filter-space UVs vs the normal texture,
//! resource binding) and zoom-broken. This composites in TEXEL space instead:
//! read the albedo + normal pixels once, shade per pixel against the lights, and
//! write a lit canvas the preview sprite displays. Because it works on the
//! texture (not the screen), it's zoom-independent (zoom only scales the display)
//! and undo/redo-correct (just re-read the channels). Lambert + per-light
//! distance falloff + ambient — same model as the deferred pass.

/** A point light positioned in texel space, `height` above the surface. */
export interface Light {
  x: number;
  y: number;
  height: number;
  radius: number;
  intensity: number;
  r: number;
  g: number;
  b: number;
}

/**
 * Shade `albedo` by `normal` under `lights` into `out` (all same WxH). `normal`
 * null → flat-up (constant `N·L`). `normalYSign` flips the green channel to match
 * the texture's normal convention (the deferred pass uses -1).
 */
export function composite(
  out: ImageData,
  albedo: ImageData,
  normal: ImageData | null,
  lights: readonly Light[],
  ambient: number,
  normalYSign: number,
): void {
  const w = out.width;
  const a = albedo.data;
  const n = normal?.data;
  const o = out.data;
  for (let p = 0, i = 0; i < a.length; i += 4, p++) {
    const px = p % w;
    const py = (p / w) | 0;
    let nx = 0;
    let ny = 0;
    let nz = 1;
    if (n) {
      nx = n[i] / 127.5 - 1;
      ny = (n[i + 1] / 127.5 - 1) * normalYSign;
      nz = n[i + 2] / 127.5 - 1;
      const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
      nx *= inv; ny *= inv; nz *= inv;
    }
    let lr = ambient;
    let lg = ambient;
    let lb = ambient;
    for (let k = 0; k < lights.length; k++) {
      const L = lights[k];
      const dx = L.x - px;
      const dy = L.y - py;
      let at = 1 - Math.hypot(dx, dy) / L.radius;
      if (at <= 0) continue;
      at *= at;
      const inv = 1 / (Math.hypot(dx, dy, L.height) || 1);
      const ndotl = nx * dx * inv + ny * dy * inv + nz * L.height * inv;
      if (ndotl <= 0) continue;
      const c = L.intensity * ndotl * at;
      lr += L.r * c; lg += L.g * c; lb += L.b * c;
    }
    o[i] = Math.min(255, a[i] * lr);
    o[i + 1] = Math.min(255, a[i + 1] * lg);
    o[i + 2] = Math.min(255, a[i + 2] * lb);
    o[i + 3] = a[i + 3];
  }
}
