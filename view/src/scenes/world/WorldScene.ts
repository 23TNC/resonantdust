import { Scene } from "../Scene";
import type { GameContext } from "../../GameContext";
import { LayoutNode } from "../../game/layout/LayoutNode";
import type { DomZBand, DomPanelRect } from "../../ui/dom/DomPanel";
import { PanelManager } from "../../ui/panels/PanelManager";
import { LayoutManager } from "../../game/layout/LayoutManager";
import { InputManager } from "../../game/input/InputManager";
import { ViewportPanel } from "../../game/viewport/ViewportPanel";
import { CardDragController } from "../../game/viewport/CardDragController";
import { PixiPanel } from "../../ui/dom/PixiPanel";
import { WORLD_LAYER, INVENTORY_LAYER } from "../../server/data/packing";
import { DetailsPanel } from "../../game/panels/details/DetailsPanel";
import { panelTitle } from "../../game/panels/panelStrings";

/** A full-screen, transform-free layer that panels parent into. PixiPanel
 *  duck-reads `band` to derive its DOM z-band; `gameview` sits below inventory /
 *  overlay.
 *
 *  A layer is **hit-transparent**: it never claims a hit for itself, only for
 *  its panels. With several full-window layers stacked, the topmost would
 *  otherwise (per `LayoutNode.hitTestLayout`'s "no child hit → return self")
 *  swallow every click and shadow the layers beneath — so a miss on this layer's
 *  panels falls through to the next layer down (and ultimately the world). */
class LayerNode extends LayoutNode {
  constructor(readonly band: DomZBand) {
    super();
  }

  override hitTestLayout(parentX: number, parentY: number): LayoutNode | null {
    const hit = super.hitTestLayout(parentX, parentY);
    return hit === this ? null : hit;
  }
}

/** Old pixijs inventory-panel rect: right edge, under the top taskbar, 440px. */
const INVENTORY_RECT: DomPanelRect = { right: "0", top: "32px", width: "440px", height: "calc(100vh - 64px)" };

/**
 * The world scene — the post-login game surface. Installs the per-scene
 * `PanelManager`, `LayoutManager`, and `InputManager`, lays down the stacked
 * world / inventory / overlay layers, and opens the world {@link ViewportPanel}.
 * Drag to pan; Space recenters.
 *
 * Clicking a card SELECTS it; if the card carries the `inventory` aspect (a soul),
 * its inventory opens as a separate viewport pinned bottom-right — one per soul,
 * each its own taskbar tab — so alice/bob's inventories open independently.
 */
export class WorldScene extends Scene {
  private ctx!: GameContext;
  private rootNode!: LayoutNode;
  /** Stacked panel layers, bottom→top: world-surface viewports, then inventory
   *  viewports, then an overlay layer (the details panel). Their `band` drives
   *  the DOM chrome z-index and their order in `rootNode` drives Pixi draw order,
   *  so an inventory always covers the world and the details panel covers both.
   *  The app-global title-bar tools (settings / panel-settings / debug) live in
   *  the still-higher "dom" band, so they always sit on top of all three. */
  private worldLayer!: LayerNode;
  private inventoryLayer!: LayerNode;
  private overlayLayer!: LayerNode;
  private world!: ViewportPanel;
  private input!: InputManager;
  private cardDrag!: CardDragController;
  /** Card details — a Pixi `DetailsPanel` hosted in an auto-height `PixiPanel`
   *  that opens / resizes in lockstep with the panel's visibility. World-scoped
   *  because it surfaces the selected card (the title-bar tools — settings /
   *  debug / the per-panel settings popup — are app-global, built at boot). */
  private details!: DetailsPanel;
  private detailsHost!: PixiPanel;
  /** Open inventory viewports, keyed by their owning soul card_id. */
  private readonly inventories = new Map<number, ViewportPanel>();
  /** Developer card editor — owns the right-click menu + editor panel. Lazily
   *  imported behind `isDeveloper` so the editor code never ships in a normal
   *  player's bundle (type-only `import(...)` here is erased at compile time). */
  private cardEditor?: import("../../editor/CardEditor").CardEditor;
  /** Set on `onExit` so the async editor import can't construct after teardown. */
  private disposed = false;
  private readonly unsubs: Array<() => void> = [];

