import { Matrix, Mesh, MeshGeometry, RenderTexture, Texture, UniformGroup, type Container, type Renderer } from "pixi.js";
import { LitSprite } from "./LitSprite";
import { MAX_LIGHTS, makeDeferredLightShader } from "./deferredLightShader";
import { worldHexRadius } from "../viewport/hex/hexSize";

/** Ambient floor — the lit base every cell starts from (the lightmap's clear
 *  value); a low floor so a light reads as casting rather than just brightening. */
export const LIT_AMBIENT = 0.12;

/** Re-bake priority for the dirty-region queue (higher = serviced first). Cursor
 *  highest (moves every frame), souls next, static torches last. Consumed by the
 *  G4 dirty queue (docs/g4_renderer.md). */
export const LightPriority = {
  cursor: 100,
  soul: 50,
  static: 0,
} as const;

/** A world-space point light. `x/y` are viewport world (panLayer-local) px;
 *  `height` is the light's height above the flat sprite plane (px — what makes the
 *  normal map read); `radius` is the falloff radius in HEX-TILE units (px = radius ×
 *  hexSize); `color` is 0xRRGGBB; `brightness` scales it. */
export interface Light {
  x: number;
  y: number;
  height: number;
  radius: number;
  color: number;
  brightness: number;
  /** Casts shadows when true (default). Per-light opt-out via `casts_shadow`. */
  castsShadow: boolean;
  /** Bakes into the per-chunk lightmap when true (default). False keeps it in the
   *  live dynamic pass — set for per-frame movers (the cursor). */
  canBake: boolean;
  /** Runtime: this light's region needs re-baking. Consumed by the dirty queue. */
  dirty: boolean;
  /** Re-bake priority (see `LightPriority`). */
  priority: number;
}

/** Default cursor-light shape — tuned blind; expect to adjust live. */
export const CURSOR_LIGHT: Omit<Light, "x" | "y"> = {
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
  // 1×1 flat-up normal (RGB 128,128,255 → +Z) for sprites with no real normal map.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#8080ff";
  ctx.fillRect(0, 0, 1, 1);
  return Texture.from(canvas);
}

/**
 * G4 lighting (docs/g4_renderer.md). Owns:
 *  - the `LitSprite` registry (so a bake can swap each sprite's `texture` for its
 *    `normalTexture`);
 *  - the world-space LIGHTS (cursor + static card/torch lights);
 *  - `bakeGround` (a per-chunk detached container → world-space albedo + normal RTs)
 *    and `bakeChunkLit` (light those RTs into `albedo × (ambient + Σ static lights)`,
 *    the chunk's displayed lit map). Reuses one Lambert+falloff light shader.
 */
export class DeferredLighting {
  readonly flatNormal: Texture = makeFlatNormal();
  /** Live lit sprites in this viewport (bake input set). */
  private readonly sprites = new Set<LitSprite>();
  private cursor: { x: number; y: number } | null = null;
  /** Static + card `light` lights (registered by `LightPrim`, or a placed torch).
   *  `canBake` ones bake into the per-chunk lightmap; the cursor stays live. */
  private readonly cardLights = new Set<Light>();
  /** Shared light uniforms (positions in CHUNK-LOCAL px, colours). */
  private readonly lightUniforms = new UniformGroup({
    uLightData: { value: new Float32Array(MAX_LIGHTS * 4), type: "vec4<f32>", size: MAX_LIGHTS },
    uLightColor: { value: new Float32Array(MAX_LIGHTS * 4), type: "vec4<f32>", size: MAX_LIGHTS },
    uLightCount: { value: 0, type: "f32" },
    uAmbient: { value: LIT_AMBIENT, type: "f32" },
    uNormalYSign: { value: -1, type: "f32" },
  });
  private readonly lightShader = makeDeferredLightShader(this.lightUniforms);
  /** The quad the light bake draws — geometry resized per chunk in `bakeChunkLit`. */
  private readonly lightMesh = new Mesh({
    geometry: new MeshGeometry({
      positions: new Float32Array(8),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    }),
    shader: this.lightShader,
  });

  /** Shared, never-rendered instance for offline/preview renders (drag ghost,
   *  card-face bakes) — they draw plain albedo and never bake. */
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

  /** Register a `light` light (card `^light` prim, or a placed static torch). The
   *  caller keeps mutating the object's world position / shape; we just read it. */
  registerLight(light: Light): void {
    this.cardLights.add(light);
  }
  unregisterLight(light: Light): void {
    this.cardLights.delete(light);
  }

  /** Cursor position in this viewport's world space, or null to drop it. (The
   *  cursor is a live dynamic light — Phase 3; not baked here.) */
  setCursorWorld(x: number | null, y?: number): void {
    this.cursor = x === null ? null : { x, y: y ?? 0 };
  }

