import {
  compileHighShaderGlProgram,
  localUniformBitGl,
  textureBitGl,
  roundPixelsBitGl,
  GlProgram,
  Shader,
  Texture,
  Matrix,
  UniformGroup,
} from "pixi.js";

/**
 * G4 Phase 4 depth (docs/g4_renderer.md → "Depth occlusion"). The static world's
 * **sort-Y** is baked per chunk into an `r16float` depth target, resolved across
 * chunks into one screen-space depth via a `max`-blend pass (frontmost wins,
 * order-independent), and sampled by the chunk composite + dynamic movers to
 * `discard` occluded fragments. A *sort-Y* buffer, not 3D depth: the value is the
 * world-Y of the static surface owning the pixel, written only where it's opaque
 * enough to be the visual owner (the hard-silhouette `alpha > threshold` rule —
 * one depth buffer can't represent partial occlusion).
 */

/** Alpha cutoff for a static fragment to claim the depth (hard silhouette). Soft
 *  fringe below this falls through to whatever's behind — see the doc's
 *  "one depth buffer can't represent partial occlusion". Tuned by eye. */
export const DEPTH_ALPHA_THRESHOLD = 0.5;

/** "Nothing here" sort-Y. Below any real world-Y (which goes negative north of the
 *  origin), so a covered pixel always beats empty in the `max`-blend resolve and a
 *  mover over empty space is never occluded. */
export const DEPTH_EMPTY = -1.0e6;

// ── depth BAKE: chunk albedo → sort-Y target ─────────────────────────────────
// 4A placeholder source: coplanar ground's sort-Y IS its world-Y, so derive depth
// from the already-baked albedo's coverage — a full-quad post-pass writing
// `originY + localY` where albedo.alpha > threshold, else 0 (cleared, never wins a
// max). 4B replaces this source with per-object sort-Y (a standing object's pixels
// must all carry its base-Y, not their own Y) but keeps the resolve/composite.
const depthBakeBitGl = {
  name: "depth-bake-bit",
  vertex: {
    header: /* glsl */ `
      out float vLocalY;
    `,
    main: /* glsl */ `
      vLocalY = position.y;
    `,
  },
  fragment: {
    header: /* glsl */ `
      uniform float uOriginY;     // chunk world origin Y (added to the local Y)
      uniform float uThreshold;   // hard-silhouette alpha cutoff
      uniform float uEmpty;       // "nothing here" sort-Y (loses every max)
      in float vLocalY;
    `,
    // `outColor` is the sampled albedo (textureBit). Claim this pixel's sort-Y only
    // where the albedo is opaque enough; elsewhere write the empty sentinel. The
    // quad covers the whole RT, so every pixel is written (clearColor is moot).
    main: /* glsl */ `
      float cov = outColor.a;
      float worldY = uOriginY + vLocalY;
      outColor = vec4(cov > uThreshold ? worldY : uEmpty, 0.0, 0.0, 1.0);
    `,
  },
};

let bakeProgram: GlProgram | null = null;
function depthBakeProgram(): GlProgram {
  if (!bakeProgram) {
    bakeProgram = compileHighShaderGlProgram({
      name: "depth-bake",
      bits: [localUniformBitGl, textureBitGl, depthBakeBitGl, roundPixelsBitGl],
    });
  }
  return bakeProgram;
}

/** Full-quad shader that turns a chunk's albedo coverage into its sort-Y depth.
 *  `texture` is the albedo G-buffer it samples (setter binds source + flip). */
export class DepthBakeShader extends Shader {
  private _texture: Texture = Texture.EMPTY;
  get texture(): Texture {
    return this._texture;
  }
  set texture(value: Texture) {
    this._texture = value;
    this.resources.uTexture = value.source;
    this.resources.uSampler = value.source.style;
    this.resources.textureUniforms.uniforms.uTextureMatrix = value.textureMatrix.mapCoord;
    this.resources.textureUniforms.update();
  }
  set originY(y: number) {
    this.resources.depthUniforms.uniforms.uOriginY = y;
    this.resources.depthUniforms.update();
  }
}

export function makeDepthBakeShader(): DepthBakeShader {
  const empty = Texture.EMPTY;
  return new DepthBakeShader({
    glProgram: depthBakeProgram(),
    resources: {
      uTexture: empty.source,
      uSampler: empty.source.style,
      textureUniforms: { uTextureMatrix: { type: "mat3x3<f32>", value: new Matrix() } },
      depthUniforms: new UniformGroup({
        uOriginY: { value: 0, type: "f32" },
        uThreshold: { value: DEPTH_ALPHA_THRESHOLD, type: "f32" },
        uEmpty: { value: DEPTH_EMPTY, type: "f32" },
      }),
    },
  });
}

// ── debug VIEW: normalize a sort-Y target to greyscale ───────────────────────
// Dev-only (`?depthview`): an `r16float` sort-Y can't display directly (values are
// thousands of px, clamped to white), so map `[uMin,uMax]` → [0,1] grey. Empty
// (sentinel) reads black. Lets us eyeball the bake/resolve (a vertical gradient
// that pans correctly) before any consumer exists.
const depthViewBitGl = {
  name: "depth-view-bit",
  fragment: {
    header: /* glsl */ `
      uniform float uMin;
      uniform float uMax;
    `,
    main: /* glsl */ `
      float d = outColor.r;
      float g = clamp((d - uMin) / max(uMax - uMin, 1.0), 0.0, 1.0);
      outColor = vec4(vec3(g), 1.0);
    `,
  },
};

let viewProgram: GlProgram | null = null;
function depthViewProgram(): GlProgram {
  if (!viewProgram) {
    viewProgram = compileHighShaderGlProgram({
      name: "depth-view",
      bits: [localUniformBitGl, textureBitGl, depthViewBitGl, roundPixelsBitGl],
    });
  }
  return viewProgram;
}

/** Greyscale-normalize shader for a sort-Y target (dev `?depthview`). `texture` is
 *  the depth RT; `setRange` sets the world-Y window mapped to [0,1]. */
export class DepthViewShader extends Shader {
  private _texture: Texture = Texture.EMPTY;
  get texture(): Texture {
    return this._texture;
  }
  set texture(value: Texture) {
    this._texture = value;
    this.resources.uTexture = value.source;
    this.resources.uSampler = value.source.style;
    this.resources.textureUniforms.uniforms.uTextureMatrix = value.textureMatrix.mapCoord;
    this.resources.textureUniforms.update();
  }
  setRange(min: number, max: number): void {
    this.resources.viewUniforms.uniforms.uMin = min;
    this.resources.viewUniforms.uniforms.uMax = max;
    this.resources.viewUniforms.update();
  }
}

export function makeDepthViewShader(): DepthViewShader {
  const empty = Texture.EMPTY;
  return new DepthViewShader({
    glProgram: depthViewProgram(),
    resources: {
      uTexture: empty.source,
      uSampler: empty.source.style,
      textureUniforms: { uTextureMatrix: { type: "mat3x3<f32>", value: new Matrix() } },
      viewUniforms: new UniformGroup({
        uMin: { value: 0, type: "f32" },
        uMax: { value: 1, type: "f32" },
      }),
    },
  });
}
