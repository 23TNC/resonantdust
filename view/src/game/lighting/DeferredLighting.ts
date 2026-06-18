import { Mesh, MeshGeometry, RenderTexture, Texture, UniformGroup, type Container, type Renderer } from "pixi.js";
import type { LitSprite } from "./LitSprite";
import { MAX_LIGHTS, makeDeferredLightShader } from "./deferredLightShader";
import { worldHexRadius } from "../viewport/hex/hexSize";

/** Ambient floor when lit (multiply baseline) — low so the cursor light reads
 *  as casting light rather than just brightening an already-lit scene. */
const LIT_AMBIENT = 0.12;

/** Re-bake priority for the dirty-region queue (higher = serviced first). The
 *  cursor is highest (it moves every frame), souls next (move often, our focus),
 *  static torches/campfires last. Consumed by the queue in Phase D; see
 *  docs/shadow_lighting.md. */
export const LightPriority = {
  cursor: 100,
  soul: 50,
  static: 0,
} as const;

/** A world-space point light. `x/y` are viewport world (panLayer-local) units;
 *  `height` is the light's height above the flat sprite plane (content px — what
 *  makes the normal map read); `radius` is the falloff radius in HEX-TILE units
 *  (px = radius × hexSize, so the smooth circle scales with the grid and the
 *  integer hex disk is the dirty/occluder index — see docs/shadow_lighting.md);
 *  `color` is 0xRRGGBB; `brightness` scales it. */
export interface Light {
  x: number;
  y: number;
  height: number;
  radius: number;
  color: number;
  brightness: number;
  /** Casts shadows when true (default). Per-light opt-out via `casts_shadow`. */
  castsShadow: boolean;
  /** May bake into the macro_zone light texture when true (default). False keeps
   *  it in the live screen-space pass — set for per-frame movers (the cursor),
   *  whose bake would re-dirty its region every frame. */
  canBake: boolean;
  /** Runtime: this light's region needs re-baking. Consumed by the dirty-region
   *  queue (Phase D); the current screen-space pass ignores it. */
  dirty: boolean;
  /** Re-bake priority (see `LightPriority`). Consumed in Phase D. */
  priority: number;
}

/** Default cursor-light shape — tuned blind; expect to adjust live. */
const CURSOR_LIGHT: Omit<Light, "x" | "y"> = {
  height: 180,
  radius: 5.6, // tiles (≈480 px at hex_radius 86)
  color: 0xffffff,
  brightness: 1.6,
  castsShadow: true,
  canBake: false, // follows the cursor every frame — stays in the live pass
  dirty: false,
  priority: LightPriority.cursor,
};

function makeFlatNormal(): Texture {
  // 1×1 flat-up normal (RGB 128,128,255 → +Z) for sprites with no real normal
  // map: the deferred normal pass swaps this in so flat surfaces still light by
  // distance/height. Opaque, so its alpha never participates.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#8080ff";
  ctx.fillRect(0, 0, 1, 1);
  return Texture.from(canvas);
}

/**
 * Per-viewport deferred lighting. Owns:
 *  - a REGISTRY of the viewport's `LitSprite`s, so the normal pass can render
 *    their normal frames into the G-buffer (it swaps each sprite's `texture`
 *    for its `normalTexture`, renders, swaps back);
 *  - the world-space LIGHTS (cursor-driven for now, extensible to many);
 *  - the flat-up fallback normal.
 *
 * The render targets + passes (normal G-buffer → light accumulation →
 * composite) land in later phases; this phase just establishes the registry +
 * light state and reverts the sprites to plain batched `Sprite`s (so draw count
 * drops). The world renders UNLIT albedo until the composite pass lands.
 */
export class DeferredLighting {
  readonly flatNormal: Texture = makeFlatNormal();
  /** Live lit sprites in this viewport — the normal-pass input set. */
  private readonly sprites = new Set<LitSprite>();
  private readonly lights: Light[] = [];
  private cursor: { x: number; y: number } | null = null;
  /** Lights contributed by `light` PRIMITIVES on cards (registered by their
   *  `LightPrim`, which mutates each entry's world position as the card moves).
   *  Summed alongside the cursor light. */
  private readonly cardLights = new Set<Light>();
  /** The normal G-buffer (content-local, screen resolution). Sized to the
   *  viewport by `resize`; the normal pass renders the registry's normals into
   *  it; the light pass samples it. */
  private normalRT: RenderTexture | null = null;
  /** The light accumulation buffer — `ambient + Σ lights`, output of the light
   *  pass, shown multiplied over the albedo. */
  private lightRT: RenderTexture | null = null;
  /** The albedo capture — the light pass reads its ALPHA as the coverage mask
   *  so the multiply overlay only shades real geometry (no black on empty). */
  private albedoRT: RenderTexture | null = null;
  /** The emissive accumulation buffer — `Σ emissive` from every sprite that
   *  carries an emissive frame, ADDED over the lit composite (so glows survive
   *  in the dark). Null until sized; the pass is skipped entirely when no
   *  sprite emits. */
  private emissiveRT: RenderTexture | null = null;
  /** Shared light uniforms (positions/colours in content space). */
  private readonly lightUniforms = new UniformGroup({
    uLightData: { value: new Float32Array(MAX_LIGHTS * 4), type: "vec4<f32>", size: MAX_LIGHTS },
    uLightColor: { value: new Float32Array(MAX_LIGHTS * 4), type: "vec4<f32>", size: MAX_LIGHTS },
    uLightCount: { value: 0, type: "f32" },
    uAmbient: { value: LIT_AMBIENT, type: "f32" },
    uNormalYSign: { value: -1, type: "f32" },
  });
  private readonly lightShader = makeDeferredLightShader(this.lightUniforms);
  /** The viewport-covering quad the light pass draws (geometry sized to the
   *  content in `resize`). */
  private readonly lightMesh = new Mesh({
    geometry: new MeshGeometry({
      positions: new Float32Array(8),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    }),
    shader: this.lightShader,
  });

