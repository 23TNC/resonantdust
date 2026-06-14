import { Scene } from "../Scene";
import type { GameContext } from "../../GameContext";
import { LayoutNode } from "../../game/layout/LayoutNode";
import type { DomZBand, DomPanelRect } from "../../ui/dom/DomPanel";
import { PanelManager } from "../../ui/panels/PanelManager";
import { LayoutManager } from "../../game/layout/LayoutManager";
import { InputManager } from "../../game/input/InputManager";
import { ViewportPanel } from "../../game/viewport/ViewportPanel";
import { cellHash } from "../../game/viewport/WorldRenderer";
import { ZONE_SIZE, TILE_CENTER, REGION_SIZE, REGION_CENTER } from "../../server/data/packing";
import { CardDragController } from "../../game/viewport/CardDragController";
import { PixiPanel } from "../../ui/dom/PixiPanel";
import { WORLD_LAYER, INVENTORY_LAYER } from "../../server/data/packing";
import { DetailsPanel } from "../../game/panels/details/DetailsPanel";
import { ChatPanel } from "../../game/panels/chat/ChatPanel";
import { LogManager } from "../../game/panels/chat/LogManager";
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

/** Parse a card-id token from a chat command. Convention: a leading `#` means
 *  HEX (so the details panel's `#<hex>` display copies straight into a command),
 *  bare digits mean DECIMAL. `null` on a malformed token. */
