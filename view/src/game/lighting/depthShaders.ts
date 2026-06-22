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

/** The rect-row sort key wraps every this-many rects (R byte = `mod(rectRow, …)`).
 *  255, not 256, so floored-mod yields 0..254 and leaves no value double-mapped at the
 *  seam. The consumer's wraparound compare treats a > half-period (~127) R gap as a
 *  wrap. 255 rects ≈ 22k px ≫ any viewport → on-screen pairs never alias. */
export const DEPTH_PERIOD = 255;

// ── BLUE = the LAYER axis (see docs/depth_layers.md) ──────────────────────────
// B splits the 0..255 byte into bands of {@link DEPTH_GROUP_SIZE}. The COMPARISON
// (consumer) uses the band to pick the primary key: prims in the SAME band sort by
// blue (intra-stack layering); prims in DIFFERENT bands fall back to ground R+G.
// Bigger = more front on every axis. Band 0 (0..63) holds the card/tile/stack column;
// band 1 (64..127) holds standing objects; bands 2-3 are spare.
/** Blue band width. 4 bands: 0..63, 64..127, 128..191, 192..255. `band = B >> 6`. */
export const DEPTH_GROUP_SIZE = 64;
/** A lone hex tile's layer = top of the hex column (band 0). A hex STACK fills 30→0:
 *  each added card takes a slot toward 0, pushing the tile down (max ~16 cards today,
 *  so 30..14 used, 13..0 spare). */
export const BLUE_HEX_TILE = 30;
/** A card's root layer; its top/bottom stacks live just under it at 47..31 (≈16 each
 *  way, doubled from today's 16-max for breathing room). 49..63 spare above root. */
export const BLUE_ROOT = 48;
/** Standing billboard objects (band 1). Centred in the band so manual per-object sort
 *  has room above (→127) and below (→64). */
export const BLUE_OBJECT = 80;

