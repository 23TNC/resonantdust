//! Stroke-based paint history for the Card Editor's brush.
//!
//! Each editable channel (albedo / normal …) keeps a `backing` canvas (its
//! base — the master image plus any strokes that overflowed the cap), and a
//! `base` canvas = backing + the channel's currently-applied strokes. The shown
//! `display` canvas (wrapped by the Pixi texture) is `base`, or `base + the
//! in-progress stroke` while drawing.
//!
//! Strokes (one per mouse-down→up) live in a SINGLE global, ordered list across
//! channels, capped at `limit`. Undo pops the most-recent stroke; redo re-applies
//! it; drawing again drops the redo tail. When the list overflows, the oldest
//! stroke is baked into ITS channel's backing — so we hold at most `limit`
//! stroke layers, and "collapse for save" is just reading each channel's display.

import { Texture } from "pixi.js";

interface Channel {
  w: number;
  h: number;
  backing: HTMLCanvasElement;          // base + baked-overflow strokes
  base: HTMLCanvasElement;             // backing + applied strokes (committed)
  baseCtx: CanvasRenderingContext2D;
  display: HTMLCanvasElement;          // shown: base (+ in-progress stroke)
  displayCtx: CanvasRenderingContext2D;
  texture: Texture;
}

interface Entry { ch: Channel; stroke: HTMLCanvasElement; }

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export class PaintHistory {
  private readonly channels = new Map<string, Channel>();
  private order: Entry[] = [];
  private redoStack: Entry[] = [];
  private current: { ch: Channel; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;

  constructor(private readonly limit: number) {}

  /** Editable display texture for `key` (`stem|channel`), created from the master
   *  on first use. `null` if the master image can't seed a canvas yet. */
  getOrCreateTexture(key: string, master: Texture): Texture | null {
    const existing = this.channels.get(key);
    if (existing) return existing.texture;
    const src = master.source;
    const w = src.pixelWidth || src.width;
    const h = src.pixelHeight || src.height;
    const resource = src.resource as CanvasImageSource | undefined;
    if (!resource || w <= 0 || h <= 0) return null;

    const backing = makeCanvas(w, h);
    backing.getContext("2d")?.drawImage(resource, 0, 0, w, h);
    const base = makeCanvas(w, h);
    const baseCtx = base.getContext("2d");
    const display = makeCanvas(w, h);
    const displayCtx = display.getContext("2d");
    if (!baseCtx || !displayCtx) return null;
    baseCtx.drawImage(backing, 0, 0);
    displayCtx.drawImage(base, 0, 0);

    const ch: Channel = { w, h, backing, base, baseCtx, display, displayCtx, texture: Texture.from(display) };
    this.channels.set(key, ch);
    return ch.texture;
  }

  has(key: string): boolean {
    return this.channels.has(key);
  }

  /** The channel's current (composited) display canvas — read by the preview
   *  lighting; `null` if the channel doesn't exist. */
  channelCanvas(key: string): HTMLCanvasElement | null {
    return this.channels.get(key)?.display ?? null;
  }

  /** Start a stroke on `key`. Drops the redo tail (forward history is lost once
   *  you draw again). No-op if the channel doesn't exist. */
  begin(key: string): void {
    const ch = this.channels.get(key);
    if (!ch) return;
    this.redoStack = [];
    const canvas = makeCanvas(ch.w, ch.h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    this.current = { ch, canvas, ctx };
  }

  /** Paint a `size`-texel square of `color` (CSS) at texel `(tx, ty)` into the
   *  in-progress stroke, then refresh the channel's display. */
  paint(tx: number, ty: number, size: number, color: string): void {
    const c = this.current;
    if (!c) return;
    c.ctx.fillStyle = color;
    c.ctx.fillRect(Math.round(tx - size / 2), Math.round(ty - size / 2), size, size);
    const ch = c.ch;
    ch.displayCtx.clearRect(0, 0, ch.w, ch.h);
    ch.displayCtx.drawImage(ch.base, 0, 0);
    ch.displayCtx.drawImage(c.canvas, 0, 0);
    ch.texture.source.update();
  }

  /** Finalise the in-progress stroke into the ordered list (baking the oldest
   *  into its backing on overflow), and commit it to the channel's base. */
  end(): void {
    const c = this.current;
    this.current = null;
    if (!c) return;
    const ch = c.ch;
    ch.baseCtx.drawImage(c.canvas, 0, 0); // commit into base
    this.order.push({ ch, stroke: c.canvas });
    if (this.order.length > this.limit) {
      const old = this.order.shift();
      // Bake the overflowed stroke into ITS channel's backing — its base already
      // includes those pixels, so no recompose needed there.
      if (old) old.ch.backing.getContext("2d")?.drawImage(old.stroke, 0, 0);
    }
    ch.displayCtx.clearRect(0, 0, ch.w, ch.h);
    ch.displayCtx.drawImage(ch.base, 0, 0);
    ch.texture.source.update();
  }

  undo(): void {
    const e = this.order.pop();
    if (!e) return;
    this.redoStack.push(e);
    this.recompose(e.ch);
  }

  redo(): void {
    const e = this.redoStack.pop();
    if (!e) return;
    this.order.push(e);
    this.recompose(e.ch);
  }

  canUndo(): boolean { return this.order.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  /** Rebuild a channel's base (= backing + its applied strokes) + display. */
  private recompose(ch: Channel): void {
    ch.baseCtx.clearRect(0, 0, ch.w, ch.h);
    ch.baseCtx.drawImage(ch.backing, 0, 0);
    for (const e of this.order) if (e.ch === ch) ch.baseCtx.drawImage(e.stroke, 0, 0);
    ch.displayCtx.clearRect(0, 0, ch.w, ch.h);
    ch.displayCtx.drawImage(ch.base, 0, 0);
    ch.texture.source.update();
  }

  /** Drop every channel + stroke (a new card → fresh copies). */
  clear(): void {
    for (const ch of this.channels.values()) ch.texture.destroy(true);
    this.channels.clear();
    this.order = [];
    this.redoStack = [];
    this.current = null;
  }
}
