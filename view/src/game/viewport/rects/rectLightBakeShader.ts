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
      in vec2 vLocal;
    `,
    main: /* glsl */ `
      vec3 nrm = outColor.rgb * 2.0 - 1.0;          // outColor = normal slot (textureBit)
      vec3 N = normalize(vec3(nrm.x, nrm.y * uNormalYSign, nrm.z));
      vec2 world = uRectWorld + vLocal;
      vec3 sum = vec3(uAmbient);
      for (int i = 0; i < ${MAX_COLD_LIGHTS}; i++) {
        if (float(i) >= uLightCount) break;
        vec4 ld = uLightData[i];
        vec3 toLight = vec3(ld.xy - world, ld.z);
        float dist = length(toLight.xy);
        float atten = clamp(1.0 - dist / max(ld.w, 1.0), 0.0, 1.0);
        atten *= atten;
        float ndotl = max(dot(N, normalize(toLight)), 0.0);
        sum += uLightColor[i].rgb * uLightColor[i].a * ndotl * atten;
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
}

export function makeLightBakeShader(): LightBakeShader {
  const empty = Texture.EMPTY;
  return new LightBakeShader({
    glProgram: lightBakeProgram(),
    resources: {
      uTexture: empty.source,
      uSampler: empty.source.style,
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
