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
 * Projected-silhouette shadow mask (the #2 technique — real silhouettes from the
 * geometry sidecars, replacing the old 1D wedge cone). For each hot light, every
 * nearby caster's earcut triangulation is projected through the light onto the
 * ground (a billboard shear: each vertex slides away from the light by a distance
 * that grows with its height up the sprite, `h/(lightZ−h)`), and rasterized as flat
 * filled triangles into ONE channel of an RGBA mask RT. The display shader samples
 * the mask and subtracts `mask[lightIndex]` from that light's contribution.
 *
 * The per-light channel is a `uChannel` vec4 UNIFORM (a 1 in one lane) output directly —
 * NOT the mesh tint. The tint is premultiplied (rgb × worldAlpha), so it couples RGB to
 * alpha: a tint can't write the alpha lane without also writing rgb, which is exactly why
 * the alpha channel was unusable and the cap was 3 (R/G/B). Declaring `uChannel` in the
 * bit binds it fine (the high-shader inserts it — see depthShaders.ts / bitfield.ts). With
 * 4 clean lanes × {@link SHADOW_MAPS} maps we get 8 lights. Each light is a child mesh, all
 * in one container rendered ONCE per map with `max` blend (a second `renderer.render` into
 * the same RT silently no-ops — the depth saga's trap) so overlapping casters + other lanes
 * all survive.
 */

/** Number of RGBA scatter maps (4 lights each). Two → 8 fresh dynamic-light shadows/frame
 *  (docs/tiered_lighting.md Phase 1). */
export const SHADOW_MAPS = 2;

/** Dynamic lights whose shadows fit the scatter maps (4 channels × {@link SHADOW_MAPS}).
 *  Lights past this cast no shadow this frame (the warm round-robin, Phase 2, cycles them). */
export const MAX_SHADOW_LIGHTS = 4 * SHADOW_MAPS;

/** Which mask (0..SHADOW_MAPS-1) light `i` writes, and its channel within that map. */
export const shadowMapOf = (i: number): number => i >> 2;

/** The channel-select vec4 for light `i`: a 1 in lane `i & 3` (R/G/B/A), 0 elsewhere. Used
 *  as the shader output directly (NOT the premultiplied tint — tint couples RGB to worldAlpha,
 *  which is exactly why the alpha lane was unusable and the cap was 3; see `setChannel`). */
export function channelForLight(i: number): [number, number, number, number] {
  const c = i & 3;
  return [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0, c === 3 ? 1 : 0];
}

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

/** Occluder height as a fraction of its sprite px — the billboard's modelled height for the
 *  projection shear. The BASE value (small casters); taller ones diminish, see {@link shadowHeightScale}. */
export const SHADOW_OCC_HEIGHT_SCALE = 0.5;

/** Sprite height (world px) at/below which a caster uses the full {@link SHADOW_OCC_HEIGHT_SCALE}.
 *  Bush-ish — tune so bushes hit the 0.5 you like; taller casters fall off from here. (HMR) */
export const SHADOW_HEIGHT_REF = 100;

/** Height-scale drop per DOUBLING of sprite height past {@link SHADOW_HEIGHT_REF}. So 2× ref =
 *  0.4, 4× ref = 0.3, 8× = 0.2 … taming the perspective blowup that elongates tall-caster tips. */
export const SHADOW_HEIGHT_FALLOFF = 0.1;

/** Floor on the diminished height scale (very tall casters can't fall below this). */
export const SHADOW_HEIGHT_MIN = 0.15;

/** The occluder height scale for a caster of sprite height `h`: full at/below the reference,
 *  then `−FALLOFF` per doubling. Shorter shadows (less perspective stretch) for tall casters,
 *  while bushes keep the look you like. `scale = BASE − FALLOFF·log2(h/ref)`, clamped. */
export function shadowHeightScale(h: number): number {
  const f = SHADOW_OCC_HEIGHT_SCALE - SHADOW_HEIGHT_FALLOFF * Math.log2(Math.max(h, 1) / SHADOW_HEIGHT_REF);
  return Math.max(SHADOW_HEIGHT_MIN, Math.min(SHADOW_OCC_HEIGHT_SCALE, f));
}

/** Shadows projecting NORTH (away from a southern light, screen −Y) are foreshortened by
 *  the ground's recede; stretch their Y-offset by this so they read as long as southward
 *  ones. 1 = symmetric. South (+Y) is left untouched. (tweak + HMR) */
export const SHADOW_NORTH_STRETCH = 1.8;

// Solid-fill shadow: textureBit set `outColor` from the (white) sampler; overwrite it with
// the per-light channel mask (`uChannel`, a 1 in one lane). `max` blend accumulates coverage
// per lane. NOT the tint — see the file header (tint premultiply couples rgb↔alpha).
const shadowMaskBitGl = {
  name: "shadow-mask-bit",
  fragment: {
    header: /* glsl */ `uniform vec4 uChannel;`,
    main: /* glsl */ `outColor = uChannel;`,
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

/** Flat-fill shadow shader: outputs `uChannel` (the per-light lane). The silhouette shape
 *  lives in the geometry; the lane is a per-mesh uniform set once via {@link setChannel}. */
export class ShadowMaskShader extends Shader {
  /** Point this mesh's coverage at one mask lane (a 1 in r/g/b/a, 0 elsewhere). */
  setChannel(rgba: readonly [number, number, number, number]): void {
    const u = this.resources.channelUniforms.uniforms;
    (u.uChannel as Float32Array).set(rgba);
    this.resources.channelUniforms.update();
  }
}

export function makeShadowMaskShader(): ShadowMaskShader {
  const white = Texture.WHITE;
  return new ShadowMaskShader({
    glProgram: shadowProgram(),
    resources: {
      uTexture: white.source,
      uSampler: white.source.style,
      channelUniforms: new UniformGroup({ uChannel: { value: new Float32Array([1, 0, 0, 0]), type: "vec4<f32>" } }),
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