  onEnter(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.panels = new PanelManager();
    ctx.layout = new LayoutManager();

    this.rootNode = new LayoutNode();
    this.rootNode.setContext(ctx);
    this.root.addChild(this.rootNode.container);

    // Bottom→top layers (Pixi draw order = child order; DOM z = band).
    this.worldLayer = new LayerNode("gameview");
    this.inventoryLayer = new LayerNode("inventory");
    this.overlayLayer = new LayerNode("overlay");
    this.rootNode.addChild(this.worldLayer);
    this.rootNode.addChild(this.inventoryLayer);
    this.rootNode.addChild(this.overlayLayer);

    // Input layer: hit-tests the layout tree on press, drives pan + click-select.
    this.input = new InputManager(ctx.app.canvas, this.rootNode);
    ctx.input = this.input;
    this.sizeRoot();

    this.world = new ViewportPanel({
      parent: this.worldLayer,
      ctx,
      surface: WORLD_LAYER,
      owner: 0,
      anchor: { q: 0, r: 0 },
      taskbar: ctx.taskbar,
      uiEditMode: ctx.uiEditMode,
      storageKey: "worldViewport",
    });
    ctx.panels.registerNode(this.world.content, this.world);
    this.world.open();

    // The logged-in player's own inventory — the `player_soul` card's inventory
    // surface (the soul lives on surface 0, never rendered; its inventory IS the
    // player's). The client core surfaces its card_id from the discovery walk.
    if (ctx.client.playerSoulId >= 0) {
      this.openInventory(ctx.client.playerSoulId, "My Inventory");
    }

    // ── Details panel ─────────────────────────────────────────────────
    // The Pixi `DetailsPanel` lives inside an auto-height host panel; it
    // stays closed until a card is selected, then opens / resizes to wrap
    // the content (driven by the panel's visibility + size listeners).
    this.detailsHost = new PixiPanel({
      parent: this.overlayLayer,
      title: panelTitle("gameDetailsPanel"),
      storageKey: "gameDetailsPanel",
      taskbar: ctx.taskbar,
      uiEditMode: ctx.uiEditMode,
    });
    this.details = new DetailsPanel();
    this.detailsHost.content.addChild(this.details);
    ctx.panels.registerNode(this.detailsHost.content, this.detailsHost);
    this.unsubs.push(this.details.onVisibilityChange((visible) => {
      if (visible) this.detailsHost.open(); else this.detailsHost.close();
    }));
    this.unsubs.push(this.details.onSizeChange((h) => {
      this.detailsHost.setContentNaturalHeight(h > 0 ? h : null);
    }));

    // Card drag-and-drop across viewports (ghost floats in the overlay; drop →
    // wasm place → the card tweens to its data position). Pan is suppressed when
    // a press lands on a card (both gate on `cardAt`).
    this.cardDrag = new CardDragController(
      ctx,
      this.input,
      () => this.viewports(),
      this.overlayLayer.container,
    );

    // Click → select the card under the cursor in the hit viewport; open its
    // inventory if it has one.
    this.unsubs.push(this.input.on("left_click", (d) => this.onClick(d.up.x, d.up.y, d.up.hit)));
    // Card editor (Developer-only): right-click menu + editor panel, all owned by
    // the `CardEditor` controller in `src/editor/`. Lazily imported so none of
    // the editor code ships in a normal player's bundle — Vite splits it into its
    // own chunk that loads only when a Developer logs in.
    if (ctx.client.isDeveloper) {
      void import("../../editor/CardEditor").then(({ CardEditor }) => {
        if (this.disposed) return; // scene exited before the chunk resolved
        this.cardEditor = new CardEditor({
          ctx,
          input: this.input,
          parent: this.overlayLayer,
          viewports: () => this.viewports(),
          details: this.details,
        });
      });
    }
    // Space recenters the world on the origin.
    this.unsubs.push(this.input.onKey("key_down", (k) => {
      if (k.code === "Space") this.world.recenter(0, 0);
    }));

    if (import.meta.env.DEV) {
      (globalThis as unknown as { __view?: ViewportPanel }).__view = this.world;
    }
  }

