import {
  compileHighShaderGlProgram,
  localUniformBitGl,
  textureBitGl,
  roundPixelsBitGl,
  GlProgram,
  Shader,
  Texture,
  Matrix,
  type UniformGroup,
} from "pixi.js";

/** Max lights summed in one deferred pass. Cheap to raise (the loop breaks on
 *  `uLightCount`); the per-viewport active set is what to keep small. */
export const MAX_LIGHTS = 16;

/**
 * The deferred light pass: ONE quad covering the viewport (content space),
 * sampling the normal G-buffer and summing every light in a single draw. PIXI's
 * `textureBit` samples the G-buffer into `outColor` (its `uTextureMatrix`
 * handles the render-texture flip); this bit reinterprets that as a normal,
 * accumulates Lambert × distance-falloff for each light in CONTENT space, and
 * writes the total light (ambient + sum) as the output. A multiply overlay then
 * applies it to the albedo.
 */
const deferredLightBitGl = {
  name: "deferred-light-bit",
  vertex: {
    header: /* glsl */ `
      out vec2 vContentPos;
    `,
    // The quad's geometry is in content pixels at identity transform, so its
    // local position is the fragment's content-space position (the space the
    // light positions are pre-projected into on the CPU).
    main: /* glsl */ `
      vContentPos = position;
    `,
  },
  fragment: {
    header: /* glsl */ `
      uniform sampler2D uAlbedo;                // the surface albedo (premultiplied)
      uniform vec4 uLightData[${MAX_LIGHTS}];   // xy local pos, z height, w radius (px)
      uniform vec4 uLightColor[${MAX_LIGHTS}];  // rgb colour, a brightness
      uniform float uLightCount;
      uniform float uAmbient;
      uniform float uNormalYSign;
      in vec2 vContentPos;
    `,
    // G4 per-chunk LIT bake: `outColor` is the chunk's normal G-buffer (textureBit).
    // Reinterpret it as a normal, sum ambient + every light (Lambert × distance
    // falloff) at the fragment's chunk-local position, and write the LIT albedo
    // (`albedo × (ambient + Σ lights)`). The chunk's display sprite shows the result
    // directly — no overlay. Albedo is premultiplied, so `albedo.rgb × lightSum`
    // stays premultiplied; alpha is the albedo's coverage.
    main: /* glsl */ `
      vec3 nrm = outColor.rgb * 2.0 - 1.0;
      vec3 N = normalize(vec3(nrm.x, nrm.y * uNormalYSign, nrm.z));
      vec3 lightSum = vec3(uAmbient);
      for (int i = 0; i < ${MAX_LIGHTS}; i++) {
        if (float(i) >= uLightCount) break;
        vec4 ld = uLightData[i];
        vec3 toLight = vec3(ld.xy - vContentPos, ld.z);
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

let sharedProgram: GlProgram | null = null;
function lightProgram(): GlProgram {
  if (!sharedProgram) {
    sharedProgram = compileHighShaderGlProgram({
      name: "deferred-light",
      bits: [localUniformBitGl, textureBitGl, deferredLightBitGl, roundPixelsBitGl],
    });
  }
  return sharedProgram;
}

/** Shader for the light-pass mesh. `texture` is the normal G-buffer it samples
 *  (its setter binds the source + flip matrix, same idiom as `LitShader`). */
class DeferredLightShader extends Shader {
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

export function makeDeferredLightShader(lightUniforms: UniformGroup): DeferredLightShader {
  const empty = Texture.EMPTY;
  return new DeferredLightShader({
    glProgram: lightProgram(),
    resources: {
      uTexture: empty.source,
      uSampler: empty.source.style,
      textureUniforms: { uTextureMatrix: { type: "mat3x3<f32>", value: new Matrix() } },
      uAlbedo: empty.source,
      uAlbedoSampler: empty.source.style,
      lightUniforms,
    },
  });
}
