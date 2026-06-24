import {
  compileHighShaderGlProgram,
  localUniformBitGl,
  textureBitGl,
  roundPixelsBitGl,
  GlProgram,
  Shader,
  Texture,
  Matrix,
  Geometry,
  Buffer,
  BufferUsage,
  RenderTexture,
  Container,
  Mesh,
  type Renderer,
} from "pixi.js";

/**
 * 32-light occlusion bitfield packed into one rgba8 texel: channel `c` (0..3) holds
 * lights `c*8 .. c*8+7`, bit `b` (0..7) of that channel = light `c*8 + b`. Used by the
 * warm `warm_shadowmap` (which 32 dynamic lights reach each pixel) and the cold per-pixel
 * active map. See docs/tiered_lighting.md.
 *
 * Built on the CPU (cold) or by a ping-pong combine shader (warm); read in the display
 * shader. We extract bits with FLOAT-MOD in GLSL ES 1.00 rather than `#version 300 es`
 * uint ops — lossless because rgba8 stores `n/255` exactly, zero risk to PIXI's stock
 * high-shader bits, and trivially cheap. The display loops `c = 0..3` × `b = 0..7` (NOT a
 * flat 0..31) to avoid ES-1.00 dynamic vector indexing.
 */

// ── CPU pack / unpack (also the test oracle) ───────────────────────────────────
/** Pack a set of light indices (0..31) into the four rgba8 bytes `[r,g,b,a]`. */
export function packBitfield(set: Iterable<number>): [number, number, number, number] {
  const bytes: [number, number, number, number] = [0, 0, 0, 0];
  for (const i of set) {
    if (i < 0 || i > 31) continue;
    bytes[i >> 3] |= 1 << (i & 7);
  }
  return bytes;
}

/** True if light `i` (0..31) is set in a packed bitfield `[r,g,b,a]`. CPU mirror of the
 *  GLSL `bf_bit(bf_byte(...))` — kept identical so tests pin the shader math. */
export function bitSetCPU(bytes: ArrayLike<number>, i: number): boolean {
  return ((bytes[i >> 3] >> (i & 7)) & 1) === 1;
}

// ── GLSL extractor (reused by warm display + cold active map) ───────────────────
/** Float-mod bitfield extraction helpers. Inject into a fragment header, then per light:
 *  `bf_bit(bf_byte(texel, c), b) > 0.5`. Both args are runtime ints (channel-select is a
 *  ternary ladder, not dynamic vector indexing — ES-1.00 safe). */
export const BITFIELD_GLSL = /* glsl */ `
  float bf_byte(vec4 texel, int c) {
    float v = c == 0 ? texel.r : (c == 1 ? texel.g : (c == 2 ? texel.b : texel.a));
    return floor(v * 255.0 + 0.5);
  }
  float bf_bit(float byteVal, int b) {
    return mod(floor(byteVal / exp2(float(b))), 2.0);
  }
`;

// ── In-browser spike: prove the GLSL extractor binds + reads every bit ──────────
const spikeBitGl = {
  name: "bitfield-spike-bit",
  fragment: {
    header: /* glsl */ `uniform sampler2D uField; ${BITFIELD_GLSL}`,
    // Each output pixel x∈0..31 emits bit x of the field: bitIndex from vUV.x, split into
    // channel + bit, extracted via the helpers. White = set, black = clear.
    main: /* glsl */ `
      int bitIndex = int(floor(vUV.x * 32.0));
      int c = bitIndex / 8;
      int b = bitIndex - c * 8;
      float on = bf_bit(bf_byte(texture(uField, vec2(0.5)), c), b);
      outColor = vec4(on, on, on, 1.0);
    `,
  },
};

let spikeProgram: GlProgram | null = null;
function makeSpikeProgram(): GlProgram {
  if (!spikeProgram) {
    spikeProgram = compileHighShaderGlProgram({
      name: "bitfield-spike",
      bits: [localUniformBitGl, textureBitGl, spikeBitGl, roundPixelsBitGl],
    });
  }
  return spikeProgram;
}

/**
 * Render the float-mod extractor over a known 32-bit pattern and read every bit back.
 * Proves the helper binds in our real high-shader pipeline and that the rgba8 round-trip
 * is bit-exact. Returns pass + a human detail string. Throwaway — call once from a dev
 * hook, confirm, remove the call (the helpers above stay).
 */
export function runBitfieldSpike(renderer: Renderer): { pass: boolean; detail: string } {
  // A pattern spanning all four channels + both edges of each byte.
  const setBits = [0, 5, 8, 15, 16, 23, 24, 31];
  const [r, g, b, a] = packBitfield(setBits);

  // field: a 1×1 rgba8 cleared to the pattern (the clear path is gamma-free — a clear of
  // 128 reads back 128, unlike the tint path).
  const field = RenderTexture.create({ width: 1, height: 1 });
  renderer.render({ container: new Container(), target: field, clear: true, clearColor: [r / 255, g / 255, b / 255, a / 255] });

  // out: 32×1 — pixel x = bit x.
  const out = RenderTexture.create({ width: 32, height: 1 });
  const geometry = new Geometry({
    attributes: {
      aPosition: { buffer: new Buffer({ data: new Float32Array([0, 0, 32, 0, 32, 1, 0, 1]), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: "float32x2", stride: 2 * 4, offset: 0 },
      aUV: { buffer: new Buffer({ data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), usage: BufferUsage.VERTEX }), format: "float32x2", stride: 2 * 4, offset: 0 },
    },
    indexBuffer: new Buffer({ data: new Uint32Array([0, 1, 2, 0, 2, 3]), usage: BufferUsage.INDEX | BufferUsage.COPY_DST }),
  });
  const white = Texture.WHITE;
  const shader = new Shader({
    glProgram: makeSpikeProgram(),
    resources: {
      uTexture: white.source,
      uSampler: white.source.style,
      uField: field.source,
      uFieldSampler: field.source.style,
      textureUniforms: { uTextureMatrix: { type: "mat3x3<f32>", value: new Matrix() } },
    },
  });
  const mesh = new Mesh<Geometry, Shader>({ geometry, shader });
  const container = new Container();
  container.addChild(mesh);
  renderer.render({ container, target: out, clear: true, clearColor: [0, 0, 0, 1] });

  const raw = renderer.extract.pixels(out) as unknown as { pixels: Uint8ClampedArray } | Uint8ClampedArray;
  const px = (raw as { pixels: Uint8ClampedArray }).pixels ?? (raw as Uint8ClampedArray);

  const wrong: number[] = [];
  for (let i = 0; i < 32; i++) {
    const got = px[i * 4] > 127; // R channel of pixel i
    const want = bitSetCPU([r, g, b, a], i);
    if (got !== want) wrong.push(i);
  }

  field.destroy(true);
  out.destroy(true);
  geometry.destroy();

  const pass = wrong.length === 0;
  const detail = pass
    ? `bitfield spike OK — all 32 bits round-trip (pattern ${[r, g, b, a].join(",")}, set ${setBits.join(",")})`
    : `bitfield spike FAIL — wrong bits: ${wrong.join(",")} (pattern ${[r, g, b, a].join(",")})`;
  return { pass, detail };
}
