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
  UniformGroup,
} from "pixi.js";

/**
 * Warm-field ping-pong combine (docs/tiered_lighting.md Phase 2). Folds this frame's 8 fresh
 * scatter lanes into ONE channel of the 32-bit `warm_shadowmap`, carrying the other three from
 * the previous field. Round-robin: 32 lights / 8-per-frame = 4-frame cycle, so the fresh batch
 * is exactly the 8 lights of one byte-channel — light `i` lives in warm channel `i>>3`, and the
 * batch aligned to 8 means the fresh 8 ARE one channel. So the combine only rewrites the fresh
 * channel; `uFreshSel` (a 1 in that channel) selects it.
 *
 * bit = 1 means SHADOWED (scatter coverage > 0.5 → hard-thresholded; warm shadows are hard, the
 * temporal pop is smoothed by the display cross-fade not the spatial edge). Output is written
 * with blendMode "none" (verbatim RGBA — no premultiply, so the alpha channel/batch-3 survives).
 */
const warmCombineBitGl = {
  name: "warm-combine-bit",
  fragment: {
    header: /* glsl */ `
      uniform sampler2D uPrevWarm;   // last frame's 32-bit field
      uniform sampler2D uScatter0;   // fresh batch lanes 0..3 (R/G/B/A)
      uniform sampler2D uScatter1;   // fresh batch lanes 4..7
      uniform vec4 uFreshSel;        // 1 in the channel this frame's batch writes, else 0
      uniform vec2 uPanDelta;        // UV pan since last frame — scrolls carried channels so they track the world
    `,
    // Pack the 8 thresholded lanes (LSB = lane 0) into a byte, drop it in the fresh channel,
    // keep prev elsewhere. `step(0.5, cov)` = hard shadow bit.
    main: /* glsl */ `
      // Scroll the carried field by the pan delta so accumulated bits stay world-aligned; the
      // fresh batch (scatter, below) is written at current positions. Revealed edges → 0 (lit).
      // Warm sampling is NEAREST (bits don't interpolate), which also quantizes the shift to texels.
      vec2 puv = vUV - uPanDelta;
      bool revealed = puv.x < 0.0 || puv.x > 1.0 || puv.y < 0.0 || puv.y > 1.0;
      vec4 prev = revealed ? vec4(0.0) : texture(uPrevWarm, puv);
      vec4 m0 = texture(uScatter0, vUV);
      vec4 m1 = texture(uScatter1, vUV);
      float fieldByte = (step(0.5, m0.r) +  step(0.5, m0.g) * 2.0  + step(0.5, m0.b) * 4.0   + step(0.5, m0.a) * 8.0
                       + step(0.5, m1.r) * 16.0 + step(0.5, m1.g) * 32.0 + step(0.5, m1.b) * 64.0 + step(0.5, m1.a) * 128.0) / 255.0;
      outColor = prev * (vec4(1.0) - uFreshSel) + vec4(fieldByte) * uFreshSel;
    `,
  },
};

let program: GlProgram | null = null;
function warmCombineProgram(): GlProgram {
  if (!program) {
    program = compileHighShaderGlProgram({
      name: "warm-combine",
      bits: [localUniformBitGl, textureBitGl, warmCombineBitGl, roundPixelsBitGl],
    });
  }
  return program;
}

/** The ping-pong combine shader. `prevWarm`/`scatter0`/`scatter1` are the inputs; `setFresh`
 *  picks which channel (0..3) the fresh 8-light batch writes this frame. */
export class WarmCombineShader extends Shader {
  set prevWarm(t: Texture) {
    this.resources.uPrevWarm = t.source;
    this.resources.uPrevWarmSampler = t.source.style;
  }
  set scatter0(t: Texture) {
    this.resources.uScatter0 = t.source;
    this.resources.uScatter0Sampler = t.source.style;
  }
  set scatter1(t: Texture) {
    this.resources.uScatter1 = t.source;
    this.resources.uScatter1Sampler = t.source.style;
  }
  /** Channel 0..3 the fresh batch writes (= round-robin batch index). */
  setFresh(channel: number): void {
    const u = this.resources.warmUniforms.uniforms.uFreshSel as Float32Array;
    u[0] = channel === 0 ? 1 : 0;
    u[1] = channel === 1 ? 1 : 0;
    u[2] = channel === 2 ? 1 : 0;
    u[3] = channel === 3 ? 1 : 0;
    this.resources.warmUniforms.update();
  }
  /** UV pan delta since the previous frame (scrolls the carried channels). */
  setPanDelta(u: number, v: number): void {
    const d = this.resources.warmUniforms.uniforms.uPanDelta as Float32Array;
    d[0] = u;
    d[1] = v;
    this.resources.warmUniforms.update();
  }
}

export function makeWarmCombineShader(): WarmCombineShader {
  const white = Texture.WHITE;
  return new WarmCombineShader({
    glProgram: warmCombineProgram(),
    resources: {
      uTexture: white.source,
      uSampler: white.source.style,
      uPrevWarm: white.source,
      uPrevWarmSampler: white.source.style,
      uScatter0: white.source,
      uScatter0Sampler: white.source.style,
      uScatter1: white.source,
      uScatter1Sampler: white.source.style,
      warmUniforms: new UniformGroup({
        uFreshSel: { value: new Float32Array([1, 0, 0, 0]), type: "vec4<f32>" },
        uPanDelta: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
      }),
      textureUniforms: { uTextureMatrix: { type: "mat3x3<f32>", value: new Matrix() } },
    },
  });
}

/** A full-screen quad (pixel coords 0..w, 0..h; uv 0..1) for the combine pass. */
export function makeWarmQuadGeometry(w: number, h: number): Geometry {
  return new Geometry({
    attributes: {
      aPosition: { buffer: new Buffer({ data: new Float32Array([0, 0, w, 0, w, h, 0, h]), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: "float32x2", stride: 2 * 4, offset: 0 },
      aUV: { buffer: new Buffer({ data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), usage: BufferUsage.VERTEX }), format: "float32x2", stride: 2 * 4, offset: 0 },
    },
    indexBuffer: new Buffer({ data: new Uint32Array([0, 1, 2, 0, 2, 3]), usage: BufferUsage.INDEX | BufferUsage.COPY_DST }),
  });
}
