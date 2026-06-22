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

/** Max HOT (dynamic, per-frame) lights summed in the display pass. The loop breaks
 *  on `uLightCount`, so unused slots cost nothing; keep the active set small. */
export const MAX_HOT_LIGHTS = 8;

/**
 * The viewport ground shader. The ground is drawn as ≤4 quads (the torus-seam split
 * — see `RectComposite.fillDisplay`); this shader samples the composite's **albedo**
 * AND **normal** channels (both at the per-vertex `aUV`) and applies the HOT lights
 * live each frame, so a light following the cursor needs no re-bake:
 *
 *   lit = albedo.rgb × (ambient + Σ lightColor·brightness · max(N·L,0) · falloff)
 *
 * `textureBit` samples the normal composite into `outColor` (kept upright by the
 * identity texture-matrix — the bake stores it upright); we re-read it as a normal,
 * sample `uAlbedo` ourselves, and sum the lights at the fragment's PANEL position
 * (`vScreen`, the quad's `aPosition`) — light positions are packed in panel px.
 *
 * Baked/static (cold) lights would fold into a `lit` composite channel later; this
 * pass is only the dynamic set.
 */
const groundLightBitGl = {
  name: "ground-light-bit",
  // The quad's `aPosition` is the fragment's PANEL position — the space hot-light
  // positions are packed into (world + pan, or screen for the cursor). Carry it.
  vertex: {
    header: /* glsl */ `out vec2 vScreen;`,
    main: /* glsl */ `vScreen = aPosition;`,
  },
  fragment: {
    header: /* glsl */ `
      uniform sampler2D uAlbedo;                    // albedo composite (premultiplied)
      uniform sampler2D uLightmap;                  // baked cold-light sum (ambient + cold)
      uniform vec4 uLightData[${MAX_HOT_LIGHTS}];   // xy panel px, z height, w radius px
      uniform vec4 uLightColor[${MAX_HOT_LIGHTS}];  // rgb colour, a brightness
      uniform float uLightCount;
      uniform float uNormalYSign;                   // flip normal Y → screen convention
      in vec2 vScreen;
    `,
    main: /* glsl */ `
      vec3 nrm = outColor.rgb * 2.0 - 1.0;          // outColor = normal composite (textureBit)
      vec3 N = normalize(vec3(nrm.x, nrm.y * uNormalYSign, nrm.z));
      vec3 lightSum = texture(uLightmap, vUV).rgb;  // ambient + baked cold lights
      for (int i = 0; i < ${MAX_HOT_LIGHTS}; i++) {
        if (float(i) >= uLightCount) break;
        vec4 ld = uLightData[i];
        vec3 toLight = vec3(ld.xy - vScreen, ld.z);
        float dist = length(toLight.xy);
        float atten = clamp(1.0 - dist / max(ld.w, 1.0), 0.0, 1.0);
        atten *= atten;
        float ndotl = max(dot(N, normalize(toLight)), 0.0);
        lightSum += uLightColor[i].rgb * uLightColor[i].a * ndotl * atten;
      }
      vec4 alb = texture(uAlbedo, vUV);
      outColor = vec4(alb.rgb * lightSum, alb.a);
    `,
  },
};

let program: GlProgram | null = null;
function groundProgram(): GlProgram {
  if (!program) {
    program = compileHighShaderGlProgram({
      name: "ground-light",
      bits: [localUniformBitGl, textureBitGl, groundLightBitGl, roundPixelsBitGl],
    });
  }
  return program;
}

/** Lit ground shader. `normal` = the normal composite (textureBit samples it),
 *  `albedo` = the albedo composite, `setLights` feeds the per-frame hot lights. */
export class GroundShader extends Shader {
  set normal(value: Texture) {
    this.resources.uTexture = value.source;
    this.resources.uSampler = value.source.style;
  }
  set albedo(value: Texture) {
    this.resources.uAlbedo = value.source;
    this.resources.uAlbedoSampler = value.source.style;
  }
  set lightmap(value: Texture) {
    this.resources.uLightmap = value.source;
    this.resources.uLightmapSampler = value.source.style;
  }
  /** Replace the hot-light set. `data`/`color` are `MAX_HOT_LIGHTS*4` floats (new
   *  arrays each call — the uniform group flushes on value reassignment). */
  setLights(data: Float32Array, color: Float32Array, count: number): void {
    const u = this.resources.lightUniforms.uniforms;
    u.uLightData = data;
    u.uLightColor = color;
    u.uLightCount = count;
    this.resources.lightUniforms.update();
  }
}

export function makeGroundShader(): GroundShader {
  const empty = Texture.EMPTY;
  return new GroundShader({
    glProgram: groundProgram(),
    resources: {
      uTexture: empty.source,
      uSampler: empty.source.style,
      // Identity — vUV = aUV (composite coords), no frame/flip remap (bake is upright).
      textureUniforms: { uTextureMatrix: { type: "mat3x3<f32>", value: new Matrix() } },
      uAlbedo: empty.source,
      uAlbedoSampler: empty.source.style,
      uLightmap: empty.source,
      uLightmapSampler: empty.source.style,
      lightUniforms: new UniformGroup({
        uLightData: { value: new Float32Array(MAX_HOT_LIGHTS * 4), type: "vec4<f32>", size: MAX_HOT_LIGHTS },
        uLightColor: { value: new Float32Array(MAX_HOT_LIGHTS * 4), type: "vec4<f32>", size: MAX_HOT_LIGHTS },
        uLightCount: { value: 0, type: "f32" },
        uNormalYSign: { value: -1, type: "f32" },
      }),
    },
  });
}
