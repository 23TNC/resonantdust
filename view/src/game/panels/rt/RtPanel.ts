import { Container, Graphics, Sprite, Text, type RenderTexture } from "pixi.js";
import type { LayoutNode } from "../../layout/LayoutNode";
import type { PanelTaskbar } from "../../../ui/dom/PanelTaskbar";
import type { UiEditMode } from "../../../ui/dom/UiEditMode";
import { PixiPanel } from "../../../ui/dom/PixiPanel";

/** One render-texture channel to preview. `texture` is null for a channel that
 *  isn't produced yet (a dormant G-buffer) — the tile draws an empty placeholder
 *  so the panel doubles as a checklist of what's live. */
export interface RtChannel {
  name: string;
  texture: RenderTexture | null;
}

/** A snapshot of what to preview, re-read each tick: the viewport's display aspect
 *  ratio (tiles are sized to match it) plus its channels. The RTs can be
 *  re-allocated (a viewport resize swaps its display RT), so the panel never caches
 *  a texture reference across frames. */
export interface RtView {
  /** Viewport width / height; each tile's image area uses this aspect. */
  aspect: number;
  channels: RtChannel[];
}

export type RtSource = () => RtView;

/** Tiles per row — fixed two-up, as requested. */
const COLS = 2;
const GAP = 8;
/** Reserved strip above each thumbnail for its name + dimensions label. */
const LABEL_H = 16;
/** Right-edge gutter reserved for the scrollbar (track + thumb). */
const SCROLLBAR_W = 8;
const GUTTER = SCROLLBAR_W + 4;
/** Wheel notches scroll this many px each; thumb drag is 1:1 with content. */
const WHEEL_STEP = 0.6;

const LABEL_STYLE = { fill: 0xc8d0dc, fontSize: 10, fontFamily: "sans-serif" } as const;

/** Bytes per texel of the RT backing store. All channels are `rgba8unorm`
 *  (8-bit RGBA — depth packs its sort-Y into the same 4 bytes), so this is a flat
 *  4; revisit if a float/half channel is ever added. */
const BYTES_PER_TEXEL = 4;

/** GPU bytes of a render texture's backing store: its device-pixel dimensions
 *  (`pixelWidth/Height` already fold in the resolution / DPR) × bytes-per-texel. */
function rtBytes(tex: RenderTexture): number {
  return tex.source.pixelWidth * tex.source.pixelHeight * BYTES_PER_TEXEL;
}

/** Compact byte size — whole MiB once it's big, one decimal in the 1–10 MiB band,
 *  KiB below that. */
function fmtBytes(b: number): string {
  const mib = b / (1024 * 1024);
  if (mib >= 10) return `${Math.round(mib)} MiB`;
  if (mib >= 1) return `${mib.toFixed(1)} MiB`;
  return `${Math.round(b / 1024)} KiB`;
}

interface RtTile {
  /** Background + border of the image area. */
  box: Graphics;
  /** Live preview of the channel's render texture (hidden when null). */
  sprite: Sprite;
  label: Text;
}

/**
 * Dev panel showing miniature live previews of a viewport's render textures
 * (albedo + the planned normal/depth/lit/emissive G-buffers). Opened by the
 * `/showRT` chat command against the active viewport; one panel per viewport.
 *
 * Layout: two tiles per row, each image area the SAME aspect ratio as the source
 * viewport (height derived from the column width). The grid overflows the body
 * vertically, so a scrollbar (mouse-wheel over the body, or drag the thumb) pans
 * the content; the body mask clips it.
 *
 * Each channel is a `Sprite` pointing straight at the source `RenderTexture`, so
 * the preview updates for free as the renderer re-renders that RT each frame — no
 * pixel readback. {@link tick} re-lays-out ONLY when a texture reference moved (a
 * resize swapped the RT), the aspect changed, or a dormant channel came online; a
 * steady state is a no-op.
 *
 * Scrolling is driven by `window` wheel/pointer listeners gated to the body rect —
 * the Pixi body is `pointer-events: none`, so DOM events on it never fire.
 */
export class RtPanel extends PixiPanel {
  private readonly source: RtSource;
  /** Title without the running memory total — the total is appended each layout. */
  private readonly baseLabel: string;
  /** Scrolls vertically; holds the tiles. */
  private readonly root = new Container();
  /** Fixed (non-scrolling) scrollbar track + thumb, drawn over the content. */
  private readonly scrollbar = new Graphics();
  private readonly tiles = new Map<string, RtTile>();

