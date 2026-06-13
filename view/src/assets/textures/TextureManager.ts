import { Rectangle, RenderTexture, Sprite, Texture, type Renderer } from "pixi.js";

/**
 * Logical atlas size. Every atlas is exactly this large, regardless of
 * the physical RenderTexture it lives in. Atlases are independent: each
 * one runs its own quadtree over its 4096×4096 region.
 */
const ATLAS_SIZE = 4096;

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function queryMaxTextureSize(renderer: Renderer): number {
  const r = renderer as unknown as {
    gl?: { getParameter(p: number): number; MAX_TEXTURE_SIZE: number };
    limits?: { maxTextureDimension2D?: number };
  };
  if (r.gl?.getParameter) return r.gl.getParameter(r.gl.MAX_TEXTURE_SIZE);
  if (r.limits?.maxTextureDimension2D) return r.limits.maxTextureDimension2D;
  return ATLAS_SIZE;
}

/**
 * Quadtree allocator for a single 4096×4096 atlas region.
 *
 * Slots are always power-of-2 squares. `originX/Y` is the atlas's offset
 * within its backing physical texture, so all coordinates returned by
 * `alloc` are absolute and can be used directly as render targets and
 * as Texture frame coordinates.
 *
 * Allocation rule: try the exact-size free list first; otherwise pop
 * the smallest available larger slot and recursively split, returning
 * the top-left child at each level. The three siblings always go to
 * the free list at the post-split size. This guarantees we fill
 * existing free slots before promoting a larger one.
 */
class Atlas {
  readonly originX: number;
  readonly originY: number;
  private readonly free = new Map<number, Array<{ x: number; y: number }>>();

  constructor(originX: number, originY: number) {
    this.originX = originX;
    this.originY = originY;
    this.free.set(ATLAS_SIZE, [{ x: originX, y: originY }]);
  }

  /** Allocate a power-of-2 slot of the given size, or null if the
   *  atlas can't satisfy the request. */
  alloc(slotSize: number): { x: number; y: number } | null {
    if (slotSize > ATLAS_SIZE) return null;

    const exact = this.free.get(slotSize);
    if (exact && exact.length > 0) return exact.pop()!;

    let parentSize = slotSize * 2;
    let parent: { x: number; y: number } | null = null;
    while (parentSize <= ATLAS_SIZE) {
      const list = this.free.get(parentSize);
      if (list && list.length > 0) {
        parent = list.pop()!;
        break;
      }
      parentSize *= 2;
    }
    if (!parent) return null;

    while (parentSize > slotSize) {
      const half = parentSize / 2;
      const x: number = parent.x;
      const y: number = parent.y;
      const siblings = this.free.get(half) ?? [];
      siblings.push({ x: x + half, y });
      siblings.push({ x, y: y + half });
      siblings.push({ x: x + half, y: y + half });
      this.free.set(half, siblings);
      parent = { x, y };
      parentSize = half;
    }
    return parent;
  }
}

interface PhysicalPage {
  /** Albedo (colour) page — the source every sprite renders from today. */
  albedo: RenderTexture;
  /** Parallel normal-map page, identical dimensions to `albedo` and sharing
   *  this page's `atlases` allocators, so a slot maps to the same (x, y) in
   *  both. Created lazily on the first normal bake — a page whose sprites
   *  have no normal map never allocates the second GL texture. */
  normal: RenderTexture | null;
  /** Parallel emissive page, same deal as `normal` — same allocator/slots,
   *  lazy on the first emissive bake. Sampled by the deferred emissive pass
   *  (additive self-illumination); null until some sprite carries one. */
  emissive: RenderTexture | null;
  atlases: Atlas[];
}

/**
 * One packed slot, exposed as a frame into the albedo page plus the matching
 * frame into the parallel normal page. `albedo` and `normal` share identical
 * `frame` rectangles (same slot) and differ only in their backing source, so a
 * lighting shader samples both at the same UVs. `normal` is null when the pack
 * had no normal source (UI fills, the white fallback, or art whose normal map
 * hasn't been generated yet).
 */
export interface PackedPair {
  readonly albedo: Texture;
  readonly normal: Texture | null;
  /** Emissive frame at the same slot, or null when the pack had no emissive
   *  source (the common case — emissive is opt-in per art). Fed to the
   *  deferred emissive pass; null → the sprite emits nothing. */
  readonly emissive: Texture | null;
}

/**
 * Packs source textures into shared atlases backed by one or more
 * physical RenderTextures.
 *
 * - Atlases are always 4096×4096 and run their own quadtree allocator.
 * - Physical RenderTextures are sized to the GPU's max texture size,
 *   so multiple 4096 atlases share a single GL texture when the GPU
 *   supports it (max 8192 → 4 atlases per physical; max 16384 → 16;
 *   max 4096 → 1).
 * - Atlases remain independent — they share GL memory but never share
 *   quadtree state, and each allocation is local to a single atlas.
 *
 * Usage:
 *   const { albedo, normal } = textures.pack(albedoTexture, normalTexture);
 *   sprite.texture = albedo; // normal feeds the lighting pass at the same frame
 *
 * Each pack allocates ONE slot shared by the albedo and normal pages, so the
 * two returned frames are byte-identical rectangles into parallel atlases. The
 * `normal` source is optional — pass nothing for colour-only fills and `normal`
 * comes back null. The returned frames match the source's native pixel
 * dimensions placed at the slot's top-left, so the sprite draws at the
 * original size with no distortion. The slot itself is rounded up to
 * `nextPow2(max(width, height))`; any unused area inside that slot is
 * wasted but harmless. Albedo and normal sources must share dimensions (the
 * slot is sized from the albedo).
 *
 * No deduplication and no eviction — every pack call consumes a fresh
 * slot for the lifetime of the manager.
 */
