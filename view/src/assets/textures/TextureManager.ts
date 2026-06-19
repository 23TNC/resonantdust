import { Graphics, Rectangle, RenderTexture, Sprite, Texture, type Renderer } from "pixi.js";

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

  /** Return a previously-allocated slot to the free list so a later `alloc` of the
   *  same size reuses it. Non-coalescing — a freed slot never merges back into a
   *  larger parent, which is fine for our churn (a preview/LOD slot is replaced by
   *  another of the *same* size on a version bump, not promoted to a bigger one). */
  release(slot: { x: number; y: number }, slotSize: number): void {
    const list = this.free.get(slotSize);
    if (list) list.push({ x: slot.x, y: slot.y });
    else this.free.set(slotSize, [{ x: slot.x, y: slot.y }]);
  }
}

/** Opaque handle to one packed slot. Call {@link SlotHandle.release} to return
 *  the slot to its atlas (and decrement the occupancy tally) so the space is
 *  reusable — used to evict a superseded texture version. */
export interface SlotHandle {
  release(): void;
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
 * No deduplication. Plain `pack` slots persist for the lifetime of the manager;
 * `packTracked` returns a {@link SlotHandle} whose `release()` frees the slot for
 * reuse, so the LOD cache can evict a texture when a newer version supersedes it.
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
    return this.packTracked(albedo, normal, emissive).pair;
  }

  /** Like {@link pack}, but also returns a {@link SlotHandle} whose `release()`
   *  frees the slot — for callers (the LOD cache) that evict a texture when a
   *  newer version supersedes it. Plain `pack` discards the handle for
   *  lifetime-of-manager fills (the transparent fallback, UI bakes). */
  packTracked(
    albedo: Texture,
    normal: Texture | null = null,
    emissive: Texture | null = null,
  ): { pair: PackedPair; handle: SlotHandle } {
    const w = albedo.width;
    const h = albedo.height;
    const slotSize = nextPow2(Math.max(w, h));
    if (slotSize > ATLAS_SIZE) {
      throw new Error(
        `TextureManager: source ${w}×${h} (slot ${slotSize}) exceeds atlas size ${ATLAS_SIZE}`,
      );
    }

    this.slotCounts.set(slotSize, (this.slotCounts.get(slotSize) ?? 0) + 1);
    const { atlas, slot, page } = this.allocate(slotSize);
    const pair = this.bake(albedo, normal, emissive, w, h, slot, page);
    const handle: SlotHandle = {
      release: () => {
        atlas.release(slot, slotSize);
        this.slotCounts.set(slotSize, Math.max(0, (this.slotCounts.get(slotSize) ?? 0) - 1));
      },
    };
    return { pair, handle };
  }

  /** Allocate a STABLE `w×h` slot in the shared atlas whose contents are rewritten
   *  **in place** (geo → preview → real LOD). The frame the caller binds never
   *  changes identity, so every sprite bound to it follows the upgrade with **no
   *  texture swap** — and the slot stays in the shared atlas, so all these sprites
   *  still batch into one draw (this scales to thousands of objects).
   *
   *  The slot is cleared transparent at acquire: slots are REUSED (a released
   *  version's slot returns to the free list with its old pixels), so a fresh
   *  acquire can't assume blank — and the geo/preview tiers have transparent areas
   *  that would otherwise reveal the stale pixels. Thereafter `rewrite` fills the
   *  slot (clear + draw) so each tier fully replaces the last. */
  packResizable(
    w: number,
    h: number,
  ): {
    pair: PackedPair;
    handle: SlotHandle;
    rewrite: (albedo: Texture | null, normal: Texture | null, emissive: Texture | null) => void;
  } {
    const slotSize = nextPow2(Math.max(w, h));
    if (slotSize > ATLAS_SIZE) {
      throw new Error(`TextureManager: ${w}×${h} (slot ${slotSize}) exceeds atlas size ${ATLAS_SIZE}`);
    }
    this.slotCounts.set(slotSize, (this.slotCounts.get(slotSize) ?? 0) + 1);
    const { atlas, slot, page } = this.allocate(slotSize);
    // Eagerly stand up the parallel pages so the frame triple is stable for the
    // slot's whole life (a later rewrite may add a normal/emissive).
    if (!page.normal) {
      // NEAREST: a normal map must never be bilinearly filtered. Interpolating two
      // unit normals as RGB yields a short, skewed vector that points wherever the
      // average lands — at a sharp normal edge (the hex-tile bevel, a sprite seam)
      // that average aims at the light and flares as a bright line. Albedo stays
      // linear; only the normal page is point-sampled.
      page.normal = RenderTexture.create({
        width: page.albedo.width,
        height: page.albedo.height,
        scaleMode: "nearest",
      });
      this.clearTransparent(page.normal);
    }
    if (!page.emissive) {
      page.emissive = RenderTexture.create({ width: page.albedo.width, height: page.albedo.height });
      this.clearTransparent(page.emissive);
    }
    const frameOf = (src: RenderTexture): Texture =>
      new Texture({ source: src.source, frame: new Rectangle(slot.x, slot.y, w, h) });
    const pair: PackedPair = {
      albedo: frameOf(page.albedo),
      normal: frameOf(page.normal),
      emissive: frameOf(page.emissive),
    };
    const rewrite = (albedo: Texture | null, normal: Texture | null, emissive: Texture | null): void => {
      this.fillSlot(page.albedo, slot, w, h, albedo);
      this.fillSlot(page.normal!, slot, w, h, normal);
      this.fillSlot(page.emissive!, slot, w, h, emissive);
    };
    const handle: SlotHandle = {
      release: () => {
        atlas.release(slot, slotSize);
        this.slotCounts.set(slotSize, Math.max(0, (this.slotCounts.get(slotSize) ?? 0) - 1));
      },
    };
    return { pair, handle, rewrite };
  }

  /** Fill the slot rect of `target`: clear it transparent, then (if any) draw
   *  `source` scaled into it — so each tier fully replaces the last without bleeding
   *  the previous one through the new tier's transparent areas. `clear:false` on the
   *  draw keeps every other slot intact; the per-slot reset is the scissored clear in
   *  {@link clearSlot} (an `erase`-blend quad is a no-op to a RenderTexture here). */
  private fillSlot(
    target: RenderTexture,
    slot: { x: number; y: number },
    w: number,
    h: number,
    source: Texture | null,
  ): void {
    this.clearSlot(target, slot.x, slot.y, w, h);
    if (source) {
      const sprite = new Sprite(source);
      sprite.position.set(slot.x, slot.y);
      sprite.width = w;
      sprite.height = h;
      this.renderer.render({ container: sprite, target, clear: false });
      sprite.destroy();
    }
  }

  /** Clear a sub-rectangle of `target` to transparent black via a scissored
   *  framebuffer clear — the minimal way to zero ONE atlas slot without disturbing
   *  its neighbours. Texture-space coords map directly to the framebuffer here (PIXI
   *  v8 stores RenderTextures top-left), so no y-flip. WebGL-only; a no-op if the
   *  renderer exposes no `gl` (the project runs the WebGL backend). */
  private clearSlot(target: RenderTexture, x: number, y: number, w: number, h: number): void {
    const r = this.renderer as unknown as {
      gl?: WebGL2RenderingContext;
      renderTarget: { bind(t: RenderTexture, clear: boolean): void };
    };
    const gl = r.gl;
    if (!gl) return;
    r.renderTarget.bind(target, false);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Clear a whole RenderTexture to transparent black. Used to initialise a fresh
   *  atlas page, whose untouched area would otherwise show uninitialised GPU garbage
   *  (often opaque white) through the transparent parts of packed sprites. */
  private clearTransparent(rt: RenderTexture): void {
    const g = new Graphics();
    this.renderer.render({ container: g, target: rt, clear: true });
    g.destroy();
  }

  /** Find an existing atlas slot of `slotSize`, or create a new atlas/page for it;
   *  returns the slot plus the owning atlas (for `release`) and page (for `bake`). */
  private allocate(
    slotSize: number,
  ): { atlas: Atlas; slot: { x: number; y: number }; page: PhysicalPage } {
    for (const page of this.pages) {
      for (const atlas of page.atlases) {
        const slot = atlas.alloc(slotSize);
        if (slot) return { atlas, slot, page };
      }
    }
    const created = this.createAtlas();
    const slot = created.atlas.alloc(slotSize)!;
    return { atlas: created.atlas, slot, page: created.page };
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
        // NEAREST — see packResizable: normal maps must be point-sampled or their
        // edges flare under light. Albedo (the parallel page) stays linear.
        page.normal = RenderTexture.create({
          width: page.albedo.width,
          height: page.albedo.height,
          scaleMode: "nearest",
        });
        this.clearTransparent(page.normal);
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
        this.clearTransparent(page.emissive);
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
    this.clearTransparent(albedo);
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
