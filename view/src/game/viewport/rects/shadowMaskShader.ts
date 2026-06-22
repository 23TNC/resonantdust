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
} from "pixi.js";

/**
 * Projected-silhouette shadow mask (the #2 technique — real silhouettes from the
 * geometry sidecars, replacing the old 1D wedge cone). For each hot light, every
 * nearby caster's earcut triangulation is projected through the light onto the
 * ground (a billboard shear: each vertex slides away from the light by a distance
 * that grows with its height up the sprite, `h/(lightZ−h)`), and rasterized as flat
 * filled triangles into ONE channel of an RGBA mask RT. The display shader samples
 * the mask and subtracts `mask[lightIndex]` from that light's contribution.
 *
 * The per-light channel rides the **mesh tint** — the only per-mesh value that binds
 * in this codebase (custom vertex attributes / float uniforms read 0 through both the
 * high-shader and hand-written GlProgram paths; see `depthShaders.ts`). Each light is
 * a separate child mesh tinted to its channel, all in one container rendered ONCE with
 * `max` blend (a second `renderer.render` into the same RT silently no-ops — the depth
 * saga's trap), so overlapping casters and other lights' channels both survive.
 */

/** Hot lights whose shadows fit the RGBA mask's channels (one per R/G/B). Lights past
 *  this cast no shadow — rare, the cursor is the usual lone hot light. */
export const MAX_SHADOW_LIGHTS = 3;

/** Per-light channel tint: light i fills mask channel i (R, G, B). */
export const SHADOW_CHANNEL_TINT = [0xff0000, 0x00ff00, 0x0000ff];

/** Safety cap on casters projected per light — the NEAREST this-many to the light
 *  (sorted by distance, not map order). Set high; the light's radius is the real bound.
 *  The vertex buffer grows on demand, so this is just a runaway guard, not a hard limit. */
export const MAX_SHADOW_CASTERS = 256;

/** Cap on the base→light distance used in the projection length (px). The perspective
 *  shear `hUp/(lightZ−hUp)·dist` otherwise makes far casters throw very long shadows and
 *  near ones almost none — capping `dist` keeps shadow length stable as the cursor roams. */
export const SHADOW_DBL_CAP = 240;

/** Absolute cap on a projected shadow's length (px). A low cursor light makes the
 *  `hUp/(lightZ−hUp)` ratio explode (denominator → 0); this clamps the runaway so a
 *  low light still gives long-but-sane shadows instead of screen-spanning streaks. */
export const SHADOW_MAX_LEN = 280;

/** Initial projected-vertex capacity per light (3 per triangle). The buffer DOUBLES on
 *  demand (`RectComposite.ensureShadowCapacity`) when a dense caster set needs more, so
 *  the caster count is effectively unbounded — this is just the starting allocation. */
export const MAX_SHADOW_VERTS = 8192;

/** Occluder height as a fraction of its sprite px — the billboard's modelled height
 *  for the projection shear (tweak + HMR). Matched the old wedge's value. */
export const SHADOW_OCC_HEIGHT_SCALE = 0.5;

/** Shadows projecting NORTH (away from a southern light, screen −Y) are foreshortened by
 *  the ground's recede; stretch their Y-offset by this so they read as long as southward
 *  ones. 1 = symmetric. South (+Y) is left untouched. (tweak + HMR) */
export const SHADOW_NORTH_STRETCH = 1.8;

// Solid-fill shadow: textureBit set `outColor` from the (white) sampler; overwrite it
// with the channel tint (`vColor`, premultiplied). `max` blend accumulates coverage.
const shadowMaskBitGl = {
  name: "shadow-mask-bit",
  fragment: {
    main: /* glsl */ `outColor = vColor;`,
  },
};

let program: GlProgram | null = null;
function shadowProgram(): GlProgram {
  if (!program) {
    program = compileHighShaderGlProgram({
      name: "shadow-mask",
      bits: [localUniformBitGl, textureBitGl, shadowMaskBitGl, roundPixelsBitGl],
    });
  }
  return program;
}

/** Flat-fill shadow shader: outputs the mesh tint (the per-light channel). No
 *  per-fragment data beyond the tint — the silhouette shape lives in the geometry. */
export class ShadowMaskShader extends Shader {}

export function makeShadowMaskShader(): ShadowMaskShader {
  const white = Texture.WHITE;
  return new ShadowMaskShader({
    glProgram: shadowProgram(),
    resources: {
      uTexture: white.source,
      uSampler: white.source.style,
      textureUniforms: { uTextureMatrix: { type: "mat3x3<f32>", value: new Matrix() } },
    },
  });
}

/** Geometry for one light's projected-silhouette triangles, holding `cap` vertices.
 *  Non-indexed triangle list (3 verts per tri), drawn via a sequential index buffer so
 *  the draw count is fixed; the tail past the live vertex count is zeroed → degenerate
 *  triangles draw nothing. `aUV` is unused (the fragment emits the tint) but textureBit's
 *  vertex stage needs it. `cap` doubles on demand (`ensureShadowCapacity`). */
export function makeShadowGeometry(cap: number = MAX_SHADOW_VERTS): { geometry: Geometry; pos: Buffer } {
  const pos = new Buffer({ data: new Float32Array(cap * 2), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
  const uv = new Buffer({ data: new Float32Array(cap * 2), usage: BufferUsage.VERTEX });
  const indices = new Uint32Array(cap);
  for (let i = 0; i < cap; i++) indices[i] = i;
  const geometry = new Geometry({
    attributes: {
      aPosition: { buffer: pos, format: "float32x2" },
      aUV: { buffer: uv, format: "float32x2" },
    },
    indexBuffer: new Buffer({ data: indices, usage: BufferUsage.INDEX | BufferUsage.COPY_DST }),
  });
  return { geometry, pos };
}
