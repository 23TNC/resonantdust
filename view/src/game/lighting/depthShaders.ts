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
  Geometry,
  Buffer,
  BufferUsage,
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

// ── OBJECT depth: per-primitive base sort-Y across its silhouette ────────────
// Each primitive (tile or object) writes its BASE sort-Y flat across its silhouette
// so a tall object's canopy carries its feet's key. The sort-Y travels as a PER-
// VERTEX ATTRIBUTE → varying (`aSortY` → `vSortY`), NOT a uniform: in this codebase's
// HighShader setup, custom float uniforms read 0 at draw time while varyings bind
// (the old coverage pass only "worked" because it used a varying). The threshold and
// empty sentinel are inlined as GLSL literals for the same reason. `textureBit` gives
// the albedo silhouette (its alpha); drawn `max`-blended so the frontmost sort-Y wins.
const objectDepthBitGl = {
  name: "object-depth-bit",
  vertex: {
    header: /* glsl */ `
      in float aSortY;
      out float vSortY;
    `,
    main: /* glsl */ `
      vSortY = aSortY;
    `,
  },
  fragment: {
    header: /* glsl */ `
      in float vSortY;
    `,
    // 0.5 = DEPTH_ALPHA_THRESHOLD, -1000000.0 = DEPTH_EMPTY (inlined — see above).
    main: /* glsl */ `
      outColor = vec4(outColor.a > 0.5 ? vSortY : -1000000.0, 0.0, 0.0, 1.0);
    `,
  },
};

let objectProgram: GlProgram | null = null;
function objectDepthProgram(): GlProgram {
  if (!objectProgram) {
    objectProgram = compileHighShaderGlProgram({
      name: "object-depth",
      bits: [localUniformBitGl, textureBitGl, objectDepthBitGl, roundPixelsBitGl],
    });
  }
  return objectProgram;
}

/** Per-primitive silhouette depth shader. `texture` = the primitive's albedo (its
 *  frame UVs come from the texture matrix). Sort-Y is NOT a shader uniform — it's a
 *  per-vertex `aSortY` attribute on the geometry (see {@link makeDepthQuadGeometry}). */
export class ObjectDepthShader extends Shader {
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
}

export function makeObjectDepthShader(): ObjectDepthShader {
  const empty = Texture.EMPTY;
  return new ObjectDepthShader({
    glProgram: objectDepthProgram(),
    resources: {
      uTexture: empty.source,
      uSampler: empty.source.style,
      textureUniforms: { uTextureMatrix: { type: "mat3x3<f32>", value: new Matrix() } },
    },
  });
}

/** Geometry for one depth quad: a unit-quad with `aPosition` (set per primitive to
 *  its world bounds), `aUV` (fixed), and a custom `aSortY` (all 4 verts = the
 *  primitive's base sort-Y) carried to the fragment as a varying. */