  /** Shared, never-rendered instance for offline/preview renders (drag ghost,
   *  card-face bakes) — they draw plain albedo and never go through the passes,
   *  so the registry is harmless and never sampled. */
  private static sharedOffline: DeferredLighting | null = null;
  static offline(): DeferredLighting {
    if (!DeferredLighting.sharedOffline) DeferredLighting.sharedOffline = new DeferredLighting();
    return DeferredLighting.sharedOffline;
  }

  register(sprite: LitSprite): void {
    this.sprites.add(sprite);
  }
  unregister(sprite: LitSprite): void {
    this.sprites.delete(sprite);
  }

  /** Register a card `light` primitive's live light. The caller (`LightPrim`)
   *  keeps mutating the object's world position / shape; we just read it. */
  registerLight(light: Light): void {
    this.cardLights.add(light);
  }
  unregisterLight(light: Light): void {
    this.cardLights.delete(light);
  }

  /** Cursor position in this viewport's world space (`panLayer.toLocal`), or
   *  null to drop the cursor light. */
  setCursorWorld(x: number | null, y?: number): void {
    this.cursor = x === null ? null : { x, y: y ?? 0 };
  }

  /** The active light list — the cursor light plus every card `light` primitive.
   *  The light pass reads this each update. */
  activeLights(): readonly Light[] {
    this.lights.length = 0;
    if (this.cursor) this.lights.push({ ...CURSOR_LIGHT, x: this.cursor.x, y: this.cursor.y });
    for (const l of this.cardLights) this.lights.push(l);
    return this.lights;
  }

  /** (Re)allocate both buffers to the viewport size (CSS px) at `resolution`
   *  (dpr), and size the light quad to match. No-op for a degenerate size. */
  resize(width: number, height: number, resolution: number): void {
    if (width <= 0 || height <= 0) return;
    this.normalRT?.destroy(true);
    this.normalRT = RenderTexture.create({ width, height, resolution });
    this.lightRT?.destroy(true);
    this.lightRT = RenderTexture.create({ width, height, resolution });
    this.albedoRT?.destroy(true);
    this.albedoRT = RenderTexture.create({ width, height, resolution });
    this.emissiveRT?.destroy(true);
    this.emissiveRT = RenderTexture.create({ width, height, resolution });
    const pos = this.lightMesh.geometry.positions;
    pos[0] = 0; pos[1] = 0;
    pos[2] = width; pos[3] = 0;
    pos[4] = width; pos[5] = height;
    pos[6] = 0; pos[7] = height;
    this.lightMesh.geometry.positions = pos;
  }

  /** The G-buffer texture, for the light pass / debug view. Null until sized. */
  get normalTexture(): Texture | null {
    return this.normalRT;
  }

  /**
   * Render the registry's NORMALS into the G-buffer. Swaps each lit sprite's
   * `texture` to its normal frame (flat-up fallback), renders `world` (the pan
   * container — captures the camera offset in its local transform) into the
   * target, then restores the albedo. Cleared to flat-up so empty space reads
   * as facing the viewer. Synchronous, so the on-screen albedo render that
   * follows sees the restored textures.
   */
  renderNormals(renderer: Renderer, world: Container): void {
    const rt = this.normalRT;
    if (!rt) return;
    // Sprites WITH a real normal map render it; sprites WITHOUT one (solid
    // fills, the hex-tile ground) are hidden for the pass so they fall through
    // to the flat-up clear instead of writing their albedo COLOUR as a bogus
    // normal — that colour-as-normal was the directional "lit on one side"
    // artifact. Empty space is flat-up from the clear too.
    // The tint is the ALBEDO's colour (e.g. a tile's ground tint). It must NOT
    // apply to the normal — multiplying the normal's RGB by a coloured tint skews
    // the encoded vector (a low-blue tint crushes the +Z component, so flat ground
    // reads as facing sideways: black under a top-down light, glowing edges). Force
    // white for the normal render and restore the real tint after.
    const restore: { sp: LitSprite; tint: number }[] = [];
    for (const sp of this.sprites) {
      if (sp.normalTexture) {
        restore.push({ sp, tint: sp.tint });
        sp.texture = sp.normalTexture;
        sp.tint = 0xffffff;
      } else {
        sp.renderable = false;
      }
    }
    renderer.render({ container: world, target: rt, clear: true, clearColor: [0.5, 0.5, 1, 1] });
    for (const sp of this.sprites) {
      if (!sp.normalTexture) sp.renderable = true;
    }
    for (const { sp, tint } of restore) {
      sp.texture = sp.albedoTexture;
      sp.tint = tint;
    }
  }

