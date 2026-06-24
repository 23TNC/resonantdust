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
      uniform sampler2D uShadowMask;                // scatter map 0: lanes R/G/B/A = lights 0/1/2/3
      uniform sampler2D uShadowMask2;               // scatter map 1: lanes R/G/B/A = lights 4/5/6/7
      uniform vec2 uPanelSize;                       // panel px → mask UV
      uniform sampler2D uDepth;                      // depth composite (B band ≥ 1 ⇒ standing object)
      uniform sampler2D uHotAlbedo;                 // per-frame mover albedo (premultiplied)
      uniform sampler2D uHotNormal;                 // per-frame mover normal (flat-up where unmapped)
      uniform sampler2D uHotDepth;                  // per-frame mover depth (feet-Y + card layer)
      // Depth compare (bytes 0..255), mirrors depthShaders.ts depthFront. >0 if A is in
      // FRONT of B. The bytes are RAW — setQuadDepth carries them on a custom aDepth
      // vertex attribute, bypassing the gamma-2.0 tint->buffer squash (BLUE_ROOT reads 48
      // not 9): the blue BAND (B>>6) picks the
      // primary key — same band → blue primary (intra-column layering), ground R+G tiebreak;
      // different band → ground R+G primary, blue tiebreak. R wraps (mod 255); G breaks an R tie.
      float groundCmp(vec3 a, vec3 b) {
        float dR = a.r - b.r;
        if (dR > 127.5) dR -= 255.0; else if (dR < -127.5) dR += 255.0;
        if (abs(dR) > 0.5) return sign(dR);
        return sign(a.g - b.g);
      }
      float depthFront(vec3 a, vec3 b) {
        if (floor(a.b / 64.0) == floor(b.b / 64.0)) {
          return abs(a.b - b.b) > 0.5 ? sign(a.b - b.b) : groundCmp(a, b);
        }
        float g = groundCmp(a, b);
        return g != 0.0 ? g : sign(a.b - b.b);
      }
      in vec2 vScreen;
    `,
    main: /* glsl */ `
      vec3 nrm = outColor.rgb * 2.0 - 1.0;          // outColor = normal composite (textureBit)
      vec3 N = normalize(vec3(nrm.x, nrm.y * uNormalYSign, nrm.z));
      const float SHADOW_STRENGTH = 0.85;           // shadow core darkness (1 = black; tweak + HMR)
      const float SHADOW_NEAR_RELIEF = 0.5;         // how much a shadow lightens right at the light
                                                     // (× proximity): 0 = uniform, 1 = no shadow at the source.
      // Standing objects (depth blue band ≥ 1 — see depthShaders BLUE_OBJECT) are upright
      // billboards FACING the viewer (south): tilt their normal toward +Y/−Z so a light to
      // the NORTH backlights them (front dark, edges rimmed), and never cast a ground shadow
      // ONTO them (a shadow is a ground effect). Ground tiles (band 0) are untouched.
      const float SOUTH_TILT = 1.8;                  // object normal +Y bias (tweak + HMR)
      const float SOUTH_Z = 0.18;                    // object normal Z keep (lower = darker backs)
      const float OBJECT_WRAP = 0.45;                // max back-light an object catches when a light
                                                     // is RIGHT on it; scaled by proximity (atten)
                                                     // so the floor rises the closer the light sits.
      vec4 dpx = texture(uDepth, vUV);
      // Object ⇔ the depth-blue (layer) byte is set. Standing objects bake BLUE_OBJECT (80),
      // which PIXI sRGB-converts on the tint to ≈25 in the map; ground/tiles write no depth (0).
      // So we gate well below the compressed object value, not against the raw 30 constant.
      bool isObject = dpx.b * 255.0 > 12.0;
      if (isObject) N = normalize(vec3(N.x, N.y + SOUTH_TILT, N.z * SOUTH_Z));
      // The mask holds each hot light's projected-silhouette coverage in its own channel
      // (R = light 0, G = light 1, B = light 2; built CPU-side in RectComposite.buildShadowMask).
      vec2 maskUV = vScreen / uPanelSize;
      vec4 shMask = texture(uShadowMask, maskUV);   // lights 0..3 (R/G/B/A)
      vec4 shMask2 = texture(uShadowMask2, maskUV); // lights 4..7 (R/G/B/A)
      vec3 lightSum = texture(uLightmap, vUV).rgb;  // ambient + baked cold lights
      for (int i = 0; i < ${MAX_HOT_LIGHTS}; i++) {
        if (float(i) >= uLightCount) break;
        vec4 ld = uLightData[i];
        vec3 toLight = vec3(ld.xy - vScreen, ld.z);
        float dist = length(toLight.xy);
        float atten = clamp(1.0 - dist / max(ld.w, 1.0), 0.0, 1.0);
        atten *= atten;
        if (atten <= 0.0) continue;                 // outside radius → no light, no shadow
        float ndotl = max(dot(N, normalize(toLight)), 0.0);
        // Light wrap: a backlit object still catches a nearby light around its far side, and the
        // closer the light the more it does. Floor the diffuse by OBJECT_WRAP·atten (proximity);
        // the lit term multiplies by atten again, so the wrap is a steep near-field effect.
        if (isObject) ndotl = max(ndotl, OBJECT_WRAP * atten);
        // Shadows are a GROUND effect: objects are NEVER darkened, so they always sit on
        // top of (in front of) shadows — a shadow painted on an object's camera-facing
        // front reads as the wrong side. Each point light's shadow masks only ITS own term.
        // Coverage for light i: lane (i&3) of map (i>>2). Selected without dynamic vec
        // indexing (ES 1.00) — pick the map, then the lane by ladder.
        vec4 sm = i < 4 ? shMask : shMask2;
        int lane = i - (i < 4 ? 0 : 4);
        float cov = lane == 0 ? sm.r : (lane == 1 ? sm.g : (lane == 2 ? sm.b : sm.a));
        float blocked = isObject ? 0.0 : cov;
        // Shadows relax the closer they are to the light (mirrors the object wrap): a shadow by
        // a bright source isn't as black as one at the edge of the radius.
        float strength = SHADOW_STRENGTH * (1.0 - SHADOW_NEAR_RELIEF * atten);
        float lit = uLightColor[i].a * ndotl * atten * (1.0 - blocked * strength);
        lightSum += uLightColor[i].rgb * lit;
      }
      vec4 alb = texture(uAlbedo, vUV);
      outColor = vec4(alb.rgb * lightSum, alb.a);

      // ── hot prims (movers/cards): light the per-frame G-buffer + composite OVER ──
      // Sample the hot albedo/normal at the SAME slot UV. Movers are standing billboards
      // FACING the viewer, exactly like the ground objects — so pitch their normal forward
      // (the same SOUTH_TILT/SOUTH_Z + wrap) so a light to the NORTH backlights them
      // (front dark, edges rimmed) instead of lighting the front from behind. No ground
      // shadow. premultiplied-over the lit ground. Maps baked by RectComposite.bakeHotPrims.
      // Pick hot-vs-cold by depth: composite the mover only where it's in FRONT of the cold
      // pixel (depthFront ≥ 0). A card behind a tree is occluded (cold shows); a card in front
      // occludes it; a card over bare ground (cold writes 0, band 0) always wins.
      vec4 hotA = texture(uHotAlbedo, vUV);
      vec3 hotD = texture(uHotDepth, vUV).rgb * 255.0;
      vec3 coldD = dpx.rgb * 255.0;
      if (hotA.a > 0.003 && depthFront(hotD, coldD) >= 0.0) {
        vec3 hn = texture(uHotNormal, vUV).rgb * 2.0 - 1.0;
        vec3 Nh = normalize(vec3(hn.x, hn.y * uNormalYSign, hn.z));
        Nh = normalize(vec3(Nh.x, Nh.y + SOUTH_TILT, Nh.z * SOUTH_Z)); // pitch forward, like objects
        vec3 hotSum = texture(uLightmap, vUV).rgb;   // ambient + baked cold (ground-normal approx)
        for (int i = 0; i < ${MAX_HOT_LIGHTS}; i++) {
          if (float(i) >= uLightCount) break;
          vec4 ld = uLightData[i];
          vec3 toL = vec3(ld.xy - vScreen, ld.z);
          float d = length(toL.xy);
          float at = clamp(1.0 - d / max(ld.w, 1.0), 0.0, 1.0); at *= at;
          if (at <= 0.0) continue;
          float nl = max(dot(Nh, normalize(toL)), 0.0);
          nl = max(nl, OBJECT_WRAP * at);            // backlit billboard catches some near light
          hotSum += uLightColor[i].rgb * (uLightColor[i].a * nl * at);
        }
        vec3 litHot = hotA.rgb * hotSum;             // hotA premultiplied → already × alpha
        outColor = vec4(litHot + outColor.rgb * (1.0 - hotA.a), hotA.a + outColor.a * (1.0 - hotA.a));
      }
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
  /** Scatter map 0 (lanes R/G/B/A = dynamic light 0/1/2/3 coverage), sampled per fragment at
   *  `vScreen / uPanelSize`. Rebuilt each frame by RectComposite. */
  set shadowMask(value: Texture) {
    this.resources.uShadowMask = value.source;
    this.resources.uShadowMaskSampler = value.source.style;
  }
  /** Scatter map 1 (lanes R/G/B/A = dynamic light 4/5/6/7 coverage). */
  set shadowMask2(value: Texture) {
    this.resources.uShadowMask2 = value.source;
    this.resources.uShadowMask2Sampler = value.source.style;
  }
  /** The panel size the mask was rendered at (mask is panel-sized → UV = panel px / size). */
  setPanelSize(w: number, h: number): void {
    this.resources.shadowUniforms.uniforms.uPanelSize = [w, h];
    this.resources.shadowUniforms.update();
  }
  /** The depth composite (blue band identifies standing-object pixels: no cast shadow,
   *  south-tilted normal for backlighting). Sampled at `vUV`, same slot layout as albedo. */
  set depth(value: Texture) {
    this.resources.uDepth = value.source;
    this.resources.uDepthSampler = value.source.style;
  }
  /** Per-frame hot-prim (mover) albedo — lit + composited over the ground. */
  set hotAlbedo(value: Texture) {
    this.resources.uHotAlbedo = value.source;
    this.resources.uHotAlbedoSampler = value.source.style;
  }
  /** Per-frame hot-prim normal (flat-up where unmapped). */
  set hotNormal(value: Texture) {
    this.resources.uHotNormal = value.source;
    this.resources.uHotNormalSampler = value.source.style;
  }
  /** Per-frame hot-prim depth — `depthFront(hotDepth, coldDepth)` gates the merge. */
  set hotDepth(value: Texture) {
    this.resources.uHotDepth = value.source;
    this.resources.uHotDepthSampler = value.source.style;
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
      uShadowMask: empty.source,
      uShadowMaskSampler: empty.source.style,
      uShadowMask2: empty.source,
      uShadowMask2Sampler: empty.source.style,
      uDepth: empty.source,
      uDepthSampler: empty.source.style,
      uHotAlbedo: empty.source,
      uHotAlbedoSampler: empty.source.style,
      uHotNormal: empty.source,
      uHotNormalSampler: empty.source.style,
      uHotDepth: empty.source,
      uHotDepthSampler: empty.source.style,
      shadowUniforms: new UniformGroup({
        uPanelSize: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
      }),
    },
  });
}
