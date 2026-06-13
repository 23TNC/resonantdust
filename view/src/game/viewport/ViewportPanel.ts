import type { GameContext } from "../../GameContext";
import type { LayoutNode } from "../layout/LayoutNode";
import type { PanelTaskbar } from "../../ui/dom/PanelTaskbar";
import type { UiEditMode } from "../../ui/dom/UiEditMode";
import type { DomPanelRect, PinMode } from "../../ui/dom/DomPanel";
import { PixiPanel } from "../../ui/dom/PixiPanel";
import { WorldRenderer } from "./WorldRenderer";
import { PanController } from "./PanController";

/** Old pixijs world-viewport rect: left edge, under the top taskbar, ~800px. */
const WORLD_RECT: DomPanelRect = { left: "0", top: "32px", width: "800px", height: "calc(100vh - 64px)" };

export interface ViewportPanelOptions {
  /** Layout-tree layer the panel chrome + content attach to (a `gameview` band
   *  LayerNode). */
  parent: LayoutNode;
  ctx: GameContext;
  /** Surface band this viewport shows (`WORLD_LAYER`, `INVENTORY_LAYER`, …). */
  surface: number;
  /** Owning card_id — `0` for the world, the soul card_id for an inventory. */
  owner?: number;
  /** Initial cell the viewport centres on. */
  anchor: { q: number; r: number };
  taskbar?: PanelTaskbar;
  uiEditMode?: UiEditMode;
  title?: string;
  storageKey?: string;
  /** Content-defaults lookup key, decoupled from `storageKey`. Inventories set
   *  this to a stable string (e.g. `"inventory"`) so a shipped default survives
   *  `card_id` renumbers — the per-id `storageKey` still owns localStorage
   *  position memory, but the default fallback is shared + id-independent. */
  defaultsKey?: string;
  /** Panel rect; defaults to the world viewport size. */
  defaultRect?: DomPanelRect;
  /** Taskbar pin (e.g. `"bottom-right"` for inventories). */
  pin?: PinMode;
  closable?: boolean;
  pinned?: boolean;
}

/**
 * A viewport IS a panel — a `PixiPanel` whose body hosts a {@link WorldRenderer}.
 * The panel owns the chrome (title bar, drag, resize, mask) and forwards its body
 * rect to the renderer; the renderer is the dumb display (anchor + region → draw).
 * The viewport doesn't know game rules — it asks the client what's in view and
 * draws it. Multiple viewports can coexist, each on its own `(q, r, surface)`.
 */
export class ViewportPanel extends PixiPanel {
  private readonly world: WorldRenderer;
  /** Surface band this viewport shows (`WORLD_LAYER` / `INVENTORY_LAYER`). */
  readonly surfaceBand: number;
  /** Owning card_id of this surface (`0` for the world; the soul for inventory). */
  readonly ownerId: number;
  private readonly unsubResize: () => void;
  /** Drag-to-pan, wired to the scene's input manager. Null if no input manager
   *  was installed (e.g. a headless / test mount). */
  private readonly pan: PanController | null;

  constructor(opts: ViewportPanelOptions) {
    super({
      parent: opts.parent,
      title: opts.title ?? "World",
      storageKey: opts.storageKey,
      defaultsKey: opts.defaultsKey,
      defaultRect: opts.defaultRect ?? WORLD_RECT,
      minWidth: 240,
      minHeight: 200,
      taskbar: opts.taskbar,
      pin: opts.pin,
      pinned: opts.pinned,
      closable: opts.closable,
      uiEditMode: opts.uiEditMode,
    });

    this.surfaceBand = opts.surface;
    this.ownerId = opts.owner ?? 0;
    this.world = new WorldRenderer(opts.ctx, opts.surface, opts.owner ?? 0, opts.anchor);
    this.content.addChild(this.world);
    this.sizeWorld();
    // PixiPanel sets `content` bounds first on each rect change (it subscribed in
    // its own constructor, before this one), so the world reads the fresh size.
    this.unsubResize = this.onRectChange(() => this.sizeWorld());

    // Drag-to-pan through the shared input manager (hit-gated to the world
    // surface). Installed by the world scene before this panel is built.
    this.pan = opts.ctx.input ? new PanController(opts.ctx.input, this.world) : null;
  }

  /** Fill the panel body with the world (content-local origin; the content node
   *  carries the screen offset). */
  private sizeWorld(): void {
    this.world.setBounds(0, 0, this.content.width, this.content.height);
  }

  /** Drive pan + the renderer's per-frame streaming build + prim easing. The
   *  scene calls this every frame. Pan first so the region re-aims this frame. */
  tick(): void {
    this.pan?.update();
    this.world.tick();
  }

  /** Recenter the world on a cell (programmatic; drag-pan is internal). Named to
   *  avoid clashing with `DomPanel.setAnchor` (the resize-corner preset). */
  recenter(q: number, r: number): void {
    this.world.setAnchor(q, r);
  }

  /** The card under a global (canvas-local CSS px) point, or null. */
  cardAt(globalX: number, globalY: number): number | null {
    return this.world.cardAt(globalX, globalY);
  }

  /** Highlight a card (or clear with null). */
  selectCard(id: number | null): void {
    this.world.selectCard(id);
  }

  selectedCard(): number | null {
    return this.world.selectedCard();
  }

  /** The packed definition of a known card (for an aspect lookup), or null. */
  cardPacked(id: number): number | null {
    return this.world.cardPacked(id);
  }

  /** Full display info for a known card — packed def, world hex, stock/flags —
   *  or null. Feeds the details panel. */
  cardInfo(id: number): { packed: number; q: number; r: number; stock: number; flags: number } | null {
    return this.world.cardInfo(id);
  }

  /** The tile under a point (packed def + stock + cell), or null. Feeds the
   *  details panel when a click misses every card. */
  tileAt(globalX: number, globalY: number): { packed: number; q: number; r: number; stock0: number; stock1: number } | null {
    return this.world.tileAt(globalX, globalY);
  }


  /** The cell `(q, r)` under a global point — the drop target. */
  cellAt(globalX: number, globalY: number): { q: number; r: number } {
    return this.world.cellAt(globalX, globalY);
  }

  /** Dim/undim a card while it's dragged (the source-side visual). */
  setCardDragging(id: number, on: boolean): void {
    this.world.setCardDragging(id, on);
  }

  /** Seed a dropped card to start at a global point, then tween to its cell. */
  seedDropPosition(id: number, globalX: number, globalY: number): void {
    this.world.seedDropPosition(id, globalX, globalY);
  }

  /** True if `node` (an InputManager hit) is this viewport's world surface — used
   *  by the scene to route a click to the right viewport. */
  ownsHit(node: unknown): boolean {
    return node === this.world;
  }

  override destroy(): void {
    this.unsubResize();
    this.pan?.dispose();
    // Close the feed before PixiPanel tears `content` down (which would
    // otherwise destroy the renderer's container blind).
    this.world.destroy();
    super.destroy();
  }
}