  /** Texture identities applied last layout — relayout only fires when one moves. */
  private applied: (RenderTexture | null)[] = [];
  private appliedW = -1;
  private appliedH = -1;
  private appliedAspect = -1;

  /** Scroll state (content-local px). `scrollY` ∈ [0, maxScroll]. */
  private scrollY = 0;
  private maxScroll = 0;
  private bodyW = 0;
  private bodyH = 0;
  /** Thumb rect in content-local px (for hit-testing a drag). */
  private thumb = { x: 0, y: 0, w: 0, h: 0 };
  /** Active thumb drag, or null. `clientY` + `scrollY` captured at grab. */
  private drag: { clientY: number; scrollY: number } | null = null;

  constructor(opts: {
    parent: LayoutNode;
    /** Title-bar label (e.g. `"RT · World"`). */
    label: string;
    storageKey: string;
    source: RtSource;
    taskbar?: PanelTaskbar;
    uiEditMode?: UiEditMode;
  }) {
    super({
      parent: opts.parent,
      title: opts.label,
      storageKey: opts.storageKey,
      defaultRect: { right: "0", top: "32px", width: "320px", height: "440px" },
      minWidth: 160,
      minHeight: 140,
      taskbar: opts.taskbar,
      closable: true,
      uiEditMode: opts.uiEditMode,
    });
    this.source = opts.source;
    this.baseLabel = opts.label;
    // contentBg is at index 0; tiles scroll, scrollbar stays fixed above them.
    this.content.container.addChild(this.root);
    this.content.container.addChild(this.scrollbar);
    this.onRectChange(() => this.relayout());

    // Pixi body is pointer-events:none, so scroll input rides window listeners
    // gated to the body rect. preventDefault only when we actually consume it.
    window.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
  }

  /** Driven by the scene each frame. Cheap unless a texture reference moved, the
   *  aspect changed, or the panel was resized. */
  tick(): void {
    if (!this.isOpen || this.isMinimized) return;
    const view = this.source();
    const channels = view.channels;
    const w = this.content.width;
    const h = this.content.height;
    let dirty =
      w !== this.appliedW ||
      h !== this.appliedH ||
      view.aspect !== this.appliedAspect ||
      channels.length !== this.applied.length;
    if (!dirty) {
      for (let i = 0; i < channels.length; i++) {
        if (channels[i].texture !== this.applied[i]) { dirty = true; break; }
      }
    }
    if (dirty) this.relayout(view);
  }

  private relayout(view: RtView = this.source()): void {
    const channels = view.channels;
    const w = this.content.width;
    const h = this.content.height;
    this.appliedW = w;
    this.appliedH = h;
    this.appliedAspect = view.aspect;
    this.applied = channels.map((c) => c.texture);
    this.bodyW = w;
    this.bodyH = h;
    if (w <= 0 || h <= 0 || channels.length === 0) {
      this.maxScroll = 0;
      this.scrollbar.clear();
      return;
    }

    const aspect = view.aspect > 0 ? view.aspect : 1;
    const availW = w - GUTTER;
    const cellW = (availW - GAP * (COLS + 1)) / COLS;
    // Height derived from the width to match the viewport's aspect ratio.
    const imgH = cellW / aspect;
    const tileH = LABEL_H + imgH;
    const rows = Math.ceil(channels.length / COLS);

    const seen = new Set<string>();
    let totalBytes = 0;
    channels.forEach((ch, i) => {
      seen.add(ch.name);
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = GAP + col * (cellW + GAP);
      const y = GAP + row * (tileH + GAP);
      const t = this.ensureTile(ch.name);

      t.label.position.set(x, y);
      const ix = x;
      const iy = y + LABEL_H;
      t.box.clear()
        .rect(ix, iy, cellW, imgH)
        .fill({ color: 0x05070a, alpha: 1 })
        .stroke({ color: 0x2a3340, width: 1 });

      const tex = ch.texture && !ch.texture.destroyed ? ch.texture : null;
      if (tex && tex.width > 0 && tex.height > 0) {
        if (t.sprite.texture !== tex) t.sprite.texture = tex;
        t.sprite.visible = true;
        // contain-fit (tex aspect already matches, this just guards rounding).
        const scale = Math.min(cellW / tex.width, imgH / tex.height);
        t.sprite.scale.set(scale);
        t.sprite.position.set(
          ix + (cellW - tex.width * scale) / 2,
          iy + (imgH - tex.height * scale) / 2,
        );
        const bytes = rtBytes(tex);
        totalBytes += bytes;
        // Logical dims rounded (a fractional rect grid can leave sub-px sizes);
        // the memory is the device-pixel backing store, so it folds in DPR.
        t.label.text = `${ch.name}  ${Math.round(tex.width)}×${Math.round(tex.height)}  ${fmtBytes(bytes)}`;
      } else {
        t.sprite.visible = false;
        t.label.text = `${ch.name}  —`;
      }
    });

    for (const [name, t] of this.tiles) {
      if (seen.has(name)) continue;
      t.box.destroy();
      t.sprite.destroy();
      t.label.destroy();
      this.tiles.delete(name);
    }

    // Running GPU cost of the live channels in the title bar.
    this.setTitle(totalBytes > 0 ? `${this.baseLabel}  ·  ${fmtBytes(totalBytes)}` : this.baseLabel);

    const contentH = GAP + rows * (tileH + GAP);
    this.maxScroll = Math.max(0, contentH - h);
    this.applyScroll();
  }