function parseCommandId(token: string): number | null {
  if (token.startsWith("#")) {
    const hex = token.slice(1);
    return /^[0-9a-fA-F]+$/.test(hex) ? parseInt(hex, 16) : null;
  }
  return /^\d+$/.test(token) ? parseInt(token, 10) : null;
}

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
  /** World chat — a taskbar-pinned DOM panel (general feed + client-only logs
   *  tab + send input). Server messages stream through `ctx.client.onChat`. */
  private chat!: ChatPanel;
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
    // Client-only flavor-text feed backing the chat panel's "logs" tab. Created
    // before ChatPanel so its constructor can subscribe; game systems push to it.
    ctx.logs = new LogManager();

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
    // player's). The card_id lands a pump or two after login via the discovery
    // walk, so the login reply often carries -1; open it whenever it resolves
    // (and now, if it already has). `openInventory` is idempotent — a repeat for
    // the same id just focuses the existing panel. The soul is never rendered,
    // so this event is the player's only way back to their own inventory.
    const openOwnInventory = (soulId: number): void => {
      if (soulId >= 0) this.openInventory(soulId, "My Inventory");
    };
    openOwnInventory(ctx.client.playerSoulId);
    this.unsubs.push(ctx.client.onPlayerSoul(openOwnInventory));

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

    // ── Chat panel ────────────────────────────────────────────────────
    // Taskbar-pinned DOM panel. The worker subscribed the `chat_messages` feed
    // on login; this panel renders the stream (`ctx.client.onChat`) and sends
    // via `ctx.client.sendChat`. Pinned so it persists minimized in the taskbar.
    this.chat = new ChatPanel(ctx);
    // `/edit` — open the card editor against the selected card. The handler
    // reads `this.cardEditor` at call time (it loads async, Developer-only), so
    // it copes with "not a dev" / "still loading" gracefully.
    this.chat.registerCommand("edit", () => this.editSelectedCard());
    // `/give <ownerId> <def> [zoneId] [surface] [q] [r]` — create a card. Card-id
    // args are HEX (matching the details panel's `#<hex>` display); coords are
    // decimal. See `giveCommand`.
    this.chat.registerCommand("give", (args) => this.giveCommand(args));
    this.chat.open();

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
      for (const v of this.viewports()) { v.selectCard(null); v.selectTile(null); }
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
      // No card under the click — fall through to the underlying TILE: select it
      // (so `/edit` can target it) and show its details. The tile is a packed def
      // + per-slot stock, like a card. Selection is single across all viewports,
      // so clear tiles on the others (cards already cleared by the loop above).
      const tile = vp.tileAt(x, y);
      for (const v of this.viewports()) v.selectTile(v === vp && tile ? { q: tile.q, r: tile.r } : null);
      if (tile) {
        const tileLoc = { surface: vp.surfaceBand, q: tile.q, r: tile.r };
        this.details.showByPackedDefinition(tile.packed, this.ctx, [tile.stock0, tile.stock1], tileLoc);
      } else {
        this.details.hide();
      }
      return;
    }
    // A card was selected — clear any tile selection (card OR tile, not both).
    for (const v of this.viewports()) v.selectTile(null);

    const info = vp.cardInfo(id);
    if (info === null) { this.details.hide(); return; }
    // Every surface carries a meaningful cell — world hex or inventory slot.
    const cardLoc = { surface: vp.surfaceBand, q: info.q, r: info.r };
    this.details.showByPackedDefinition(info.packed, this.ctx, undefined, cardLoc, id);

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
      // `#<hex>` to match the card-id convention everywhere else (details panel,
      // /give, editor feedback) — so e.g. owner 1025 reads as `#401`.
      title: title ?? `Inventory #${ownerId.toString(16)}`,
      storageKey: `inventory:${INVENTORY_LAYER}:${ownerId}`,
      // Per-id storageKey (each soul's inventory remembers its own position) but
      // a SHARED, id-independent defaultsKey — card ids renumber freely
      // pre-release, so a default keyed by id would orphan on every renumber.
      // All inventories share one shipped default (they share `INVENTORY_RECT`).
      defaultsKey: "inventory",
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

  /** The card currently selected in any viewport (selection is at most one card
   *  across all viewports — clicking elsewhere clears the others). Null when
   *  nothing is selected or the selected card has no resolvable info. */
  private selectedCardInfo(): { id: number; packed: number } | null {
    for (const vp of this.viewports()) {
      const id = vp.selectedCard();
      if (id === null) continue;
      const info = vp.cardInfo(id);
      if (info) return { id, packed: info.packed };
    }
    return null;
  }

  /** The world tile currently selected in any viewport (at most one across all,
   *  mutually exclusive with a card selection). Null when none is selected. */
  private selectedTileInfo(): { packed: number; q: number; r: number; stock0: number; stock1: number } | null {
    for (const vp of this.viewports()) {
      const t = vp.selectedTileInfo();
      if (t) return t;
    }
    return null;
  }

  /** `/edit` chat command — open the card editor against the selected card OR
   *  the selected world tile. A tile has no card row, so it's edited by
   *  synthesising its appearance from its stock (the editor still edits the
   *  tile's packed DEFINITION). Returns a feedback line for the chat feed. The
   *  editor is Developer-only and lazily imported, so this handles "not a dev"
   *  and "still loading" cleanly. */
  private editSelectedCard(): string {
    if (!this.ctx.client.isDeveloper) return "The card editor is developer-only.";
    const card = this.selectedCardInfo();
    const tile = card ? null : this.selectedTileInfo();
    if (!card && !tile) return "Nothing selected — click a card or tile first, then /edit.";
    if (!this.cardEditor) return "Card editor still loading — try /edit again in a moment.";
    if (card) {
      this.cardEditor.editCard(card.id, card.packed);
      return `Editing card #${card.id.toString(16)}.`;
    }
    this.cardEditor.editTile(tile!.packed, tile!.stock0, tile!.stock1, cellHash(tile!.q, tile!.r));
    return `Editing tile (${tile!.q}, ${tile!.r}).`;
  }

  /** `/give <ownerId> <def> [zoneId] [surface] [q] [r]` — create a card via the
   *  core's `create_card` path. Card-id args (owner, zoneId) take a `#<hex>` (copy
   *  the details panel) or a bare-decimal id; `surface` is a name
   *  (`inventory`/`world`) or a decimal band; q/r are decimal world coords.
   *  Defaults: zoneId=owner, surface=inventory, q=r=0 → the shard auto-places into
   *  the owner's inventory (first free cell). Developer-only. Returns a feedback
   *  line for the chat feed. NOTE: placement spreads only as far as the owner's
   *  `inventory` aspect allows (`distance = inventory − 1`); a `player_soul`
   *  (`inventory 1`) is a single tile, so repeated gives land on the same cell. */
  private giveCommand(args: string[]): string {
    if (!this.ctx.client.isDeveloper) return "/give is developer-only.";
    if (args.length < 2) {
      return "Usage: /give <ownerId> <definition> [zoneId] [surface] [q] [r]  (ids: #hex or decimal)";
    }

    const owner = parseCommandId(args[0]);
    if (owner === null) return `Bad owner id "${args[0]}" — #hex or decimal.`;
    const cardKey = args[1];
    const zoneId = args[2] === undefined ? owner : parseCommandId(args[2]);
    if (zoneId === null) return `Bad zone id "${args[2]}" — #hex or decimal.`;

    // Surface: a known name → its band, else a decimal band (for my sanity).
    const surfaceArg = (args[3] ?? "inventory").toLowerCase();
    const SURFACES: Record<string, number> = { inventory: INVENTORY_LAYER, world: WORLD_LAYER };
    let surface = SURFACES[surfaceArg];
    if (surface === undefined) {
      if (!/^\d+$/.test(surfaceArg)) return `Bad surface "${args[3]}" — inventory | world | 0-255.`;
      surface = parseInt(surfaceArg, 10);
    }
    if (surface > 255) return `Bad surface ${surface} — must be 0-255.`;

    const coord = (s: string | undefined): number | null =>
      s === undefined ? 0 : /^-?\d+$/.test(s) ? parseInt(s, 10) : null;
    const worldQ = coord(args[4]);
    const worldR = coord(args[5]);
    if (worldQ === null || worldR === null) return `Bad coords "${args[4]} ${args[5]}" — decimal ints.`;

    this.ctx.client.give(owner, cardKey, zoneId, surface, worldQ, worldR);
    const surfLabel = SURFACES[surfaceArg] !== undefined ? surfaceArg : `surface ${surface}`;
    const zoneNote = zoneId !== owner ? ` in #${zoneId.toString(16)}'s zone` : "";
    const at = worldQ || worldR ? ` @ (${worldQ}, ${worldR})` : "";
    return `Gave "${cardKey}" to #${owner.toString(16)} (${surfLabel})${zoneNote}${at}.`;
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
    this.updateCursorReadout();
    // Size the details panel to the host body width × its natural height so
    // its fixed-layout draw lands within the panel rect.
    if (this.details.isVisible) {
      this.details.setBounds(0, 0, this.detailsHost.content.width, this.details.currentHeight);
    }
    this.rootNode.layoutIfDirty();
  }

  /** Push the live tile / macro_zone / region under the cursor to the debug HUD.
   *  Uses the canonical codec formula (centre-at-(0,0), 7×7 zones & regions) so
   *  the readout is the REFERENCE to compare against where tiles actually load. */
  private updateCursorReadout(): void {
    const dp = this.ctx.debugPanel;
    if (!dp?.isOpen) return;
    const vp = this.viewports()[0];
    if (!vp) return;
    const p = this.input.lastPointer;
    const tile = vp.cellAt(p.x, p.y); // global (world) tile
    // Local cell inside the macro_zone (0..6; owner-origin at 3,3). `rem_euclid`
    // via ((n % m) + m) % m so negatives wrap correctly.
    const lq = (((tile.q + TILE_CENTER) % ZONE_SIZE) + ZONE_SIZE) % ZONE_SIZE;
    const lr = (((tile.r + TILE_CENTER) % ZONE_SIZE) + ZONE_SIZE) % ZONE_SIZE;
    const zq = Math.floor((tile.q + TILE_CENTER) / ZONE_SIZE);
    const zr = Math.floor((tile.r + TILE_CENTER) / ZONE_SIZE);
    const rq = Math.floor((zq + REGION_CENTER) / REGION_SIZE);
    const rr = Math.floor((zr + REGION_CENTER) / REGION_SIZE);
    dp.setCursorCoords({ q: lq, r: lr }, tile, { q: zq, r: zr }, { q: rq, r: rr });
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
    this.chat.destroy();
    this.world.destroy();
    this.ctx.logs?.dispose();
    this.ctx.layout?.dispose();
    this.ctx.panels?.closeAll();
    this.rootNode.destroy();
    this.ctx.input = null;
    this.ctx.panels = null;
    this.ctx.layout = null;
    this.ctx.logs = null;
  }
}