  /**
   * Sum the active lights into the light buffer (one quad sampling the G-buffer)
   * and return it for the multiply overlay. Light world positions are projected
   * into content space via `panLayer`'s transform (so they track the camera);
   * `null` until the buffers are sized.
   */
  renderLights(renderer: Renderer, panLayer: Container): Texture | null {
    const rt = this.lightRT;
    if (!rt || !this.normalRT || !this.albedoRT) return null;

    // Capture the albedo (no swap) — the light pass samples its alpha as the
    // coverage mask. panLayer's textures are the albedo here (renderNormals
    // restored them before this runs).
    renderer.render({ container: panLayer, target: this.albedoRT, clear: true });

    const lights = this.activeLights();
    const u = this.lightUniforms.uniforms;
    const data = u.uLightData as Float32Array;
    const color = u.uLightColor as Float32Array;
    const m = panLayer.localTransform;
    const scale = panLayer.scale.x;
    const hexR = worldHexRadius(); // tile → world px, for the radius falloff
    const count = Math.min(lights.length, MAX_LIGHTS);
    for (let i = 0; i < count; i++) {
      const l = lights[i];
      data[i * 4 + 0] = m.a * l.x + m.c * l.y + m.tx; // world → content
      data[i * 4 + 1] = m.b * l.x + m.d * l.y + m.ty;
      data[i * 4 + 2] = l.height * scale;
      data[i * 4 + 3] = l.radius * hexR * scale; // tiles → world px → content
      color[i * 4 + 0] = ((l.color >> 16) & 0xff) / 255;
      color[i * 4 + 1] = ((l.color >> 8) & 0xff) / 255;
      color[i * 4 + 2] = (l.color & 0xff) / 255;
      color[i * 4 + 3] = l.brightness;
    }
    u.uLightCount = count;
    this.lightUniforms.update();

    this.lightShader.texture = this.normalRT;
    this.lightShader.resources.uAlbedo = this.albedoRT.source;
    this.lightShader.resources.uAlbedoSampler = this.albedoRT.source.style;
    renderer.render({ container: this.lightMesh, target: rt, clear: true });
    return rt;
  }

  /**
   * Render the registry's EMISSIVE frames, summed, into the emissive buffer —
   * returned for the ADDITIVE overlay (`final = albedo×light + emissive`, so a
   * glow survives where light is ~0). Like `renderNormals` it swaps each
   * sprite's `texture` to its emissive frame and restores the albedo after, but
   * it renders the emissive sprites in ADD blend over a black clear: a
   * non-glowing sprite's black padding adds nothing (black is the additive
   * identity), so there's no bounding-box overwrite and overlapping glows sum —
   * none of the silhouette-alpha care the normal page needs.
   *
   * Returns `null` (and does NO render) when no sprite carries an emissive map —
   * the common case — so emissive is genuinely zero-cost until art opts in.
   */
  renderEmissive(renderer: Renderer, world: Container): Texture | null {
    const rt = this.emissiveRT;
    if (!rt) return null;
    let any = false;
    for (const sp of this.sprites) {
      if (sp.emissiveTexture) { any = true; break; }
    }
    if (!any) return null;

    for (const sp of this.sprites) {
      if (sp.emissiveTexture) {
        sp.texture = sp.emissiveTexture;
        sp.blendMode = "add";
      } else {
        sp.renderable = false;
      }
    }
    renderer.render({ container: world, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
    for (const sp of this.sprites) {
      if (sp.emissiveTexture) {
        sp.texture = sp.albedoTexture;
        sp.blendMode = "normal";
      } else {
        sp.renderable = true;
      }
    }
    return rt;
  }

  destroy(): void {
    this.sprites.clear();
    this.normalRT?.destroy(true);
    this.lightRT?.destroy(true);
    this.albedoRT?.destroy(true);
    this.emissiveRT?.destroy(true);
    this.lightMesh.destroy();
    this.flatNormal.destroy(true);
  }
}
