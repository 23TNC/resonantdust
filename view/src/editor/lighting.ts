//! CPU normal-mapped lighting for the Card Editor preview.
//!
//! The earlier GPU filter was fragile (filter-space UVs vs the normal texture,
//! resource binding) and zoom-broken. This composites in TEXEL space instead:
//! read the albedo + normal pixels once, shade per pixel against the lights, and
//! write a lit canvas the preview sprite displays. Because it works on the
//! texture (not the screen), it's zoom-independent (zoom only scales the display)
//! and undo/redo-correct (just re-read the channels). Lambert + per-light
//! distance falloff + ambient — same model as the deferred pass.

/** Billboard treatment — pitch the surface normal FORWARD (south, toward the
 *  viewer) so a card lights like a standing billboard, exactly as the in-game
 *  hot-prim/object pass does (`rectDisplayShader`). Same constants. A light to the
 *  north then backlights (front dark, edges rimmed) instead of lighting the front
 *  from behind; the wrap floors the diffuse so a near backlight still catches some
 *  light. Flat-up rects (no normal map) pitch forward too → they read as a facing
 *  surface, not a flat panel. */
const SOUTH_TILT = 1.8;
const SOUTH_Z = 0.18;
const OBJECT_WRAP = 0.45;

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
 * the texture's normal convention (the deferred pass uses -1). `emissive` (when
 * given) is ADDED on top of the lit result — `albedo×light + emissive`, scaled by
 * its own alpha so an unpainted (transparent) emissive layer glows nothing —
 * matching the in-game additive emissive pass.
 */
export function composite(
  out: ImageData,
  albedo: ImageData,
  normal: ImageData | null,
  emissive: ImageData | null,
  lights: readonly Light[],
  ambient: number,
  normalYSign: number,
): void {
  const w = out.width;
  const a = albedo.data;
  const n = normal?.data;
  const e = emissive?.data;
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
    }
    // Pitch forward (south) like the in-game billboard/object pass — applied to the
    // mapped normal AND the flat-up default, so rects light as a facing surface.
    ny += SOUTH_TILT;
    nz *= SOUTH_Z;
    const ninv = 1 / (Math.hypot(nx, ny, nz) || 1);
    nx *= ninv; ny *= ninv; nz *= ninv;
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
      let ndotl = nx * dx * inv + ny * dy * inv + nz * L.height * inv;
      ndotl = Math.max(ndotl, OBJECT_WRAP * at); // backlit billboard catches some near light
      const c = L.intensity * ndotl * at;
      lr += L.r * c; lg += L.g * c; lb += L.b * c;
    }
    let er = 0;
    let eg = 0;
    let eb = 0;
    if (e) {
      const ea = e[i + 3] / 255;
      er = e[i] * ea; eg = e[i + 1] * ea; eb = e[i + 2] * ea;
    }
    o[i] = Math.min(255, a[i] * lr + er);
    o[i + 1] = Math.min(255, a[i + 1] * lg + eg);
    o[i + 2] = Math.min(255, a[i + 2] * lb + eb);
    o[i + 3] = a[i + 3];
  }
}

/**
 * CPU bloom for the preview — blur the EMISSIVE contribution and ADD it onto the
 * lit result. Only emissive blooms (not lit albedo / highlights), matching the
 * intent that glow comes from the emissive channel. Same texel-space rationale as
 * {@link composite}: it works on the canvas (not the screen), so it's
 * zoom-independent and recomputed only when the lit result changes. Holds its own
 * scratch sized to the canvas, so it's rebuilt (a new instance) when the sprite's
 * dimensions change.
 */
export class Bloom {
  private readonly bright: Float32Array; // interleaved RGB, length w*h*3
  private readonly tmp: Float32Array;

  constructor(private readonly w: number, private readonly h: number) {
    this.bright = new Float32Array(w * h * 3);
    this.tmp = new Float32Array(w * h * 3);
  }

  /** Add a blurred glow of `emissive`'s above-threshold pixels onto `lit` (in
   *  place). The bloom source is the emissive contribution (RGB × its alpha) — so
   *  the lit albedo never blooms — gated by a 0–255 luma `threshold` (skips
   *  near-black). `radius` is the blur radius in texels, `intensity` the add-back
   *  strength. No-op without an emissive layer. */
  apply(lit: ImageData, emissive: ImageData | null, threshold: number, radius: number, intensity: number): void {
    if (radius < 1 || intensity <= 0 || !emissive) return;
    const { w, h, bright, tmp } = this;
    const d = lit.data;
    const e = emissive.data;
    // Bright-pass: the emissive contribution (premultiplied by its own alpha) at
    // pixels whose luma clears the threshold; zero elsewhere. No albedo here.
    for (let p = 0, i = 0; i < e.length; i += 4, p++) {
      const ea = e[i + 3] / 255;
      const r = e[i] * ea, g = e[i + 1] * ea, b = e[i + 2] * ea;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const on = luma > threshold ? 1 : 0;
      bright[p * 3] = r * on;
      bright[p * 3 + 1] = g * on;
      bright[p * 3 + 2] = b * on;
    }
    // 3 box passes ≈ a Gaussian; each direction is an O(n) sliding window.
    for (let pass = 0; pass < 3; pass++) {
      boxH(bright, tmp, w, h, radius);
      boxV(tmp, bright, w, h, radius);
    }
    for (let p = 0, i = 0; i < d.length; i += 4, p++) {
      d[i] = Math.min(255, d[i] + bright[p * 3] * intensity);
      d[i + 1] = Math.min(255, d[i + 1] + bright[p * 3 + 1] * intensity);
      d[i + 2] = Math.min(255, d[i + 2] + bright[p * 3 + 2] * intensity);
    }
  }
}

/** Horizontal sliding-window box blur of an interleaved-RGB buffer (`src` → `dst`),
 *  edges clamped. */
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) {
        const xx = x < 0 ? 0 : x >= w ? w - 1 : x;
        sum += src[(row + xx) * 3 + c];
      }
      for (let x = 0; x < w; x++) {
        dst[(row + x) * 3 + c] = sum / win;
        const xo = x - r < 0 ? 0 : x - r;
        const xiRaw = x + r + 1;
        const xi = xiRaw >= w ? w - 1 : xiRaw;
        sum += src[(row + xi) * 3 + c] - src[(row + xo) * 3 + c];
      }
    }
  }
}

/** Vertical counterpart of {@link boxH}. */
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const win = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) {
        const yy = y < 0 ? 0 : y >= h ? h - 1 : y;
        sum += src[(yy * w + x) * 3 + c];
      }
      for (let y = 0; y < h; y++) {
        dst[(y * w + x) * 3 + c] = sum / win;
        const yo = y - r < 0 ? 0 : y - r;
        const yiRaw = y + r + 1;
        const yi = yiRaw >= h ? h - 1 : yiRaw;
        sum += src[(yi * w + x) * 3 + c] - src[(yo * w + x) * 3 + c];
      }
    }
  }
}
