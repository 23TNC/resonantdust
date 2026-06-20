//! G4 static cache (Phase 1) — the persistent world-space ground bake.
//!
//! Holds ONE world-space `albedo` render texture (a viewport+overscan window of the
//! world, the memory-efficient choice vs per-chunk RTs — see docs/g4_renderer.md),
//! baked from the existing detached per-chunk ground containers (D1b.1a) which group
//! the ground prims. It is displayed by one Sprite under `tileLayer`; ambient is a
//! separate global multiply overlay in WorldRenderer, so this map holds raw albedo.
//!
//! Phase 1 scope: re-bake the whole window only when the view moves off it (crude
//! re-centre); idle is a pure display. Cell-level dirty re-bake, scroll-on-pan, and
//! the normal/lightmap/lit/depth maps land in later phases.

import { Container, Matrix, RenderTexture, Sprite, type Renderer } from "pixi.js";

/** World-pixel margin baked around the viewport so small pans reveal already-baked
 *  ground before a re-centre is needed. */
const OVERSCAN = 256;

export class StaticCache {
  /** The world-space albedo window. Null until first sized. */
  private albedo: RenderTexture | null = null;
  /** World coord of albedo pixel (0,0). */
  private originX = 0;
  private originY = 0;
  /** Map size in world px (= RT size at resolution 1). */
  private mapW = 0;
  private mapH = 0;
  /** Set when the ground content changed (a tile built/streamed in) so the next
   *  `ensureCovers` re-bakes. Phase 1 re-bakes the whole window; cell-level dirty
   *  re-bake is a later refinement. */
  private dirty = true;
  /** The on-screen display, parented under `tileLayer` so it pans/zooms with the
   *  world. Carries the raw albedo; ambient is applied by a global overlay. */
  readonly display = new Sprite();

  constructor(parent: Container) {
    this.display.eventMode = "none"; // pure visual — never capture pointer (pan) events
    parent.addChild(this.display);
  }

  /** Ensure the albedo window covers `view` (world rect), baking the ground from the
   *  `chunks` prim-source containers if it doesn't (first call, or the view moved off
   *  the current window). No-op when the window still covers the view → idle is free. */
  ensureCovers(
    renderer: Renderer,
    view: { x: number; y: number; w: number; h: number },
    chunks: Iterable<Container>,
  ): void {
    if (this.albedo && this.covers(view) && !this.dirty) return;
    this.recenterAndBake(renderer, view, chunks);
  }

  /** Mark the ground content stale (a tile built / changed) so the next
   *  `ensureCovers` re-bakes the window. */
  markDirty(): void {
    this.dirty = true;
  }

  private covers(view: { x: number; y: number; w: number; h: number }): boolean {
    return (
      view.x >= this.originX &&
      view.y >= this.originY &&
      view.x + view.w <= this.originX + this.mapW &&
      view.y + view.h <= this.originY + this.mapH
    );
  }

  /** Re-centre the window on `view` (+ overscan) and bake every chunk container into
   *  it at the world→map offset. */
  private recenterAndBake(
    renderer: Renderer,
    view: { x: number; y: number; w: number; h: number },
    chunks: Iterable<Container>,
  ): void {
    const w = Math.ceil(view.w + OVERSCAN * 2);
    const h = Math.ceil(view.h + OVERSCAN * 2);
    if (!this.albedo || this.mapW !== w || this.mapH !== h) {
      this.albedo?.destroy(true);
      this.albedo = RenderTexture.create({ width: w, height: h });
      this.mapW = w;
      this.mapH = h;
      this.display.texture = this.albedo;
    }
    this.originX = view.x - OVERSCAN;
    this.originY = view.y - OVERSCAN;
    this.display.position.set(this.originX, this.originY);
    this.dirty = false;

    // Bake: clear, then render every chunk container translated world→map.
    const transform = new Matrix().translate(-this.originX, -this.originY);
    renderer.render({ container: new Container(), target: this.albedo, clear: true });
    for (const c of chunks) {
      renderer.render({ container: c, target: this.albedo, clear: false, transform });
    }
  }

  destroy(): void {
    this.albedo?.destroy(true);
    this.albedo = null;
    this.display.destroy();
  }
}