export class TextureManager {
  private readonly renderer: Renderer;
  private readonly maxTextureSize: number;
  private readonly pages: PhysicalPage[] = [];
  /** Count of packed slots, keyed by `slotSize` (power-of-2). Bumped
   *  by every `pack()` call. Read by `stats()` for the HUD chip. */
  private readonly slotCounts = new Map<number, number>();

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.maxTextureSize = queryMaxTextureSize(renderer);
    if (this.maxTextureSize < ATLAS_SIZE) {
      throw new Error(
        `TextureManager: GPU max texture size ${this.maxTextureSize} < atlas size ${ATLAS_SIZE}`,
      );
    }
  }

  /** Snapshot of atlas occupancy for HUD / debug surfaces. `atlases`
   *  is the total number of 4096-region atlases across every
   *  physical page; `slotCounts` is the running tally of packed
   *  slots grouped by their power-of-2 size. */
  stats(): { atlases: number; slotCounts: ReadonlyMap<number, number> } {
    let atlases = 0;
    for (const page of this.pages) atlases += page.atlases.length;
    return { atlases, slotCounts: this.slotCounts };
  }

  /**
   * Pack `albedo` (and optionally its `normal`) into the atlas pool and return
   * the matching frames. One slot is allocated and used for both pages, so the
   * returned `albedo`/`normal` frames are identical rectangles into parallel
   * atlases. `normal` comes back null when no normal source is given. Frames
   * match the albedo's native (width × height) at the slot's top-left.
   */
  pack(
    albedo: Texture,
    normal: Texture | null = null,
    emissive: Texture | null = null,
  ): PackedPair {
    const w = albedo.width;
    const h = albedo.height;
    const slotSize = nextPow2(Math.max(w, h));
    if (slotSize > ATLAS_SIZE) {
      throw new Error(
        `TextureManager: source ${w}×${h} (slot ${slotSize}) exceeds atlas size ${ATLAS_SIZE}`,
      );
    }

    this.slotCounts.set(slotSize, (this.slotCounts.get(slotSize) ?? 0) + 1);

    for (const page of this.pages) {
      for (const atlas of page.atlases) {
        const slot = atlas.alloc(slotSize);
        if (slot) return this.bake(albedo, normal, emissive, w, h, slot, page);
      }
    }

    const created = this.createAtlas();
    const slot = created.atlas.alloc(slotSize)!;
    return this.bake(albedo, normal, emissive, w, h, slot, created.page);
  }

  destroy(): void {
    for (const page of this.pages) {
      page.albedo.destroy(true);
      page.normal?.destroy(true);
      page.emissive?.destroy(true);
    }
    this.pages.length = 0;
  }

  private bake(
    albedo: Texture,
    normal: Texture | null,
    emissive: Texture | null,
    w: number,
    h: number,
    slot: { x: number; y: number },
    page: PhysicalPage,
  ): PackedPair {
    const albedoFrame = this.renderInto(albedo, slot, page.albedo, w, h);
    let normalFrame: Texture | null = null;
    if (normal) {
      // Lazily stand up the parallel normal page at the same dimensions the
      // first time this page bakes a normal — the shared allocator already
      // reserved this slot, so the frame lines up with the albedo.
      if (!page.normal) {
        page.normal = RenderTexture.create({
          width: page.albedo.width,
          height: page.albedo.height,
        });
      }
      normalFrame = this.renderInto(normal, slot, page.normal, w, h);
    }
    let emissiveFrame: Texture | null = null;
    if (emissive) {
      // Same lazy-parallel-page idiom as `normal` — most art has no emissive,
      // so the third GL texture only exists once a glowing sprite packs here.
      if (!page.emissive) {
        page.emissive = RenderTexture.create({
          width: page.albedo.width,
          height: page.albedo.height,
        });
      }
      emissiveFrame = this.renderInto(emissive, slot, page.emissive, w, h);
    }
    return { albedo: albedoFrame, normal: normalFrame, emissive: emissiveFrame };
  }

  /** Draw one `source` into `target` at `slot` and return a frame over the
   *  baked region. Shared by the albedo and normal bakes. */
  private renderInto(
    source: Texture,
    slot: { x: number; y: number },
    target: RenderTexture,
    w: number,
    h: number,
  ): Texture {
    const sprite = new Sprite(source);
    sprite.position.set(slot.x, slot.y);
    this.renderer.render({ container: sprite, target, clear: false });
    sprite.destroy();
    return new Texture({
      source: target.source,
      frame: new Rectangle(slot.x, slot.y, w, h),
    });
  }

  private createAtlas(): { atlas: Atlas; page: PhysicalPage } {
    for (const page of this.pages) {
      const offset = this.findFreeAtlasSlot(page);
      if (offset) {
        const atlas = new Atlas(offset.x, offset.y);
        page.atlases.push(atlas);
        return { atlas, page };
      }
    }

    const size = this.maxTextureSize;
    const albedo = RenderTexture.create({ width: size, height: size });
    const page: PhysicalPage = { albedo, normal: null, emissive: null, atlases: [] };
    this.pages.push(page);
    const atlas = new Atlas(0, 0);
    page.atlases.push(atlas);
    return { atlas, page };
  }

  private findFreeAtlasSlot(page: PhysicalPage): { x: number; y: number } | null {
    const { width, height } = page.albedo;
    for (let y = 0; y + ATLAS_SIZE <= height; y += ATLAS_SIZE) {
      for (let x = 0; x + ATLAS_SIZE <= width; x += ATLAS_SIZE) {
        const taken = page.atlases.some((a) => a.originX === x && a.originY === y);
        if (!taken) return { x, y };
      }
    }
    return null;
  }
}