  private ensureTile(name: string): RtTile {
    let t = this.tiles.get(name);
    if (t) return t;
    const box = new Graphics();
    const sprite = new Sprite();
    const label = new Text({ text: name, style: { ...LABEL_STYLE } });
    // box (backdrop) under sprite under label.
    this.root.addChild(box, sprite, label);
    t = { box, sprite, label };
    this.tiles.set(name, t);
    return t;
  }

  /** Apply the current scroll offset to the tile container + redraw the scrollbar
   *  thumb. Cheap — no tile geometry recompute. */
  private applyScroll(): void {
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll));
    this.root.y = -this.scrollY;
    this.scrollbar.clear();
    if (this.maxScroll <= 0) { this.thumb = { x: 0, y: 0, w: 0, h: 0 }; return; }
    const trackX = this.bodyW - SCROLLBAR_W - 2;
    const thumbH = Math.max(24, this.bodyH * (this.bodyH / (this.bodyH + this.maxScroll)));
    const thumbY = (this.scrollY / this.maxScroll) * (this.bodyH - thumbH);
    this.thumb = { x: trackX, y: thumbY, w: SCROLLBAR_W, h: thumbH };
    this.scrollbar
      .rect(trackX, 0, SCROLLBAR_W, this.bodyH)
      .fill({ color: 0x0e1318, alpha: 0.6 })
      .roundRect(trackX, thumbY, SCROLLBAR_W, thumbH, 3)
      .fill({ color: 0x55617a, alpha: 0.95 });
  }

  /** True when the viewport-pixel point is inside this panel's body rect. */
  private inBody(clientX: number, clientY: number): boolean {
    if (!this.isOpen || this.isMinimized) return false;
    const r = this.bodyRect;
    return clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom;
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (this.maxScroll <= 0 || !this.inBody(e.clientX, e.clientY)) return;
    this.scrollY += e.deltaY * WHEEL_STEP;
    this.applyScroll();
    e.preventDefault();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.maxScroll <= 0 || !this.inBody(e.clientX, e.clientY)) return;
    const r = this.bodyRect;
    const lx = e.clientX - r.left;
    const ly = e.clientY - r.top;
    if (lx >= this.thumb.x && lx < this.thumb.x + this.thumb.w &&
        ly >= this.thumb.y && ly < this.thumb.y + this.thumb.h) {
      this.drag = { clientY: e.clientY, scrollY: this.scrollY };
      e.preventDefault();
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    const range = this.bodyH - this.thumb.h;
    const dy = e.clientY - this.drag.clientY;
    // Thumb travel : content travel = range : maxScroll.
    this.scrollY = this.drag.scrollY + (range > 0 ? (dy / range) * this.maxScroll : 0);
    this.applyScroll();
    e.preventDefault();
  };

  private readonly onPointerUp = (): void => {
    this.drag = null;
  };

  override destroy(): void {
    window.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    for (const t of this.tiles.values()) {
      t.box.destroy();
      t.sprite.destroy();
      t.label.destroy();
    }
    this.tiles.clear();
    this.scrollbar.destroy();
    this.root.destroy();
    super.destroy();
  }
}