export function makeDepthQuadGeometry(): Geometry {
  return new Geometry({
    attributes: {
      aPosition: { buffer: new Buffer({ data: new Float32Array(8), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: "float32x2", stride: 2 * 4, offset: 0 },
      aUV: { buffer: new Buffer({ data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: "float32x2", stride: 2 * 4, offset: 0 },
      aSortY: { buffer: new Buffer({ data: new Float32Array(4), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: "float32", stride: 4, offset: 0 },
    },
    indexBuffer: new Buffer({ data: new Uint32Array([0, 1, 2, 0, 2, 3]), usage: BufferUsage.INDEX | BufferUsage.COPY_DST }),
  });
}

// ── COMPOSITE: display a chunk's lit colour, occluded by the screen depth ─────
// One per chunk (binds its own lit + depth). `uTexture` = the chunk's lit colour
// (sampled into outColor at vUV); `uOwnDepth` = the chunk's sort-Y at vUV;
// `uScreenDepth` = the resolved frontmost sort-Y across ALL chunks, sampled at the
// fragment's screen position (`gl_FragCoord`). Discard where this chunk is behind
// the screen winner (something else owns the pixel). `uDebug` paints the sampled
// screen depth as greyscale instead — to confirm the resolve + screen sampling
// align with the 4A per-chunk gradient.
const depthCompositeBitGl = {
  name: "depth-composite-bit",
  fragment: {
    header: /* glsl */ `
      uniform sampler2D uOwnDepth;
      uniform sampler2D uScreenDepth;
      uniform vec2 uScreenSize;   // framebuffer px (CSS × resolution)
      uniform float uFlipY;       // 1.0 → flip the screen sample's Y
      uniform float uDebug;       // 1.0 → paint screen depth grey (alignment check)
      uniform float uDbgMin;
      uniform float uDbgMax;
    `,
    main: /* glsl */ `
      vec2 suv = gl_FragCoord.xy / uScreenSize;
      if (uFlipY > 0.5) suv.y = 1.0 - suv.y;
      float screenD = texture(uScreenDepth, suv).r;
      if (uDebug > 0.5) {
        float g = clamp((screenD - uDbgMin) / max(uDbgMax - uDbgMin, 1.0), 0.0, 1.0);
        outColor = vec4(vec3(g), 1.0);
      } else {
        float ownD = texture(uOwnDepth, vUV).r;
        // Behind the pixel's owner (with a small bias for float slack) → drop it.
        if (ownD < screenD - 1.0) discard;
        // outColor is the lit colour (textureBit), premultiplied — show as-is.
      }
    `,
  },
};

let compositeProgram: GlProgram | null = null;
function depthCompositeProgram(): GlProgram {
  if (!compositeProgram) {
    compositeProgram = compileHighShaderGlProgram({
      name: "depth-composite",
      bits: [localUniformBitGl, textureBitGl, depthCompositeBitGl, roundPixelsBitGl],
    });
  }
  return compositeProgram;
}

/** Per-chunk display shader: lit colour `discard`ed where the chunk is behind the
 *  resolved screen depth. `texture` = the lit RT; `ownDepth` = this chunk's depth RT;
 *  shared screen-depth + size set each frame. */
export class DepthCompositeShader extends Shader {
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
  set ownDepth(value: Texture) {
    this.resources.uOwnDepth = value.source;
    this.resources.uOwnDepthSampler = value.source.style;
  }
  setScreen(depth: Texture, sizeX: number, sizeY: number, flipY: boolean): void {
    this.resources.uScreenDepth = depth.source;
    this.resources.uScreenDepthSampler = depth.source.style;
    const u = this.resources.compositeUniforms.uniforms;
    u.uScreenSize = [sizeX, sizeY];
    u.uFlipY = flipY ? 1 : 0;
    this.resources.compositeUniforms.update();
  }
  setDebug(on: boolean, min: number, max: number): void {
    const u = this.resources.compositeUniforms.uniforms;
    u.uDebug = on ? 1 : 0;
    u.uDbgMin = min;
    u.uDbgMax = max;
    this.resources.compositeUniforms.update();
  }
}

export function makeDepthCompositeShader(): DepthCompositeShader {
  const empty = Texture.EMPTY;
  return new DepthCompositeShader({
    glProgram: depthCompositeProgram(),
    resources: {
      uTexture: empty.source,
      uSampler: empty.source.style,
      textureUniforms: { uTextureMatrix: { type: "mat3x3<f32>", value: new Matrix() } },
      uOwnDepth: empty.source,
      uOwnDepthSampler: empty.source.style,
      uScreenDepth: empty.source,
      uScreenDepthSampler: empty.source.style,
      compositeUniforms: new UniformGroup({
        uScreenSize: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
        uFlipY: { value: 1, type: "f32" },
        uDebug: { value: 0, type: "f32" },
        uDbgMin: { value: 0, type: "f32" },
        uDbgMax: { value: 1, type: "f32" },
      }),
    },
  });
}