  /**
   * Bake one DETACHED ground container (a per-chunk container, not in the scene)
   * into world-space albedo + normal RTs, offset so the container's world bounds
   * origin `(offsetX, offsetY)` maps to the RT origin.
   *
   * Albedo = the container as it draws. Normal = each child `LitSprite`'s normal
   * frame (white-tinted so the albedo tint can't skew the vector); a child with no
   * normal (the flat `bg`) is hidden so it falls through to the flat-up clear.
   */
  bakeGround(
    renderer: Renderer,
    container: Container,
    albedoRT: RenderTexture,
    normalRT: RenderTexture,
    offsetX: number,
    offsetY: number,
  ): void {
    const transform = new Matrix().translate(-offsetX, -offsetY);
    renderer.render({ container, target: albedoRT, clear: true, transform });
    const restore: { sp: LitSprite; tint: number }[] = [];
    const hidden: LitSprite[] = [];
    for (const child of container.children) {
      if (!(child instanceof LitSprite)) continue;
      // Bake sources only — never drawn under panLayer; drop from the registry.
      this.unregister(child);
      if (!child.normalTexture) {
        if (child.renderable) {
          child.renderable = false;
          hidden.push(child);
        }
      } else {
        restore.push({ sp: child, tint: child.tint });
        child.texture = child.normalTexture;
        child.tint = 0xffffff;
      }
    }
    renderer.render({ container, target: normalRT, clear: true, clearColor: [0.5, 0.5, 1, 1], transform });
    for (const sp of hidden) sp.renderable = true;
    for (const { sp, tint } of restore) {
      sp.texture = sp.albedoTexture;
      sp.tint = tint;
    }
  }

  /**
   * Bake a chunk's LIT map: light its normal G-buffer (`normalRT`) with the static
   * lights and multiply by its albedo → `litRT = albedo × (ambient + Σ static)`.
   * Lights are summed in CHUNK-LOCAL px (the chunk's world origin subtracted), so
   * the quad — sized to the chunk and sampling at its own pixel positions — gets
   * the right world distances with no camera transform (the bake is world-space,
   * zoom 1). Re-run only when the chunk's geometry or an in-range light changes.
   */
  bakeChunkLit(
    renderer: Renderer,
    normalRT: RenderTexture,
    albedoRT: RenderTexture,
    litRT: RenderTexture,
    originX: number,
    originY: number,
  ): void {
    const w = litRT.width;
    const h = litRT.height;
    const pos = this.lightMesh.geometry.positions;
    pos[0] = 0; pos[1] = 0;
    pos[2] = w; pos[3] = 0;
    pos[4] = w; pos[5] = h;
    pos[6] = 0; pos[7] = h;
    this.lightMesh.geometry.positions = pos;
    this.packChunkLights(originX, originY);
    this.lightShader.texture = normalRT; // normal G-buffer (sets the RT flip matrix)
    this.lightShader.resources.uAlbedo = albedoRT.source;
    this.lightShader.resources.uAlbedoSampler = albedoRT.source.style;
    renderer.render({ container: this.lightMesh, target: litRT, clear: true });
  }

  /** Pack the BAKEABLE (`canBake`) lights into the uniforms in chunk-local px.
   *  TODO(perf): with many static lights, pack only those whose disk overlaps the
   *  chunk (cell→lights index); for now every chunk evaluates all of them. */
  private packChunkLights(originX: number, originY: number): void {
    const u = this.lightUniforms.uniforms;
    const data = u.uLightData as Float32Array;
    const color = u.uLightColor as Float32Array;
    const hexR = worldHexRadius();
    let i = 0;
    for (const l of this.cardLights) {
      if (i >= MAX_LIGHTS) break;
      if (!l.canBake) continue;
      data[i * 4 + 0] = l.x - originX;
      data[i * 4 + 1] = l.y - originY;
      data[i * 4 + 2] = l.height;
      data[i * 4 + 3] = l.radius * hexR; // tiles → px (zoom 1)
      color[i * 4 + 0] = ((l.color >> 16) & 0xff) / 255;
      color[i * 4 + 1] = ((l.color >> 8) & 0xff) / 255;
      color[i * 4 + 2] = (l.color & 0xff) / 255;
      color[i * 4 + 3] = l.brightness;
      i++;
    }
    u.uLightCount = i;
    u.uAmbient = LIT_AMBIENT;
    this.lightUniforms.update();
  }

  destroy(): void {
    this.sprites.clear();
    this.lightMesh.destroy();
    this.flatNormal.destroy(true);
  }
}
