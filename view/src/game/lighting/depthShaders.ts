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
 * **sort key** is baked per chunk into an `rgba8` depth target, resolved across
 * chunks into one screen-space depth via a `max`-blend pass (frontmost wins,
 * order-independent), and sampled by the chunk composite + dynamic movers to
 * `discard` occluded fragments.
 *
 * The sort key is the primitive's **hex row** (`worldY / rowStep`), packed so a
 * per-channel `max`-blend is correct BY CONSTRUCTION:
 *   • R = the hex row (integer part), biased by {@link ROW_BIAS} so rows north of
 *     the origin stay non-negative. `max` resolves depth ROW-FIRST — souther wins.
 *   • G = the sub-row Y offset (fractional part × 255). It only decides when two
 *     prims share a row (R ties) — exactly when per-channel max on G is valid.
 * B+A are free (a spare `u16` for later). Written only where the albedo is opaque
 * enough to be the visual owner (the hard-silhouette `alpha > threshold` rule —
 * one depth buffer can't represent partial occlusion). `rgba8` (not `r16float`)
 * keeps depth a colour-pipeline-native texture: Sprites copy it without mangling
 * and `max`-blend needs no float-blend extension.
 */

/** Alpha cutoff for a static fragment to claim the depth (hard silhouette). Soft
 *  fringe below this falls through to whatever's behind. Tuned by eye. */
export const DEPTH_ALPHA_THRESHOLD = 0.5;

/** Hex row 0 maps to this R byte, so rows in `[-ROW_BIAS, 255-ROW_BIAS]` encode
 *  monotonically (south = larger R = front) with no wrap. Centred → ±128 rows of
 *  headroom around the origin before R clamps (and depth flattens); at rowStep
 *  ≈129px that's ≈±16.5k px — far beyond any one texture's reach. */
export const ROW_BIAS = 128;

// ── OBJECT depth: per-primitive hex-row sort key across its silhouette ────────
// Each primitive's sort key rides the MESH TINT (`uColor` → `vColor`) — the one
// per-object channel that BINDS here (readbacks proved compileHighShaderGlProgram
// drops custom attributes/uniforms, and a hand-written GlProgram's transform UBO
// doesn't bind; only built-ins — position, tint, gl_FragCoord — work). `encodeDepthTint`
// packs row→R, sub-row→G into the tint; we pass those two bytes straight through to the
// depth target's R+G. The silhouette is the sampled albedo's alpha; drawn `max`-blended
// so the frontmost (souther row, then souther sub-row) wins per pixel.
const objectDepthBitGl = {
  name: "object-depth-bit",
  fragment: {
    // outColor = sampled albedo (textureBit); vColor = the per-mesh tint (row in .r,
    // sub-row in .g). Pass the two bytes through where opaque; else 0 (loses every max).
    main: /* glsl */ `
      outColor = outColor.a > ${DEPTH_ALPHA_THRESHOLD.toFixed(1)} ? vec4(vColor.r, vColor.g, 0.0, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
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

/** Per-primitive silhouette depth shader. `texture` = the primitive's albedo; the
 *  depth value is carried by the MESH TINT (set per primitive in the bake), not a
 *  shader uniform. `setTint(sortY)` encodes a world-Y into the 8-bit grey tint. */
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

/** Encode a primitive's world-Y into the depth tint (`0xRRGGBB`): R = hex row
 *  (`floor(worldY/rowStep)` + {@link ROW_BIAS}, clamped to a byte), G = sub-row
 *  offset (`frac × 255`). The shader passes R+G straight to the depth target, where
 *  a per-channel `max`-blend sorts row-first with the sub-row as tiebreak. B stays 0
 *  (free). `rowStep` = `1.5 × worldHexRadius()` (pixels per Δr). */
export function encodeDepthTint(worldY: number, rowStep: number): number {
  const rowF = worldY / rowStep;
  const rowI = Math.floor(rowF);
  const r = Math.max(0, Math.min(255, rowI + ROW_BIAS));
  const g = Math.max(0, Math.min(255, Math.round((rowF - rowI) * 255)));
  return (r << 16) | (g << 8);
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

/** Geometry for one depth quad. `aPosition` is set per primitive to its world bounds;
 *  `aUV` is fixed (the texture matrix maps the frame). Depth rides the mesh tint.
 *  The V is flipped (top verts → V=1) because this quad samples the object's ATLAS
 *  FRAME directly, whereas the lit pass samples a RenderTexture (PIXI stores those
 *  Y-flipped) — without this, every silhouette bakes upside-down and the discard cuts
 *  inverted-object holes (asymmetric prims like pines reveal it; symmetric hexes hide it). */
export function makeDepthQuadGeometry(): Geometry {
  return new Geometry({
    attributes: {
      aPosition: { buffer: new Buffer({ data: new Float32Array(8), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: "float32x2", stride: 2 * 4, offset: 0 },
      aUV: { buffer: new Buffer({ data: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: "float32x2", stride: 2 * 4, offset: 0 },
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
      // Decode the packed sort key (R = biased row, G = sub-row) into one monotonic
      // scalar (0..65535): R dominates (×256), G breaks ties. Only the ordering
      // matters; the absolute scale is arbitrary.
      float decodeDepth(vec4 d) { return d.r * 65280.0 + d.g * 255.0; }
    `,
    main: /* glsl */ `
      vec2 suv = gl_FragCoord.xy / uScreenSize;
      if (uFlipY > 0.5) suv.y = 1.0 - suv.y;
      float screenD = decodeDepth(texture(uScreenDepth, suv));
      if (uDebug > 0.5) {
        // Diagnostic: R = this chunk's own depth, G = resolved screen depth.
        // Yellow (R≈G) = match (kept); GREEN (own < screen) = DISCARDED (the holes);
        // red (own > screen) = this chunk in front. Reveals the ownD/screenD mismatch.
        float own = decodeDepth(texture(uOwnDepth, vUV)) / 65535.0;
        outColor = vec4(own, screenD / 65535.0, 0.0, 1.0);
      } else {
        float ownD = decodeDepth(texture(uOwnDepth, vUV));
        // Behind the pixel's owner (small byte-slack bias) → drop it.
        if (ownD < screenD - 2.0) discard;
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
  setDebug(on: boolean): void {
    this.resources.compositeUniforms.uniforms.uDebug = on ? 1 : 0;
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
      }),
    },
  });
}
