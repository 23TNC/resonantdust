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

/** Max COLD (static, baked) lights summed into the lightmap. Higher than hot — they
 *  cost nothing per frame (baked once); the loop breaks on `uLightCount`. */
export const MAX_COLD_LIGHTS = 32;

/**
 * The cold-light LIGHTMAP bake. One rectangle at a time: a `W×H` quad samples that
 * rect's NORMAL slot and writes the static light SUM (not albedo×sum) —
 *   `ambient + Σ coldColor·brightness · max(N·L,0) · falloff²`
 * — into the lightmap. Baked in WORLD space (`world = uRectWorld + localPx`), so the
 * lightmap pans for free; only re-baked when a rect's geometry (normal) changes or a
 * cold light in range changes (`lightDirty`). The display then does
 * `lit = albedo × (lightmap + Σ hot lights)`.
 */
const lightBakeBitGl = {
  name: "light-bake-bit",
  vertex: {
    header: /* glsl */ `out vec2 vLocal;`,
    // aPosition is the rect-local px (0..W,0..H) of the scratch quad.
    main: /* glsl */ `vLocal = aPosition;`,
  },
  fragment: {
    header: /* glsl */ `
      uniform vec4 uLightData[${MAX_COLD_LIGHTS}];  // xy world px, z height, w radius px
      uniform vec4 uLightColor[${MAX_COLD_LIGHTS}]; // rgb colour, a brightness
      uniform float uLightCount;
      uniform float uAmbient;
      uniform float uNormalYSign;
      uniform vec2 uRectWorld;                       // this rect's world origin
      uniform sampler2D uColdShadow;                 // baked cold-shadow coverage (RGB = light 0/1/2)
      uniform sampler2D uDepth;                       // depth composite (blue band ⇒ standing object)
      in vec2 vLocal;
    `,
    main: /* glsl */ `
      vec3 nrm = outColor.rgb * 2.0 - 1.0;          // outColor = normal slot (textureBit)
      vec3 N = normalize(vec3(nrm.x, nrm.y * uNormalYSign, nrm.z));
      vec2 world = uRectWorld + vLocal;
      const float SHADOW_STRENGTH = 0.85;            // 1 = a shadow fully removes its light's term
      // Match the hot pass's depth-driven object handling: standing objects get a south-tilted
      // normal (+ wrap floor) for backlighting and are NEVER cold-shadowed (shadows are ground).
      const float SOUTH_TILT = 1.8;
      const float SOUTH_Z = 0.18;
      const float OBJECT_WRAP = 0.45;
      bool isObject = texture(uDepth, vUV).b * 255.0 > 12.0;
      if (isObject) N = normalize(vec3(N.x, N.y + SOUTH_TILT, N.z * SOUTH_Z));
      vec4 csh = texture(uColdShadow, vUV);          // this slot's cold-shadow coverage, per light
      vec3 sum = vec3(uAmbient);                      // ambient is never shadowed
      for (int i = 0; i < ${MAX_COLD_LIGHTS}; i++) {
        if (float(i) >= uLightCount) break;
        vec4 ld = uLightData[i];
        vec3 toLight = vec3(ld.xy - world, ld.z);
        float dist = length(toLight.xy);
        float atten = clamp(1.0 - dist / max(ld.w, 1.0), 0.0, 1.0);
        atten *= atten;
        float ndotl = max(dot(N, normalize(toLight)), 0.0);
        if (isObject) ndotl = max(ndotl, OBJECT_WRAP * atten); // backlit objects catch some near light
        // First 3 cold lights (R/G/B) lose their term where occluded; objects are never shadowed.
        float sh = isObject ? 0.0 : (i == 0 ? csh.r : (i == 1 ? csh.g : (i == 2 ? csh.b : 0.0)));
        sum += uLightColor[i].rgb * uLightColor[i].a * ndotl * atten * (1.0 - sh * SHADOW_STRENGTH);
      }
      outColor = vec4(sum, 1.0);
    `,
  },
};

let program: GlProgram | null = null;
function lightBakeProgram(): GlProgram {
  if (!program) {
    program = compileHighShaderGlProgram({
      name: "light-bake",
      bits: [localUniformBitGl, textureBitGl, lightBakeBitGl, roundPixelsBitGl],
    });
  }
  return program;
}

/** Bakes one rect's lightmap from its normal slot + the cold lights. `normal` = the
 *  normal composite (textureBit samples it at `aUV` = the rect's slot); `setRect`
 *  sets the rect's world origin; `setColdLights` the (rarely-changing) cold set. */
export class LightBakeShader extends Shader {
  set normal(value: Texture) {
    this.resources.uTexture = value.source;
    this.resources.uSampler = value.source.style;
  }
  setRect(worldX: number, worldY: number): void {
    this.resources.bakeUniforms.uniforms.uRectWorld = [worldX, worldY];
    this.resources.bakeUniforms.update();
  }
  setColdLights(data: Float32Array, color: Float32Array, count: number, ambient: number): void {
    const u = this.resources.lightUniforms.uniforms;
    u.uLightData = data;
    u.uLightColor = color;
    u.uLightCount = count;
    u.uAmbient = ambient;
    this.resources.lightUniforms.update();
  }
  /** The baked cold-shadow coverage map (same slot layout; sampled at the rect's `vUV`). */
  set coldShadow(value: Texture) {
    this.resources.uColdShadow = value.source;
    this.resources.uColdShadowSampler = value.source.style;
  }
  /** The depth composite — its blue band marks standing objects (no cold shadow + backlight). */
  set depth(value: Texture) {
    this.resources.uDepth = value.source;
    this.resources.uDepthSampler = value.source.style;
  }
}

export function makeLightBakeShader(): LightBakeShader {
  const empty = Texture.EMPTY;
  return new LightBakeShader({
    glProgram: lightBakeProgram(),
    resources: {
      uTexture: empty.source,
      uSampler: empty.source.style,
      uColdShadow: empty.source,
      uColdShadowSampler: empty.source.style,
      uDepth: empty.source,
      uDepthSampler: empty.source.style,
      textureUniforms: { uTextureMatrix: { type: "mat3x3<f32>", value: new Matrix() } },
      bakeUniforms: new UniformGroup({
        uRectWorld: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
      }),
      lightUniforms: new UniformGroup({
        uLightData: { value: new Float32Array(MAX_COLD_LIGHTS * 4), type: "vec4<f32>", size: MAX_COLD_LIGHTS },
        uLightColor: { value: new Float32Array(MAX_COLD_LIGHTS * 4), type: "vec4<f32>", size: MAX_COLD_LIGHTS },
        uLightCount: { value: 0, type: "f32" },
        uAmbient: { value: 0.25, type: "f32" },
        uNormalYSign: { value: -1, type: "f32" },
      }),
    },
  });
}