// ── OBJECT depth: per-primitive modular sort key across its silhouette ────────
// Each primitive's sort key rides the MESH TINT (`uColor` → `vColor`) — the one
// per-object channel that BINDS here (readbacks proved compileHighShaderGlProgram
// drops custom attributes/uniforms, and a hand-written GlProgram's transform UBO
// doesn't bind; only built-ins — position, tint, gl_FragCoord — work). `encodeDepthTint`
// packs rect-row→R, sub-rect-offset→G into the tint; we pass those two bytes straight to
// the depth target's R+G. The silhouette is the sampled albedo's alpha. Drawn SORTED
// back-to-front with OVERWRITE (normal blend): transparent fragments DISCARD (don't
// stamp 0 over what's behind), opaque ones replace — so the frontmost prim's exact two
// bytes survive. (Max-blend is wrong here: per-channel max mangles a wrapped 2-byte key.)
const objectDepthBitGl = {
  name: "object-depth-bit",
  fragment: {
    // outColor = sampled albedo (textureBit); vColor = the per-mesh tint (rect-row in .r,
    // sub-rect offset in .g, LAYER in .b). Discard the soft fringe so it doesn't
    // overwrite; stamp the three bytes where opaque.
    main: /* glsl */ `
      if (outColor.a <= ${DEPTH_ALPHA_THRESHOLD.toFixed(1)}) discard;
      outColor = vec4(vColor.r, vColor.g, vColor.b, 1.0);
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

/** Encode a primitive's feet world-Y into the depth tint (`0xRRGGBB`) as a MODULAR
 *  sort key — absolute depth can't fit the world AND keep sub-tile position, but the
 *  key only has to ORDER prims that are on screen together (≤ a few dozen rects apart),
 *  so a key that REPEATS every {@link DEPTH_PERIOD} rects is enough:
 *
 *    R = mod(rectRow, DEPTH_PERIOD)   — the rect COUNT in y (`floor(worldY/rectH)`)
 *                                       wrapped to a byte (negatives flip to the top:
 *                                       -1→254, -2→253 …, via floored mod). With ~10-20
 *                                       rects on screen most objects share an R.
 *    G = px offset into that rect     — `worldY − rectRow·rectH`, the RAW pixel distance
 *                                       from the rect's top edge. `rectH < 256` so it is
 *                                       already a byte (NOT scaled — it stays small, near
 *                                       zero); red+green read as a fixed-point `R·rectH+G`.
 *
 *  The consumer compares with WRAPAROUND: when two R bytes straddle the seam (differ by
 *  > half the period) the smaller is the souther/front one (it wrapped past the top) —
 *  e.g. R 0..64 sits in front of R 191..255. Period = 255 rects ≈ 22k px ≫ any viewport,
 *  so on-screen pairs never alias. B stays 0 (free). `rectH` = `worldHexRadius()` (88px).
 *
 *  B = the LAYER (see the BLUE_* constants / docs/depth_layers.md) — the vertical axis
 *  that orders things sharing a ground cell (a hex stack, a card's sub-stacks, an object
 *  riding a tile). It rides the tint's blue byte.
 *
 *  Stored under SORTED back-to-front OVERWRITE (not max-blend — per-channel max mangles
 *  the multi-byte, wrapped value); the frontmost prim's exact `(R,G,B)` survives. */
export function encodeDepthTint(worldY: number, rectH: number, blue: number): number {
  const rectRow = Math.floor(worldY / rectH); // which rect-row in y (the rect COUNT)
  const r = ((rectRow % DEPTH_PERIOD) + DEPTH_PERIOD) % DEPTH_PERIOD; // floored → 0..254
  const offset = worldY - rectRow * rectH; // px into the rect, [0, rectH); rectH < 256
  const g = Math.max(0, Math.min(255, Math.round(offset)));
  return (r << 16) | (g << 8) | (blue & 0xff);
}

/** Reference (CPU) impl of the depth COMPARISON the GLSL consumer must mirror — kept
 *  here as the single source of truth + unit-testable. `a`/`b` are decoded depth bytes
 *  `{r,g,b}`. Returns +1 if `a` is in FRONT of `b`, −1 if behind, 0 if equal.
 *
 *  The blue BAND picks the primary key:
 *   • same band → blue is primary (intra-column layering), ground R+G breaks the tie;
 *   • different band → ground R+G is primary, blue breaks the tie.
 *  Bigger = more front everywhere. R compares with WRAPAROUND (it's `mod(rectRow,255)`):
 *  a gap > half the period means the smaller value wrapped past the top, so it's front. */
export function depthFront(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const ground = (): number => {
    let dR = a.r - b.r;
    if (dR > DEPTH_PERIOD / 2) dR -= DEPTH_PERIOD;
    else if (dR < -DEPTH_PERIOD / 2) dR += DEPTH_PERIOD;
    if (dR !== 0) return Math.sign(dR);
    return Math.sign(a.g - b.g);
  };
  if (a.b >> 6 === b.b >> 6) {
    // same band: blue primary, ground tiebreak
    return a.b !== b.b ? Math.sign(a.b - b.b) : ground();
  }
  // different band: ground primary, blue tiebreak
  const g = ground();
  return g !== 0 ? g : Math.sign(a.b - b.b);
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

/** Geometry for one depth quad. `aPosition` is set per primitive to its world bounds
 *  (TL, TR, BR, BL); `aUV` is the matching unit quad (the texture matrix maps it to the
 *  atlas frame). Depth rides the mesh tint. UV is UPRIGHT (matches `aPosition` order),
 *  so the silhouette bakes the same way up as the albedo `Sprite` does into the rect
 *  composite — the depth slot is sampled exactly like albedo/normal, no flip. (The old
 *  per-chunk pipeline flipped V to match an RT-sampled consumer; that consumer is gone.) */
export function makeDepthQuadGeometry(): Geometry {
  return new Geometry({
    attributes: {
      aPosition: { buffer: new Buffer({ data: new Float32Array(8), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: "float32x2", stride: 2 * 4, offset: 0 },
      aUV: { buffer: new Buffer({ data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: "float32x2", stride: 2 * 4, offset: 0 },
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
