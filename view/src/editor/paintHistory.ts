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
import { type Brush, makeBrushStamp } from "./brush";

interface Channel {
  key: string;                         // `stem|channel` — its registry key (for dirty reporting)
  w: number;
  h: number;
  origin: HTMLCanvasElement;           // pristine master — never written; the erase source
  backing: HTMLCanvasElement;          // base + baked-overflow strokes
  base: HTMLCanvasElement;             // backing + applied strokes (committed)
  baseCtx: CanvasRenderingContext2D;
  display: HTMLCanvasElement;          // shown: base (+ in-progress stroke)
  displayCtx: CanvasRenderingContext2D;
  texture: Texture;
}

interface Entry { ch: Channel; stroke: HTMLCanvasElement; }

/** The in-progress stroke's state: its target channel + scratch canvas, plus the
 *  pre-built dab (a tinted stamp for paint) / mask + temp (for erase). */
interface Current {
  ch: Channel;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  brush: Brush;
  mask: HTMLCanvasElement;            // alpha stamp
  dab: HTMLCanvasElement | null;      // mask tinted with the stroke colour (paint)
  tmp: HTMLCanvasElement | null;      // stamp-sized scratch for backing reveal (erase)
}

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
  private current: Current | null = null;
  /** Keys of channels that have received at least one committed stroke since the
   *  last {@link clear} — what "save master" uploads. Conservative: an undo back
   *  to the origin leaves the key set (a re-upload of identical pixels is a
   *  harmless idempotent overwrite), but a never-touched channel is never marked,
   *  so a fallback-loaded copy (e.g. diffuse shown as albedo) is NOT mis-saved. */
  private readonly dirty = new Set<string>();

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
    return this.makeChannel(key, w, h, resource);
  }

  /** Editable display texture for `key`, created BLANK (transparent) at `w`×`h`
   *  when there's no master to seed from — e.g. an emissive layer a sprite
   *  doesn't ship yet, painted from scratch. Existing channels are returned
   *  as-is. `null` on a degenerate size. */
  getOrCreateBlank(key: string, w: number, h: number): Texture | null {
    const existing = this.channels.get(key);
    if (existing) return existing.texture;
    if (w <= 0 || h <= 0) return null;
    return this.makeChannel(key, w, h);
  }

  /** Build a channel's backing/base/display canvases (+ wrapping texture), seeded
   *  from `seed` when given (else left blank), and register it under `key`. */
  private makeChannel(key: string, w: number, h: number, seed?: CanvasImageSource): Texture | null {
    const origin = makeCanvas(w, h);
    if (seed) origin.getContext("2d")?.drawImage(seed, 0, 0, w, h);
    const backing = makeCanvas(w, h);
    backing.getContext("2d")?.drawImage(origin, 0, 0); // backing starts == origin, then accrues overflow
    const base = makeCanvas(w, h);
    const baseCtx = base.getContext("2d");
    const display = makeCanvas(w, h);
    const displayCtx = display.getContext("2d");
    if (!baseCtx || !displayCtx) return null;
    baseCtx.drawImage(backing, 0, 0);
    displayCtx.drawImage(base, 0, 0);

    const ch: Channel = { key, w, h, origin, backing, base, baseCtx, display, displayCtx, texture: Texture.from(display) };
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

  /** Start a `brush` stroke on `key`. Drops the redo tail (forward history is
   *  lost once you draw again). Pre-builds the brush stamp — a colour-tinted dab
   *  for painting, or a mask + scratch for erasing (which reveals the backing).
   *  No-op if the channel doesn't exist. */
  begin(key: string, brush: Brush): void {
    const ch = this.channels.get(key);
    if (!ch) return;
    this.redoStack = [];
    const canvas = makeCanvas(ch.w, ch.h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const mask = makeBrushStamp(brush.size, brush.shape, brush.hardness);
    let dab: HTMLCanvasElement | null = null;
    let tmp: HTMLCanvasElement | null = null;
    if (brush.erase) {
      tmp = makeCanvas(mask.width, mask.height);
    } else {
      dab = makeCanvas(mask.width, mask.height);
      const dctx = dab.getContext("2d");
      if (dctx) {
        dctx.fillStyle = brush.color;
        dctx.fillRect(0, 0, dab.width, dab.height);
        dctx.globalCompositeOperation = "destination-in"; // keep colour only where the stamp is opaque
        dctx.globalAlpha = brush.opacity;                  // scale the dab's peak alpha (build-up blending)
        dctx.drawImage(mask, 0, 0);
      }
    }
    this.current = { ch, canvas, ctx, brush, mask, dab, tmp };
  }

  /** Stamp the brush at texel `(tx, ty)` into the in-progress stroke, then refresh
   *  the channel's display. Paint lays down the tinted dab; erase reveals the
   *  channel's backing (master) pixels through the stamp's alpha. */
  paint(tx: number, ty: number): void {
    const c = this.current;
    if (!c) return;
    const s = c.mask.width;
    const ox = Math.round(tx - s / 2);
    const oy = Math.round(ty - s / 2);
    if (c.brush.erase && c.tmp) {
      const tctx = c.tmp.getContext("2d");
      if (tctx) {
        tctx.globalCompositeOperation = "source-over";
        tctx.clearRect(0, 0, s, s);
        tctx.drawImage(c.ch.origin, ox, oy, s, s, 0, 0, s, s); // PRISTINE master crop under the stamp
        tctx.globalCompositeOperation = "destination-in";
        tctx.drawImage(c.mask, 0, 0);                           // masked by the brush alpha
        c.ctx.globalAlpha = c.brush.opacity;                    // partial restore for blendable erasing
        c.ctx.drawImage(c.tmp, ox, oy);
        c.ctx.globalAlpha = 1;
      }
    } else if (c.dab) {
      c.ctx.drawImage(c.dab, ox, oy);
    }
    const ch = c.ch;
    ch.displayCtx.clearRect(0, 0, ch.w, ch.h);
    ch.displayCtx.drawImage(ch.base, 0, 0);
    ch.displayCtx.drawImage(c.canvas, 0, 0);
    ch.texture.source.update();
  }

  /** Fill `mask` (a white region mask, any resolution — scaled to fit) tinted
   *  with `color` into `key` as a single committed, undoable stroke. Used by the
   *  paint bucket. No-op if the channel doesn't exist. */
  fillRegion(key: string, mask: HTMLCanvasElement, color: string): void {
    const ch = this.channels.get(key);
    if (!ch) return;
    this.redoStack = [];
    const canvas = makeCanvas(ch.w, ch.h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, ch.w, ch.h);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mask, 0, 0, ch.w, ch.h); // scale the region mask to the channel
    this.commitStroke(ch, canvas);
  }

  /** Finalise the in-progress stroke into the ordered list (baking the oldest
   *  into its backing on overflow), and commit it to the channel's base. */
  end(): void {
    const c = this.current;
    this.current = null;
    if (!c) return;
    this.commitStroke(c.ch, c.canvas);
  }

  /** Commit a finished `stroke` canvas into `ch`'s base + the ordered undo list,
   *  baking the oldest into its backing on overflow. */
  private commitStroke(ch: Channel, stroke: HTMLCanvasElement): void {
    ch.baseCtx.drawImage(stroke, 0, 0); // commit into base
    this.dirty.add(ch.key);
    this.order.push({ ch, stroke });
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

  /** Edited channels (received ≥1 stroke since the last {@link clear}) as
   *  `{ key, canvas }`, where `canvas` is the composited display to upload. */
  dirtyChannels(): Array<{ key: string; canvas: HTMLCanvasElement }> {
    const out: Array<{ key: string; canvas: HTMLCanvasElement }> = [];
    for (const key of this.dirty) {
      const ch = this.channels.get(key);
      if (ch) out.push({ key, canvas: ch.display });
    }
    return out;
  }

  /** Drop every channel + stroke (a new card → fresh copies). */
  clear(): void {
    for (const ch of this.channels.values()) ch.texture.destroy(true);
    this.channels.clear();
    this.order = [];
    this.redoStack = [];
    this.current = null;
    this.dirty.clear();
  }
}