  // ── click → select → open inventory / details ───────────────────────
  private onClick(x: number, y: number, hit: LayoutNode | null): void {
    // The details panel's expand toggle consumes the click before any
    // viewport routing — it sits in the overlay layer above the viewports.
    if (this.details.handleClick(hit)) return;

    const vp = this.viewports().find((v) => v.ownsHit(hit));
    // Clicking a non-world surface (chrome / empty) clears selection + details.
    if (!vp) {
      for (const v of this.viewports()) v.selectCard(null);
      this.details.hide();
      return;
    }
    // Refocus the clicked viewport to the top of its band (its content clicks
    // fall through to Pixi, so the DOM pointerdown→bringToFront never fires —
    // do it explicitly here so the last-touched viewport z-sorts above peers).
    vp.focus();
    const id = vp.cardAt(x, y);
    for (const v of this.viewports()) v.selectCard(v === vp ? id : null);
    if (id === null) {
      // No card under the click — fall through to the underlying TILE and show
      // its details (the tile is a packed def + per-slot stock, like a card).
      const tile = vp.tileAt(x, y);
      if (tile) {
        const tileLoc = { surface: vp.surfaceBand, q: tile.q, r: tile.r };
        this.details.showByPackedDefinition(tile.packed, this.ctx, [tile.stock0, tile.stock1], tileLoc);
      } else {
        this.details.hide();
      }
      return;
    }

    const info = vp.cardInfo(id);
    if (info === null) { this.details.hide(); return; }
    // Every surface carries a meaningful cell — world hex or inventory slot.
    const cardLoc = { surface: vp.surfaceBand, q: info.q, r: info.r };
    this.details.showByPackedDefinition(info.packed, this.ctx, undefined, cardLoc);

    // The `inventory` aspect → this card (a soul) has an inventory surface.
    if (this.ctx.definitions.aspectValue(info.packed, "inventory") !== null) {
      this.openInventory(id);
    }
  }

  /** Open (or focus) the inventory viewport for soul `ownerId` — its own panel,
   *  pinned bottom-right with its own taskbar tab. `title` overrides the default
   *  (used for the logged-in player's own inventory). */
  private openInventory(ownerId: number, title?: string): void {
    const existing = this.inventories.get(ownerId);
    if (existing) {
      existing.open();
      existing.focus();
      return;
    }
    const panel = new ViewportPanel({
      parent: this.inventoryLayer,
      ctx: this.ctx,
      surface: INVENTORY_LAYER,
      owner: ownerId,
      // Centre on the owner-origin tile (0,0) — the home the gate's region disk
      // (`Region.distance`) is centred on, so the inventory reads centred.
      anchor: { q: 0, r: 0 },
      title: title ?? `Inventory #${ownerId}`,
      storageKey: `inventory:${INVENTORY_LAYER}:${ownerId}`,
      defaultRect: INVENTORY_RECT,
      taskbar: this.ctx.taskbar,
      pin: "bottom-right",
      pinned: true,
      closable: true,
      uiEditMode: this.ctx.uiEditMode,
    });
    this.ctx.panels?.registerNode(panel.content, panel);
    panel.open();
    this.inventories.set(ownerId, panel);
    panel.onDestroy(() => this.inventories.delete(ownerId));
  }

  private viewports(): ViewportPanel[] {
    return [this.world, ...this.inventories.values()];
  }

  onResize(_width: number, _height: number): void {
    this.sizeRoot();
  }

  /** Full-window bounds on the layout root + every layer so the input manager's
   *  hit-test descends into the panels (which sit at their DOM rects within). */
  private sizeRoot(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.rootNode.setBounds(0, 0, w, h);
    this.worldLayer.setBounds(0, 0, w, h);
    this.inventoryLayer.setBounds(0, 0, w, h);
    this.overlayLayer.setBounds(0, 0, w, h);
  }

  update(_deltaMS: number): void {
    for (const v of this.viewports()) v.tick();
    this.cardDrag.update(); // glide the drag ghost toward the cursor
    // Size the details panel to the host body width × its natural height so
    // its fixed-layout draw lands within the panel rect.
    if (this.details.isVisible) {
      this.details.setBounds(0, 0, this.detailsHost.content.width, this.details.currentHeight);
    }
    this.rootNode.layoutIfDirty();
  }

  onExit(): void {
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.cardEditor?.dispose();
    this.cardDrag.dispose();
    this.input.dispose();
    for (const inv of this.inventories.values()) inv.destroy();
    this.inventories.clear();
    this.detailsHost.destroy();
    this.world.destroy();
    this.ctx.layout?.dispose();
    this.ctx.panels?.closeAll();
    this.rootNode.destroy();
    this.ctx.input = null;
    this.ctx.panels = null;
    this.ctx.layout = null;
  }
}
