import { Container, Graphics, Sprite, Text, Texture, type TextStyleOptions } from "pixi.js";
import type { GameContext } from "../GameContext";
import type { LayoutNode } from "../game/layout/LayoutNode";
import type { PanelTaskbar } from "../ui/dom/PanelTaskbar";
import type { UiEditMode } from "../ui/dom/UiEditMode";
import { PixiPanel } from "../ui/dom/PixiPanel";
import { ArtToolsPanel } from "./ArtToolsPanel";
import { masterVariantStem, masterChannelUrl, loadMasterTexture, type MasterChannel } from "./masterTextures";
import { type Surface, type SurfaceChannel, type Brush, surfaceTexel, outlineRect, cssColor, floodFill } from "./brush";
import { PaintHistory } from "./paintHistory";
import { type Light, composite, Bloom } from "./lighting";
import { type DslLight, syncLightRegion, buildCardSource, unflattenLocale } from "./dslEdit";
import { GenericCardFace, buildCardPrimList } from "../game/cards/generic/GenericCardFace";
import type { PrimList, VisualNode } from "../game/cards/generic/visualSpec";
import { global } from "../game/definitions/globals";
import { sharedContent, contentSources } from "../game/definitions/contentBoot";
import { debug } from "../debug";

/** Base64-encode bytes in chunks — `btoa(String.fromCharCode(...all))` overflows
 *  the call-stack for large arrays, so build the binary string a window at a time.
 *  Standard base64 (what the gate's decoder expects). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** The card def shape the content wasm returns (`cardDef(packed)` JSON) — only
 *  the fields the editor tabs read. */
interface CardDefJson {
  key: string;
  type_name: string;
  aspects: [string, number, number][];
}

export interface CardEditorPanelOptions {
  parent: LayoutNode;
  ctx: GameContext;
  taskbar: PanelTaskbar;
  uiEditMode: UiEditMode;
}

const LABEL_STYLE: TextStyleOptions = {
  fontFamily: "sans-serif",
  fontSize: 11,
  fill: 0xa0a0b0,
};

const FRAME_COLOR = 0x3a3a4a;
/** Brush footprint outline colour. */
const OUTLINE_COLOR = 0xffcc33;
// Preview lighting (CPU, texel space). Heights/radii scale with the texture's
// larger dimension; the marker is in sprite-local px (scales with zoom).
const LIGHT_AMBIENT = 0.3;
const LIGHT_Y_SIGN = -1;       // matches the deferred pass's normal convention
const LIGHT_HEIGHT = 0.5;
const LIGHT_RADIUS = 1.6;
const LIGHT_INTENSITY = 1.3;
const LIGHT_MARKER_R = 8;
const LIGHT_MARKER_COLOR = 0xffee88;
// Preview bloom (CPU, texel space — blooms ONLY the emissive contribution).
const BLOOM_THRESHOLD = 24;    // emissive luma 0–255 to bloom (skips near-black)
const BLOOM_RADIUS_FRAC = 0.03; // blur radius as a fraction of the larger dim
const BLOOM_INTENSITY = 0.9;   // add-back strength
const LABEL_H = 16;
const PAD = 12;
/** Max squares the bottom row is sized for (prim + albedo + normal + emissive +
 *  1 sprite placeholder), so the prim square's size stays stable as the
 *  selection — and the square count — changes. */
const MAX_SQUARES = 5;
/** Fraction of the big square the card is drawn at, leaving a margin so the
 *  whole card (title strip included) sits inside the frame with padding. */
const CARD_FIT = 0.84;
/** Vertical strip reserved under the square row for the edit controls. */
const CONTROLS_MIN = 150;

type SquareKind = "prim" | "albedo" | "normal" | "emissive" | "placeholder";
interface Square { kind: SquareKind; x: number; label: string }

/** Width of the right art-tools column, as a fraction of the content width,
 *  clamped to a usable range. The left tabbed section is NOT fixed — it expands
 *  to fill whatever the right-justified card leaves. */
const COL_FRAC = 0.24;
const COL_MIN = 120;
const COL_MAX = 200;
/** Minimum width the (expanding) left tabbed section keeps — caps how large the
 *  right-justified card may grow on a wide panel. */
const LEFT_MIN = 150;
/** Side of the square top-right buttons (undo / redo / save). */
const SAVE_BTN = 34;
/** Gap between the top-right buttons. */
const BTN_GAP = 4;
/** Max undo/redo strokes held (each is a full-size layer — keep modest for
 *  large masters; overflow bakes into the channel backing). */
const UNDO_LIMIT = 16;

/** Computed geometry for one relayout pass — content-local px. */
interface Geom {
  bigX: number; bigY: number; bigSide: number;
  rowY: number; side: number;
  squares: Square[];
  controlsY: number;
  /** Side columns flanking the big card (y/height match the big card). */
  leftCol: { x: number; w: number };
  rightCol: { x: number; w: number };
}

const ROW_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  marginBottom: "5px",
  fontFamily: "sans-serif",
  fontSize: "12px",
  color: "#ecd6aa",
};
const CTRL_LABEL_CSS: Partial<CSSStyleDeclaration> = {
  flex: "0 0 auto",
  width: "58px",
  color: "#a0a0b0",
};
const INPUT_CSS: Partial<CSSStyleDeclaration> = {
  background: "rgba(20, 22, 30, 0.98)",
  border: "1px solid #3a3a4a",
  borderRadius: "3px",
  color: "#ecd6aa",
  fontFamily: "sans-serif",
  fontSize: "12px",
  padding: "2px 6px",
  outline: "none",
};

/**
 * The Card Editor — opened from the right-click → Appearance menu for a
 * selected card. The hub for all card editing. Everything it shows is a **deep
 * copy / sandbox**: the panel owns its own {@link PrimList} (cloned from the
 * card's `:visuals @init`), and all renders + edits derive from that copy. The
 * running game's cards are never touched.
 *
 * Sections (top → bottom):
 *   - a large square rendering a copy of the whole card (re-rendered live as
 *     primitives are edited);
 *   - a dropdown (DOM `<select>`) over a smaller square that renders the one
 *     primitive the dropdown selects, followed by same-size squares for that
 *     primitive's channels (albedo / normal + two sprite placeholders);
 *   - a per-primitive edit-controls strip (text / colour / size / position /
 *     style) that mutates the working primitive and re-renders.
 */
export class CardEditorPanel extends PixiPanel {
  private readonly ctx: GameContext;

  /** Deep-copied, editable primitive list — the single source every render in
   *  this panel derives from. Replaced on each {@link show}, mutated by edits. */
  private workingList: PrimList = [];
  private faction: string | undefined;
  /** Variant-picker seed (the source card's id) so art variants match. */
  private seed = 0;
  private selectedIndex = 0;

  // Pixi renders, all children of `content`.
  private readonly bigFace: GenericCardFace;
  private readonly smallFace: GenericCardFace;
  /** Prim-square diffuse channel (master) for a sprite — replaces the smallFace
   *  render there; the smallFace stays the renderer for non-sprite prims. */
  private readonly diffuseSprite = new Sprite();
  private readonly albedoSprite = new Sprite();
  private readonly normalSprite = new Sprite();
  private readonly emissiveSprite = new Sprite();
  private readonly frame = new Graphics();
  private readonly cardLabel = new Text({ text: "Card", style: LABEL_STYLE });
  /** Prim-square label — "Diffuse" while a sprite's master diffuse is shown. */
  private readonly primLabel = new Text({ text: "", style: LABEL_STYLE });
  /** Reusable labels for the trailing row squares (albedo / normal / slots). */
  private readonly rowLabels: Text[] = Array.from({ length: 4 }, () => new Text({ text: "", style: LABEL_STYLE }));

  /** Master-channel texture cache + in-flight set (channels load async; on
   *  arrival we re-layout so the cache-hit path displays them). */
  private readonly masterCache = new Map<string, Texture>();
  private readonly masterLoading = new Set<string>();

  /** Always-visible top-right buttons: undo ↩️ / redo ↪️ / save 💾. */
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;

  // ── brush painting ──────────────────────────────────────────────────
  /** Stroke-based paint state: per-channel editable copies + undo/redo. Deep
   *  copies — never written back to master. Cleared on {@link show}. */
  private readonly paint = new PaintHistory(UNDO_LIMIT);
  /** Edited-albedo overlay on the card preview, so it reflects paint. */
  private readonly previewSprite = new Sprite();

  // ── preview viewport (pan / zoom / lighting) ────────────────────────
  /** Clips the card preview to its square. */
  private readonly previewView = new Container();
  /** Pan/zoom transform applied inside {@link previewView}. */
  private readonly previewContent = new Container();
  private readonly previewMask = new Graphics();
  private pan = { x: 0, y: 0 };
  private zoom = 1;
  private panning = false;
  private lastPan = { x: 0, y: 0 };
  /** Selected sprite's footprint in square-local px (pre pan/zoom), for the card
   *  paint surface; null when no sprite. */
  private cardSpaceSprite: { ox: number; oy: number; w: number; h: number; texW: number; texH: number } | null = null;
  /** The card preview as a paint surface (transform-baked); null when no sprite. */
  private cardSurface: Surface | null = null;

  // ── preview lighting (CPU, texel space) ─────────────────────────────
  /** Lit-result canvas the preview displays (albedo shaded by normal). */
  private litCanvas: HTMLCanvasElement | null = null;
  private litCtx: CanvasRenderingContext2D | null = null;
  private litTexture: Texture | null = null;
  private litOut: ImageData | null = null;
  /** CPU bloom pass over the lit result; rebuilt with the lit canvas on resize. */
  private bloom: Bloom | null = null;
  /** Cached source pixels (re-read on paint/undo, reused while only lights move). */
  private litAlbedoData: ImageData | null = null;
  private litNormalData: ImageData | null = null;
  private litEmissiveData: ImageData | null = null;
  /** The stem the lit canvas was sized for (rebuild on change). */
  private litStem: string | null = null;
  /** The card's main sprite node — the preview is pinned to it, so it stays the
   *  same regardless of which primitive is selected. Set on {@link show}. */
  private previewSpriteNode: VisualNode | null = null;
  /** The pinned preview sprite's master stem (recomputed each preview render). */
  private previewStem: string | null = null;
  /** Master stem the in-progress brush stroke is locked to. */
  private paintStem: string | null = null;
  /** The single movable light, in texel space (Light tool's left-click moves it). */
  private fixedLight = { x: 0, y: 0 };
  /** Cursor-follow light texel while the Light tool is active + over the sprite. */
  private cursorLight: { x: number; y: number } | null = null;
  /** Circle marking the fixed light, inside the preview viewport (pans/zooms). */
  private readonly lightGfx = new Graphics();
  /** The sprite views the brush operates over (one per displayed channel square
   *  + the card preview), rebuilt each {@link renderSelection}. */
  private surfaces: Surface[] = [];
  /** Master stem of the selected sprite, or null — the paint-layer key prefix. */
  private activeStem: string | null = null;
  /** Brush footprint outline, drawn over every surface on hover. */
  private readonly outlineGfx = new Graphics();
  /** Transparent pointer-capture layer over the body — drives hover + paint. */
  private readonly paintOverlay: HTMLDivElement;
  private hoverTexel: { tx: number; ty: number } | null = null;
  private painting = false;
  /** Which button is held while painting (0 = primary colour, 2 = secondary). */
  private paintButton = 0;

  /** DOM primitive picker, floated over the small square's top edge. */
  private readonly select: HTMLSelectElement;
  /** DOM per-primitive edit controls, rebuilt per selection. */
  private readonly editControls: HTMLDivElement;
  /** Always-visible tabbed section left of the card preview: the selected card's
   *  Aspects / Visual DSL / Data DSL / Locales. */
  private readonly leftSection: HTMLDivElement;
  private readonly leftPanes: HTMLDivElement[];
  /** Editable text buffers inside the tab panes (Aspects / Visual / Data /
   *  Locales). These are the working DSL/locale copies the editor patches and
   *  that `onSave` will eventually write back. */
  private readonly paneEditors: HTMLTextAreaElement[] = [];
  /** The current card's `::key>` — the def name used to scaffold a visuals block
   *  when one is authored from scratch. */
  private cardKey = "";
  /** Source `.rd` file each DSL tab's block came from (its `modify_content`
   *  lineage on save); empty when the card has no such block yet. */
  private visualFile = "";
  private dataFile = "";
  /** The card's locale `type` (the `cards[type][key]` bucket), for locale save. */
  private localeType = "";
  /** Each tab's value as loaded/last-synced — a tab is DIRTY (needs save) when its
   *  textarea differs, catching BOTH manual edits and programmatic ones (a light
   *  add rewrites the Visual buffer). Indexed like `paneEditors`. */
  private loadedTab: string[] = [];
  /** Art tools right of the card preview — visible only for a sprite selection. */
  private readonly artTools = new ArtToolsPanel({ onLightingChange: () => { this.relight(); this.drawLightMarkers(); } });

  private geom: Geom | null = null;
  private readonly unsubRelayout: () => void;
  private readonly unsubVis: () => void;
  private readonly unsubVis2: () => void;

  constructor(opts: CardEditorPanelOptions) {
    super({
      parent: opts.parent,
      title: "Card Editor",
      storageKey: "cardEditorPanel",
      defaultRect: { left: "24px", top: "48px", width: "760px", height: "680px" },
      taskbar: opts.taskbar,
      uiEditMode: opts.uiEditMode,
      closable: true,
    });
    this.ctx = opts.ctx;

    // Lift the inherited resize handles above this panel's DOM content. Unlike
    // other panels, the editor fills its body with `position: fixed` overlays
    // (the textarea panes, art tools, paint layer) at `zIndex` 25–31, while the
    // resize handles ship with no z-index (0). Without this, the textarea panes
    // paint over the 4px edge/corner strips, so an edge-drag lands on a textarea
    // and selects its text instead of resizing. 40 clears the content stack.
    for (const handle of [this.resizeCorner, this.resizeEdgeX, this.resizeEdgeY]) {
      handle.style.zIndex = "40";
    }

    this.bigFace = new GenericCardFace(opts.ctx, 0);
    this.smallFace = new GenericCardFace(opts.ctx, 0);
    this.albedoSprite.visible = false;
    this.normalSprite.visible = false;
    this.emissiveSprite.visible = false;

    this.diffuseSprite.visible = false;

    const c = this.content.container;
    c.addChild(this.frame);
    // Preview viewport: bigFace + edited-albedo overlay live inside a pan/zoom
    // container, clipped to the card square by previewMask.
    this.previewSprite.visible = false;
    this.previewContent.addChild(this.bigFace);
    this.previewContent.addChild(this.previewSprite); // displays the lit canvas
    this.previewContent.addChild(this.lightGfx);      // fixed-light marker
    this.previewView.addChild(this.previewContent);
    c.addChild(this.previewView);
    c.addChild(this.previewMask);
    this.previewView.mask = this.previewMask;
    c.addChild(this.smallFace);
    c.addChild(this.diffuseSprite);
    c.addChild(this.albedoSprite);
    c.addChild(this.normalSprite);
    c.addChild(this.emissiveSprite);
    c.addChild(this.cardLabel);
    c.addChild(this.primLabel);
    for (const lbl of this.rowLabels) c.addChild(lbl);
    c.addChild(this.outlineGfx); // brush outline draws over the squares + preview

    this.select = document.createElement("select");
    Object.assign(this.select.style, {
      position: "fixed",
      zIndex: "30",
      pointerEvents: "auto", // re-enable: the panel itself is pointer-events:none
      background: "rgba(20, 22, 30, 0.98)",
      border: "1px solid #3a3a4a",
      borderRadius: "3px",
      color: "#ecd6aa",
      fontFamily: "sans-serif",
      fontSize: "12px",
      padding: "2px 4px",
      display: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    this.select.addEventListener("change", () => this.selectPrimitive(this.select.selectedIndex));
    this.select.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.panel.appendChild(this.select);

    this.editControls = document.createElement("div");
    Object.assign(this.editControls.style, {
      position: "fixed",
      zIndex: "30",
      pointerEvents: "auto",
      overflowY: "auto",
      display: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    this.editControls.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.panel.appendChild(this.editControls);

    const tabbed = buildTabbedSection(["Aspects", "Visual", "Data", "Locales"]);
    this.leftSection = tabbed.root;
    this.leftPanes = tabbed.panes;
    this.panel.appendChild(this.leftSection);
    this.panel.appendChild(this.artTools.element);

    this.undoBtn = topButton("↩️", "Undo", () => { this.paint.undo(); this.refreshHistoryButtons(); this.afterEdit(); });
    this.redoBtn = topButton("↪️", "Redo", () => { this.paint.redo(); this.refreshHistoryButtons(); this.afterEdit(); });
    this.saveBtn = topButton("💾", "Save master", () => this.onSave());
    this.panel.append(this.undoBtn, this.redoBtn, this.saveBtn);

    // Paint overlay: a transparent pointer layer over the body. z below the DOM
    // controls (z30) so they keep their own clicks; it captures hover/paint over
    // the Pixi card + channel squares (the outline draws beneath it, in Pixi).
    this.paintOverlay = document.createElement("div");
    Object.assign(this.paintOverlay.style, {
      position: "fixed",
      zIndex: "25",
      pointerEvents: "auto",
      display: "none",
      cursor: "crosshair",
      background: "transparent",
    } satisfies Partial<CSSStyleDeclaration>);
    this.paintOverlay.addEventListener("pointermove", (e) => this.onPaintMove(e));
    this.paintOverlay.addEventListener("pointerdown", (e) => this.onPaintDown(e));
    this.paintOverlay.addEventListener("pointerup", () => this.onPaintUp());
    this.paintOverlay.addEventListener("pointercancel", () => this.onPaintUp());
    this.paintOverlay.addEventListener("pointerleave", () => {
      this.hoverTexel = null;
      this.drawOutline();
      if (this.cursorLight) { this.cursorLight = null; this.relight(); }
    });
    this.paintOverlay.addEventListener("contextmenu", (e) => e.preventDefault());
    this.paintOverlay.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.panel.appendChild(this.paintOverlay);

    this.unsubRelayout = this.onRectChange(() => this.relayout());
    this.unsubVis = this.onOpenChange(() => this.syncDomVisibility());
    this.unsubVis2 = this.onMinimizeChange(() => this.syncDomVisibility());
  }

  /** (Re)open the editor for a card. `packed` is the card's packed definition,
   *  `seed` its id (variant picker), `fallbackFaction` the viewer faction. */
  show(packed: number, seed: number, fallbackFaction?: string | null): void {
    this.seed = seed;
    const built = buildCardPrimList(this.ctx, packed, fallbackFaction);
    // Deep copy so edits stay sandboxed from the VM-produced list.
    this.workingList = structuredClone(built.list);
    this.faction = built.faction;
    // Fresh card → drop the previous card's editable channel copies + history,
    // and reset the preview viewport.
    this.paint.clear();
    this.hoverTexel = null;
    this.painting = false;
    this.panning = false;
    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
    // Reset lighting so a new card re-centres its light + rebuilds the lit canvas.
    this.litStem = null;
    this.cursorLight = null;
    this.litAlbedoData = null;
    this.litNormalData = null;
    // Pin the preview to the card's main (first) sprite, so it stays constant as
    // other primitives are selected.
    this.previewSpriteNode = this.workingList.find((n) => n.kind === "sprite" && !!n.texture?.name) ?? null;
    this.selectedIndex = this.workingList.length > 0 ? 0 : -1;
    this.populateSelect();
    this.select.selectedIndex = this.selectedIndex;
    this.populateTabs(packed);
    this.redrawCard();
    this.buildControls();
    if (!this.isOpen) this.open();
    this.focus();
    this.relayout();
  }

  /** Fill the left tabs with the opened card's Aspects / Visual DSL / Data DSL /
   *  Locales — the card's OWN entry only (not the functions it calls). */
  private populateTabs(packed: number): void {
    let def: CardDefJson | null = null;
    try { def = JSON.parse(sharedContent().cardDef(packed)) as CardDefJson | null; } catch { def = null; }
    const key = def?.key ?? "";
    const type = def?.type_name ?? "";
    this.cardKey = key;
    this.localeType = type;

    // Aspects — name: value, straight off the card def.
    const aspects = (def?.aspects ?? []).map(([n, v]) => `${n}: ${v}`).join("\n");
    this.fillPane(0, aspects || "(no aspects)");

    // Visual / Data DSL — the card's `::key>` block, classified by its facet
    // marker (`:visuals>` vs `:data>`); functions it calls are NOT included.
    let visual: string | null = null;
    let data: string | null = null;
    this.visualFile = "";
    this.dataFile = "";
    for (const [file, text] of contentSources()?.rd ?? []) {
      if (!key) break;
      const block = extractCardBlock(text, key);
      if (!block) continue;
      if (block.includes(":visuals>")) { visual = block; this.visualFile = file; }
      else if (block.includes(":data>")) { data = block; this.dataFile = file; }
    }
    this.fillPane(1, visual ?? "(no :visuals entry)");
    this.fillPane(2, data ?? "(no :data entry)");

    // Locales — the card's subtree (`cards[type][key]`) from the cards domain.
    let loc = "(no locale entry)";
    const cards = contentSources()?.locales.find(([d]) => d === "cards");
    if (cards && type && key) {
      try {
        const tree = (JSON.parse(cards[1]) as Record<string, Record<string, unknown>>)?.[type]?.[key];
        if (tree !== undefined) loc = flattenLocale(tree).join("\n");
      } catch { /* leave default */ }
    }
    this.fillPane(3, loc);
  }

  /** Fill a tab pane with an EDITABLE monospace text buffer (the working DSL /
   *  locale copy), stored in {@link paneEditors} for read-back on save + light
   *  sync. */
  private fillPane(i: number, text: string): void {
    const pane = this.leftPanes[i];
    if (!pane) return;
    pane.replaceChildren();
    pane.style.padding = "0"; // the textarea owns its own padding + scroll
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.spellcheck = false;
    Object.assign(ta.style, {
      display: "block", boxSizing: "border-box", width: "100%", height: "100%",
      margin: "0", padding: "8px", border: "none", outline: "none", resize: "none",
      background: "rgba(12, 14, 20, 0.6)", color: "#cdd3e0", whiteSpace: "pre",
      fontFamily: "ui-monospace, monospace", fontSize: "11px", lineHeight: "1.4",
    } satisfies Partial<CSSStyleDeclaration>);
    // Let the textarea own keyboard + selection without the panel intercepting.
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
    ta.addEventListener("keydown", (e) => e.stopPropagation());
    pane.appendChild(ta);
    this.paneEditors[i] = ta;
    this.loadedTab[i] = text; // baseline for dirty detection
  }

  /** A tab differs from its loaded baseline — dirtied by a manual edit OR a
   *  programmatic one (e.g. a light add rewriting the Visual buffer). */
  private tabDirty(i: number): boolean {
    return (this.paneEditors[i]?.value ?? "") !== (this.loadedTab[i] ?? "");
  }

  private populateSelect(): void {
    this.select.replaceChildren();
    this.workingList.forEach((n, i) => {
      const opt = document.createElement("option");
      const tex = n.texture?.name ? ` · ${n.texture.name}` : "";
      opt.value = String(i);
      opt.textContent = `${i}: ${n.kind}${tex}`;
      this.select.appendChild(opt);
    });
  }

  private selectPrimitive(i: number): void {
    if (i < 0 || i >= this.workingList.length) return;
    this.selectedIndex = i;
    this.buildControls();
    this.relayout();
  }

  /** Re-render the big card copy from the (possibly edited) working list. The
   *  face has no per-frame tick, so `drawList` clears + redraws to snap. Uses the
   *  source card's `seed` so seed-picked art matches the live card (and the
   *  albedo/normal squares, which resolve with the same seed). */
  private redrawCard(): void {
    this.bigFace.drawList(this.workingList, this.faction, this.seed);
  }

  private get selected(): VisualNode | undefined {
    return this.selectedIndex >= 0 ? this.workingList[this.selectedIndex] : undefined;
  }

  // ── layout ──────────────────────────────────────────────────────────
  private relayout(): void {
    const W = this.content.width;
    const H = this.content.height;
    if (W <= 1 || H <= 1) { this.syncDomVisibility(); return; }

    // Row squares sized for MAX_SQUARES so the prim square stays a constant size
    // regardless of how many channel squares the current selection shows.
    const side = clamp((W - (MAX_SQUARES + 1) * PAD) / MAX_SQUARES, 48, 130);
    // The art-tools column is fixed-width on the right. The card is RIGHT-justified
    // against it (not centred), so the left tabbed section expands to fill the rest
    // — leaving uniform padding instead of dead space either side of a centred card.
    const colW = clamp(W * COL_FRAC, COL_MIN, COL_MAX);
    const rightColX = W - PAD - colW;
    const heightCap = H - side - LABEL_H * 2 - CONTROLS_MIN - 5 * PAD;
    // Cap the card so the expanding left section keeps at least LEFT_MIN.
    const widthCap = rightColX - 3 * PAD - LEFT_MIN;
    const bigSide = clamp(Math.min(heightCap, widthCap), 80, Math.max(80, rightColX - 2 * PAD));
    const bigY = PAD;
    const bigX = rightColX - PAD - bigSide;
    const rowY = bigY + bigSide + LABEL_H + PAD;

    const squares = this.squareLayout(side);
    this.geom = {
      bigX, bigY, bigSide, rowY, side, squares,
      controlsY: rowY + side + LABEL_H + PAD,
      leftCol: { x: PAD, w: Math.max(0, bigX - 2 * PAD) },
      rightCol: { x: rightColX, w: colW },
    };

    this.drawFrame();
    this.positionBigFace();
    this.renderSelection();
    this.positionSelect();
    this.positionControls();
    this.positionSideSections();
    const body = this.bodyRect;
    place(this.paintOverlay, body.left, body.top, body.width, body.height);
    this.syncDomVisibility();
  }

  /** The squares to show for the current selection, with their content-local x.
   *  Always the prim square; albedo + normal + emissive when textured; plus one
   *  placeholder slot for a sprite (future channels). LEFT-justified (starting
   *  at `PAD`) so the prim square stays put as the channel squares come and go,
   *  instead of re-centring on every selection change. */
  private squareLayout(side: number): Square[] {
    const node = this.selected;
    const squares: Square[] = [{ kind: "prim", x: 0, label: "" }];
    // Channel squares are a sprite concern (its master diffuse/albedo/normal +
    // two future slots). Other prims show only the prim square.
    if (node?.kind === "sprite") {
      squares.push({ kind: "albedo", x: 0, label: "Albedo" });
      squares.push({ kind: "normal", x: 0, label: "Normal" });
      squares.push({ kind: "emissive", x: 0, label: "Emissive" });
      squares.push({ kind: "placeholder", x: 0, label: "Slot 4" });
    }
    squares.forEach((s, i) => { s.x = PAD + i * (side + PAD); });
    return squares;
  }

  private drawFrame(): void {
    const g = this.geom;
    if (!g) return;
    this.frame.clear();
    this.frame.rect(g.bigX, g.bigY, g.bigSide, g.bigSide).stroke({ color: FRAME_COLOR, width: 1 });
    for (const sq of g.squares) {
      this.frame.rect(sq.x, g.rowY, g.side, g.side).stroke({ color: FRAME_COLOR, width: 1 });
    }
    this.cardLabel.position.set(g.bigX, g.bigY + g.bigSide + 2);
    // Trailing-square labels (skip the prim square — the dropdown sits over it).
    const trailing = g.squares.filter((s) => s.kind !== "prim");
    this.rowLabels.forEach((lbl, i) => {
      const sq = trailing[i];
      lbl.visible = !!sq;
      if (sq) {
        lbl.text = sq.label;
        lbl.position.set(sq.x, g.rowY + g.side + 2);
      }
    });
  }

  private positionBigFace(): void {
    const g = this.geom;
    if (!g) return;
    // The card face's origin (0,0) is the BODY top-left; the title strip sits at
    // NEGATIVE y above it. The full face spans card_width × card_height — scale by
    // card_height (not body_height) and shift down by title_height·s to keep the
    // title in frame. CARD_FIT leaves a margin so the card sits inside the square.
    const cw = global("card_width");
    const ch = global("card_height");
    const th = global("title_height");
    const s = Math.min(g.bigSide / cw, g.bigSide / ch) * CARD_FIT;
    // SQUARE-LOCAL: the card lays out inside the preview viewport (origin = square
    // top-left); previewView positions it at the square + applies pan/zoom + mask.
    const tlx = (g.bigSide - cw * s) / 2;
    const tly = (g.bigSide - ch * s) / 2;
    this.bigFace.scale.set(s);
    this.bigFace.position.set(tlx, tly + th * s);
    this.previewView.position.set(g.bigX, g.bigY);
    this.previewMask.clear().rect(g.bigX, g.bigY, g.bigSide, g.bigSide).fill(0xffffff);
    this.updatePreviewTransform();
  }

  /** Push pan/zoom into the preview container + recompute the card paint surface
   *  (which bakes the transform) + redraw the outline. Cheap — called on pan,
   *  zoom, and relayout, without re-resolving textures. */
  private updatePreviewTransform(): void {
    this.previewContent.position.set(this.pan.x, this.pan.y);
    this.previewContent.scale.set(this.zoom);
    this.computeCardSurface();
    this.drawOutline();
  }

  /** Bake the preview transform into the card paint surface (content-local),
   *  clipped to the square. Null when no sprite is selected. */
  private computeCardSurface(): void {
    const g = this.geom;
    const sp = this.cardSpaceSprite;
    if (!g || !sp) { this.cardSurface = null; return; }
    const ox = g.bigX + this.pan.x + sp.ox * this.zoom;
    const oy = g.bigY + this.pan.y + sp.oy * this.zoom;
    const w = sp.w * this.zoom;
    const h = sp.h * this.zoom;
    const cx = Math.max(ox, g.bigX);
    const cy = Math.max(oy, g.bigY);
    const cw = Math.min(ox + w, g.bigX + g.bigSide) - cx;
    const ch = Math.min(oy + h, g.bigY + g.bigSide) - cy;
    this.cardSurface = cw <= 0 || ch <= 0
      ? null
      : { rx: cx, ry: cy, rw: cw, rh: ch, ox, oy, sx: w / sp.texW, sy: h / sp.texH, texW: sp.texW, texH: sp.texH, stem: this.previewStem ?? "", channel: "lit" };
  }

  /** Cursor (content-local) is over the card preview square. */
  private overPreview(e: PointerEvent | WheelEvent): boolean {
    const g = this.geom;
    if (!g) return false;
    const body = this.bodyRect;
    const lx = e.clientX - body.left;
    const ly = e.clientY - body.top;
    return lx >= g.bigX && ly >= g.bigY && lx <= g.bigX + g.bigSide && ly <= g.bigY + g.bigSide;
  }

  private onWheel(e: WheelEvent): void {
    const g = this.geom;
    if (!g || !this.overPreview(e)) return;
    e.preventDefault();
    const body = this.bodyRect;
    const cx = e.clientX - body.left - g.bigX; // square-local
    const cy = e.clientY - body.top - g.bigY;
    const px = (cx - this.pan.x) / this.zoom;
    const py = (cy - this.pan.y) / this.zoom;
    const z = clamp(this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.25, 24);
    this.pan = { x: cx - px * z, y: cy - py * z };
    this.zoom = z;
    this.updatePreviewTransform();
  }

  /** Render the prim square + (for a sprite) its master channel squares. A
   *  sprite shows its MASTER diffuse in the prim square (labelled "Diffuse") and
   *  master albedo / normal in the channel squares — the editor pulls from the
   *  master source, not the card's LOD. Non-sprite prims render via the small
   *  face. Channels load async; `masterTex` re-layouts once they're cached. */
  private renderSelection(): void {
    const g = this.geom;
    const node = this.selected;
    this.surfaces = [];
    // Selection drives the prim square + channel squares + their paint surfaces.
    const stem = node?.kind === "sprite" && node.texture?.name
      ? masterVariantStem(node.texture.name, this.faction, this.seed, node.texture.index)
      : null;
    this.activeStem = stem;
    if (g && node && stem) {
      const primX = g.squares.find((s) => s.kind === "prim")?.x ?? 0;
      const albedoSq = g.squares.find((s) => s.kind === "albedo");
      const normalSq = g.squares.find((s) => s.kind === "normal");
      const emissiveSq = g.squares.find((s) => s.kind === "emissive");
      // Diffuse (read-only) fills the prim square; the small face is its
      // placeholder until the master loads. Albedo / normal show their editable
      // canvas copies (the brush paints these).
      const diffuse = this.masterTex(stem, "diffuse");
      if (diffuse) {
        this.smallFace.visible = false;
        this.fitChannelAt(this.diffuseSprite, diffuse, primX, g.rowY, g.side, stem, "diffuse");
        this.primLabel.text = "Diffuse";
        this.primLabel.visible = true;
        this.primLabel.position.set(primX, g.rowY + g.side + 2);
      } else {
        this.diffuseSprite.visible = false;
        this.renderSmallFace(node, primX, g);
        this.primLabel.visible = false;
      }
      if (albedoSq) this.fitChannelAt(this.albedoSprite, this.channelTexture(stem, "albedo"), albedoSq.x, g.rowY, g.side, stem, "albedo");
      else this.albedoSprite.visible = false;
      if (normalSq) this.fitChannelAt(this.normalSprite, this.channelTexture(stem, "normal"), normalSq.x, g.rowY, g.side, stem, "normal");
      else this.normalSprite.visible = false;
      if (emissiveSq) this.fitChannelAt(this.emissiveSprite, this.channelTexture(stem, "emissive"), emissiveSq.x, g.rowY, g.side, stem, "emissive");
      else this.emissiveSprite.visible = false;
    } else if (g && node) {
      // Non-sprite: the small face renders the prim; no channel squares.
      this.diffuseSprite.visible = false;
      this.albedoSprite.visible = false;
      this.normalSprite.visible = false;
      this.emissiveSprite.visible = false;
      this.primLabel.visible = false;
      this.renderSmallFace(node, g.squares.find((s) => s.kind === "prim")?.x ?? 0, g);
    } else {
      this.hideSelectionRenders();
    }
    // The PREVIEW is pinned to the card's main sprite — independent of selection.
    this.renderPreview();
    this.drawOutline();
    this.refreshHistoryButtons();
  }

  /** Render the (selection-independent) lit card preview + its paint surface from
   *  the pinned main sprite, so it stays the same as primitives are selected. */
  private renderPreview(): void {
    const g = this.geom;
    const node = this.previewSpriteNode;
    const stem = node?.texture?.name
      ? masterVariantStem(node.texture.name, this.faction, this.seed, node.texture.index)
      : null;
    this.previewStem = stem;
    if (!g || !node || !stem) {
      this.previewSprite.visible = false;
      this.cardSpaceSprite = null;
      this.cardSurface = null;
      this.lightGfx.clear();
      return;
    }
    const albedoTex = this.channelTexture(stem, "albedo");
    const normalTex = this.channelTexture(stem, "normal");
    // Ensure the pinned sprite's emissive layer exists (blank when it ships none)
    // so the lit composite can ADD its glow — independent of which prim is selected.
    this.channelTexture(stem, "emissive");
    const litTex = albedoTex ? this.prepareLighting(stem, albedoTex) : null;
    this.recordCardSurface(node, albedoTex ?? normalTex ?? this.masterTex(stem, "diffuse"), litTex);
    this.drawLightMarkers();
  }

  private hideSelectionRenders(): void {
    this.smallFace.visible = false;
    this.diffuseSprite.visible = false;
    this.albedoSprite.visible = false;
    this.normalSprite.visible = false;
    this.emissiveSprite.visible = false;
    this.primLabel.visible = false;
  }

  /** Editable display texture for a paintable channel (created from the master on
   *  first need); `null` until the master loads or when the channel is absent.
   *  Emissive is allowed to start from scratch: when a sprite ships no emissive
   *  master, we MAKE the layer blank (sized to its albedo/diffuse) so the brush
   *  has a transparent canvas to paint glow onto. */
  private channelTexture(stem: string, channel: "albedo" | "normal" | "emissive"): Texture | null {
    const key = `${stem}|${channel}`;
    if (this.paint.has(key)) return this.paint.getOrCreateTexture(key, Texture.EMPTY)!;
    const master = this.masterTex(stem, channel);
    if (master) return this.paint.getOrCreateTexture(key, master);
    if (channel === "emissive") {
      const dims = this.masterTex(stem, "albedo") ?? this.masterTex(stem, "diffuse");
      if (dims) return this.paint.getOrCreateBlank(key, dims.width || 1, dims.height || 1);
    }
    return null;
  }

  /** Fit `tex` into a channel square (or hide the sprite) and, when shown, record
   *  its paint Surface so the brush can hover / paint over it. */
  private fitChannelAt(sprite: Sprite, tex: Texture | null, x: number, y: number, side: number, stem: string, channel: SurfaceChannel): void {
    if (!tex) { sprite.visible = false; return; }
    const p = fitPlacement(tex, x, y, side);
    sprite.texture = tex;
    sprite.visible = true;
    sprite.anchor.set(0);
    sprite.setSize(p.w, p.h);
    sprite.position.set(p.ox, p.oy);
    this.surfaces.push({
      rx: x, ry: y, rw: side, rh: side,
      ox: p.ox, oy: p.oy, sx: p.scale, sy: p.scale,
      texW: tex.width || 1, texH: tex.height || 1, stem, channel,
    });
  }

  /** Record the sprite's footprint on the card preview (square-local, pre
   *  pan/zoom) for the card paint surface, and overlay the edited albedo
   *  (`preview`) there so the card reflects edits. */
  private recordCardSurface(node: VisualNode, tex: Texture | null, preview: Texture | null): void {
    if (!tex) { this.cardSpaceSprite = null; this.cardSurface = null; this.previewSprite.visible = false; return; }
    const texW = tex.width || 1;
    const texH = tex.height || 1;
    const s = this.bigFace.scale.x;
    const ax = (node.anchor?.x ?? 0) / 100;
    const ay = (node.anchor?.y ?? 0) / 100;
    const w = node.size.x * s;
    const h = node.size.y * s;
    // Square-local (bigFace.position is already square-local): pan/zoom is applied
    // by previewContent; the card paint surface bakes it in `computeCardSurface`.
    const ox = this.bigFace.position.x + (node.pos.x - ax * node.size.x) * s;
    const oy = this.bigFace.position.y + (node.pos.y - ay * node.size.y) * s;
    this.cardSpaceSprite = { ox, oy, w, h, texW, texH };
    if (preview) {
      this.previewSprite.texture = preview;
      this.previewSprite.visible = true;
      this.previewSprite.anchor.set(0);
      this.previewSprite.setSize(w, h);
      this.previewSprite.position.set(ox, oy);
    } else {
      this.previewSprite.visible = false;
    }
    this.computeCardSurface();
  }

  // ── preview lighting ────────────────────────────────────────────────
  /** Ensure the lit canvas matches the sprite, re-read the source channels, and
   *  relight — returning the lit texture the preview displays. */
  private prepareLighting(stem: string, albedoTex: Texture): Texture | null {
    const w = albedoTex.width || 1;
    const h = albedoTex.height || 1;
    if (!this.litCanvas || this.litCanvas.width !== w || this.litCanvas.height !== h) {
      this.litTexture?.destroy(true);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      this.litCanvas = canvas;
      this.litCtx = ctx;
      this.litTexture = Texture.from(canvas);
      this.litOut = ctx.createImageData(w, h);
      this.bloom = new Bloom(w, h);
    }
    if (this.litStem !== stem) {
      this.fixedLight = { x: w * 0.15, y: h * 0.15 }; // new sprite → light from the top-left
      this.litStem = stem;
    }
    this.refreshLightingSource();
    this.relight();
    return this.litTexture;
  }

  /** Re-read the albedo + normal channel pixels (after a paint / undo / redo). */
  private refreshLightingSource(): void {
    const stem = this.litStem;
    if (!stem) { this.litAlbedoData = null; this.litNormalData = null; return; }
    this.litAlbedoData = canvasData(this.paint.channelCanvas(`${stem}|albedo`));
    this.litNormalData = canvasData(this.paint.channelCanvas(`${stem}|normal`));
    this.litEmissiveData = canvasData(this.paint.channelCanvas(`${stem}|emissive`));
  }

  /** Recompute the lit canvas from the cached source + current lights. */
  private relight(): void {
    if (!this.litCtx || !this.litOut || !this.litAlbedoData || !this.litTexture) return;
    composite(this.litOut, this.litAlbedoData, this.litNormalData, this.litEmissiveData, this.buildLights(), LIGHT_AMBIENT, LIGHT_Y_SIGN);
    const radius = Math.max(2, Math.round(Math.max(this.litOut.width, this.litOut.height) * BLOOM_RADIUS_FRAC));
    this.bloom?.apply(this.litOut, this.litEmissiveData, BLOOM_THRESHOLD, radius, BLOOM_INTENSITY);
    this.litCtx.putImageData(this.litOut, 0, 0);
    this.litTexture.source.update();
  }

  /** Every light shading the preview: the fixed (white) light, the cursor light
   *  (art tools' primary colour) while hovering, and each `light` PRIMITIVE in
   *  the working list (its `pos` / `tint` / `light` variables). */
  private buildLights(): Light[] {
    if (!this.litCanvas) return [];
    const dim = Math.max(this.litCanvas.width, this.litCanvas.height);
    const def = { height: dim * LIGHT_HEIGHT, radius: dim * LIGHT_RADIUS, intensity: LIGHT_INTENSITY };
    const mk = (x: number, y: number, color: number, v = def): Light => ({
      x, y, height: v.height, radius: v.radius, intensity: v.intensity,
      r: ((color >> 16) & 0xff) / 255, g: ((color >> 8) & 0xff) / 255, b: (color & 0xff) / 255,
    });
    // Fixed + cursor lights are editor-internal (texel space). Light PRIMITIVES
    // store the GAME unit — card px — so they round-trip to the DSL unchanged;
    // convert them into the preview sprite's texel space for the CPU composite.
    // The fixed (default) light is skippable via the Art Tools toggle, to preview
    // the card's own lights alone.
    const lights: Light[] = [];
    if (this.artTools.defaultLight) lights.push(mk(this.fixedLight.x, this.fixedLight.y, 0xffffff));
    if (this.cursorLight) {
      // Preview the cursor light with the Light tool's OWN options (card px →
      // texel), so the hover matches the light that left-click will place.
      lights.push(mk(this.cursorLight.x, this.cursorLight.y, this.artTools.primary, {
        height: this.cardLenToTexel(this.artTools.lightHeight),
        radius: this.cardLenToTexel(this.artTools.lightRadius),
        intensity: this.artTools.lightIntensity,
      }));
    }
    for (const n of this.workingList) {
      if (n.kind !== "light" || !n.light) continue;
      const t = this.cardToTexel(n.pos.x, n.pos.y);
      lights.push(mk(t.tx, t.ty, n.tint ?? 0xffffff, {
        height: this.cardLenToTexel(n.light.height),
        radius: this.cardLenToTexel(n.light.radius),
        intensity: n.light.intensity,
      }));
    }
    return lights;
  }

  // Light PRIMITIVES live in card-px (the game/DSL unit); the preview composites
  // in the preview sprite's texel space. These map between the two via the sprite's
  // card-px box (`node.pos`/`size`) ↔ the texel grid.
  private cardToTexel(cx: number, cy: number): { tx: number; ty: number } {
    const n = this.previewSpriteNode;
    if (!n || !this.litCanvas) return { tx: cx, ty: cy };
    const ax = (n.anchor?.x ?? 0) / 100;
    const ay = (n.anchor?.y ?? 0) / 100;
    const left = n.pos.x - ax * n.size.x;
    const top = n.pos.y - ay * n.size.y;
    return {
      tx: ((cx - left) / (n.size.x || 1)) * this.litCanvas.width,
      ty: ((cy - top) / (n.size.y || 1)) * this.litCanvas.height,
    };
  }

  private texelToCard(tx: number, ty: number): { x: number; y: number } {
    const n = this.previewSpriteNode;
    if (!n || !this.litCanvas) return { x: tx, y: ty };
    const ax = (n.anchor?.x ?? 0) / 100;
    const ay = (n.anchor?.y ?? 0) / 100;
    const left = n.pos.x - ax * n.size.x;
    const top = n.pos.y - ay * n.size.y;
    return {
      x: left + (tx / this.litCanvas.width) * n.size.x,
      y: top + (ty / this.litCanvas.height) * n.size.y,
    };
  }

  /** Card-px length → texel length (uses the sprite's x-scale). */
  private cardLenToTexel(len: number): number {
    const n = this.previewSpriteNode;
    if (!n || !this.litCanvas) return len;
    return (len / (n.size.x || 1)) * this.litCanvas.width;
  }

  /** Draw a marker for every light — the fixed light + each light primitive — at
   *  its texel position (sprite-local, so it pans/zooms with the preview). */
  private drawLightMarkers(): void {
    this.lightGfx.clear();
    const sp = this.cardSpaceSprite;
    if (!sp || !this.litCanvas) return;
    const mark = (tx: number, ty: number, color: number): void => {
      const lx = sp.ox + (tx / sp.texW) * sp.w;
      const ly = sp.oy + (ty / sp.texH) * sp.h;
      this.lightGfx.circle(lx, ly, LIGHT_MARKER_R).stroke({ color, width: 1.5 });
      this.lightGfx.circle(lx, ly, 1.5).fill(color);
    };
    if (this.artTools.defaultLight) mark(this.fixedLight.x, this.fixedLight.y, LIGHT_MARKER_COLOR);
    for (const n of this.workingList) {
      if (n.kind !== "light") continue;
      const t = this.cardToTexel(n.pos.x, n.pos.y); // card-px → texel
      mark(t.tx, t.ty, n.tint ?? 0xffffff);
    }
  }

  /** Add a `light` primitive at texel `(tx, ty)` (Light tool, left-click), then
   *  select it. Stored in CARD px (the game/DSL unit) — position from the click,
   *  height/radius/intensity from the Light tool's Art Tools options, colour from
   *  the primary swatch. Joins the working list, so it shows in the dropdown +
   *  drives the preview lighting (and is sandbox DSL). */
  private addLightPrim(tx: number, ty: number): void {
    const c = this.texelToCard(tx, ty);
    const node: VisualNode = {
      kind: "light",
      pos: { x: c.x, y: c.y },
      size: { x: 0, y: 0 },
      tint: this.artTools.primary,
      light: { height: this.artTools.lightHeight, radius: this.artTools.lightRadius, intensity: this.artTools.lightIntensity },
    };
    this.workingList.push(node);
    this.populateSelect();
    this.selectedIndex = this.workingList.length - 1;
    this.select.selectedIndex = this.selectedIndex;
    this.buildControls();
    this.relayout();
    this.syncLightsToDsl();
  }

  /** A light primitive's variables changed — relight + redraw markers (cheap;
   *  no relayout, so the edited field keeps focus) and re-emit the DSL. */
  private onLightEdit(): void {
    this.relight();
    this.drawLightMarkers();
    this.syncLightsToDsl();
  }

  /** The working list's light primitives, in the DSL/game unit (card px). */
  private editorLights(): DslLight[] {
    const out: DslLight[] = [];
    for (const n of this.workingList) {
      if (n.kind !== "light" || !n.light) continue;
      out.push({ x: n.pos.x, y: n.pos.y, tint: n.tint ?? 0xffffff, height: n.light.height, radius: n.light.radius, intensity: n.light.intensity });
    }
    return out;
  }

  /** Patch the editor-managed `^light` region of the Visual DSL tab to match the
   *  working list — the first instance of the editor → DSL write-back path. The
   *  tab text stays the source of truth that {@link onSave} will persist. */
  private syncLightsToDsl(): void {
    const ta = this.paneEditors[1]; // Visual DSL tab
    if (!ta) return;
    ta.value = syncLightRegion(ta.value, this.editorLights(), this.cardKey);
  }

  /** Render `node` in isolation (centred + fit) in the prim square via the small
   *  face — the single-primitive view for non-sprite prims (and sprites while
   *  their master diffuse loads). */
  private renderSmallFace(node: VisualNode, primX: number, g: Geom): void {
    const clone = structuredClone(node);
    const maxDim = Math.max(1, clone.size.x, clone.size.y);
    clone.pos = { x: g.side / 2, y: g.side / 2 };
    clone.anchor = { x: 50, y: 50 };
    clone.scale = (g.side * 0.82) / maxDim;
    clone.rot = 0;
    clone.alpha = 1;
    this.smallFace.visible = true;
    this.smallFace.position.set(primX, g.rowY);
    this.smallFace.scale.set(1);
    this.smallFace.drawList([clone], this.faction, this.seed);
  }

  // ── brush hover / paint / pan ───────────────────────────────────────
  /** Every paint surface — the channel squares plus the (transform-baked) card. */
  private allSurfaces(): Surface[] {
    return this.cardSurface ? [...this.surfaces, this.cardSurface] : this.surfaces;
  }

  /** Redraw the brush footprint outline over every surface at the hovered
   *  texel. Cheap — called on each pointer move (not a full relayout). The
   *  footprint follows the brush shape (square / round) and shows for the
   *  stamping tools (brush + erase). */
  private drawOutline(): void {
    this.outlineGfx.clear();
    const h = this.hoverTexel;
    const tool = this.artTools.tool;
    if (!h || (tool !== "brush" && tool !== "erase")) return;
    const brush = this.artTools.brushSize;
    for (const s of this.allSurfaces()) {
      const r = outlineRect(s, h.tx, h.ty, brush);
      if (this.artTools.shape === "round") {
        this.outlineGfx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2).stroke({ color: OUTLINE_COLOR, width: 1 });
      } else {
        this.outlineGfx.rect(r.x, r.y, r.w, r.h).stroke({ color: OUTLINE_COLOR, width: 1 });
      }
    }
  }

  /** The shared texel under a pointer event + the surface it hit (its stem +
   *  channel), or null if not over any surface. First matching surface wins. */
  private locate(e: PointerEvent): { tx: number; ty: number; stem: string; channel: SurfaceChannel } | null {
    const body = this.bodyRect;
    const lx = e.clientX - body.left;
    const ly = e.clientY - body.top;
    for (const s of this.allSurfaces()) {
      const t = surfaceTexel(s, lx, ly);
      if (t) return { tx: t.tx, ty: t.ty, stem: s.stem, channel: s.channel };
    }
    return null;
  }

  /** Texel under the cursor on the PREVIEW card surface (light positions live in
   *  the pinned preview sprite's texel space). */
  private locateCard(e: PointerEvent): { tx: number; ty: number } | null {
    if (!this.cardSurface) return null;
    const body = this.bodyRect;
    return surfaceTexel(this.cardSurface, e.clientX - body.left, e.clientY - body.top);
  }

  private onPaintMove(e: PointerEvent): void {
    const tool = this.artTools.tool;
    this.paintOverlay.style.cursor =
      tool === "pan" ? "grab" : tool === "light" ? "cell" : tool === "bucket" ? "copy" : "crosshair";
    if (this.panning) {
      this.pan = { x: this.pan.x + (e.clientX - this.lastPan.x), y: this.pan.y + (e.clientY - this.lastPan.y) };
      this.lastPan = { x: e.clientX, y: e.clientY };
      this.updatePreviewTransform();
      return;
    }
    if (tool === "light") {
      // The cursor is a second light (in preview-sprite texel space); relight live.
      const hit = this.locateCard(e);
      this.cursorLight = hit ? { x: hit.tx, y: hit.ty } : null;
      this.relight();
      return;
    }
    const hit = this.locate(e);
    this.hoverTexel = hit;
    this.drawOutline();
    if (this.painting && hit && hit.stem === this.paintStem) {
      this.paint.paint(hit.tx, hit.ty);
    }
  }

  /** Mouse-down: Pan drags the preview; Light's MIDDLE click moves the fixed
   *  light; Bucket flood-fills the clicked region into the selected layer;
   *  Brush / Erase begin a stroke onto the surface's sprite (left = primary
   *  colour, right = secondary). */
  private onPaintDown(e: PointerEvent): void {
    const tool = this.artTools.tool;
    if (tool === "light") {
      const hit = this.locateCard(e);
      if (!hit) return;
      e.preventDefault();
      if (e.button === 1) {
        // Middle-click moves the fixed light.
        this.fixedLight = { x: hit.tx, y: hit.ty };
        this.drawLightMarkers();
        this.relight();
      } else if (e.button === 0) {
        // Left-click drops a light PRIMITIVE at the cursor.
        this.addLightPrim(hit.tx, hit.ty);
      }
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    if (tool === "pan") {
      if (!this.overPreview(e)) return;
      e.preventDefault();
      this.panning = true;
      this.lastPan = { x: e.clientX, y: e.clientY };
      this.paintOverlay.setPointerCapture?.(e.pointerId);
      return;
    }
    const hit = this.locate(e);
    if (!hit) return;
    this.paintButton = e.button;
    if (tool === "bucket") { e.preventDefault(); this.bucketFill(hit); return; }
    // Brush / erase: begin a stroke on the selected layer of the hit sprite.
    const key = `${hit.stem}|${this.artTools.layer}`;
    if (!this.paint.has(key)) return; // that sprite's selected layer isn't editable
    e.preventDefault();
    this.painting = true;
    this.paintStem = hit.stem;
    this.paintOverlay.setPointerCapture?.(e.pointerId);
    this.paint.begin(key, this.currentBrush());
    this.paint.paint(hit.tx, hit.ty);
    this.refreshHistoryButtons();
  }

  /** The stroke config for the active tool — `erase` reveals the channel's
   *  backing; otherwise the dab is tinted with the held button's colour. */
  private currentBrush(): Brush {
    const a = this.artTools;
    return {
      size: a.brushSize,
      shape: a.shape,
      hardness: a.hardness,
      opacity: a.opacity,
      color: this.strokeColor(),
      erase: a.tool === "erase",
    };
  }

  /** Paint bucket: flood-fill the region under the cursor in the CLICKED
   *  surface's texture, then fill that region (scaled to fit) into the SELECTED
   *  layer of the same sprite as one undoable stroke. */
  private bucketFill(hit: { tx: number; ty: number; stem: string; channel: SurfaceChannel }): void {
    const src = this.surfacePixels(hit.stem, hit.channel);
    if (!src) return;
    const layer = this.artTools.layer;
    this.channelTexture(hit.stem, layer); // ensure the target layer exists (blank emissive if absent)
    const key = `${hit.stem}|${layer}`;
    if (!this.paint.has(key)) return;
    const mask = floodFill(src, hit.tx, hit.ty, this.artTools.tolerance);
    this.paint.fillRegion(key, mask, this.strokeColor());
    this.refreshHistoryButtons();
    this.afterEdit();
  }

  /** Read a surface's source pixels for the paint bucket: the lit canvas for the
   *  card preview, the edited channel canvas (or its master) for a paint channel,
   *  the master for diffuse. */
  private surfacePixels(stem: string, channel: SurfaceChannel): ImageData | null {
    if (channel === "lit") return canvasData(this.litCanvas);
    if (channel === "diffuse") {
      const tex = this.masterTex(stem, "diffuse");
      return tex ? textureData(tex) : null;
    }
    const edited = this.paint.channelCanvas(`${stem}|${channel}`);
    if (edited) return canvasData(edited);
    const tex = this.masterTex(stem, channel);
    return tex ? textureData(tex) : null;
  }

  /** Mouse-up: end a pan, or finalise a stroke into the undo history (then
   *  relight, since the channel just changed). */
  private onPaintUp(): void {
    if (this.panning) { this.panning = false; return; }
    if (!this.painting) return;
    this.painting = false;
    this.paint.end();
    this.refreshHistoryButtons();
    this.afterEdit();
  }

  /** Re-read the channels + relight after an edit (stroke / undo / redo). */
  private afterEdit(): void {
    this.refreshLightingSource();
    this.relight();
  }

  private strokeColor(): string {
    return cssColor(this.paintButton === 2 ? this.artTools.secondary : this.artTools.primary);
  }

  private refreshHistoryButtons(): void {
    setButtonEnabled(this.undoBtn, this.paint.canUndo());
    setButtonEnabled(this.redoBtn, this.paint.canRedo());
  }

  /** A master channel texture if cached; otherwise kick the async load (deduped)
   *  and re-layout on arrival so the cache-hit path displays it. `null` until
   *  loaded (or when the channel doesn't exist on disk). */
  private masterTex(stem: string, channel: MasterChannel): Texture | null {
    const url = masterChannelUrl(stem, channel);
    if (!url) return null;
    const cached = this.masterCache.get(url);
    if (cached) return cached;
    if (!this.masterLoading.has(url)) {
      this.masterLoading.add(url);
      loadMasterTexture(url)
        .then((tex) => { this.masterCache.set(url, tex); this.relayout(); })
        .catch(() => { /* missing/failed — stays hidden */ })
        .finally(() => { this.masterLoading.delete(url); });
    }
    return null;
  }

  /** Save: write every DIRTY tab + painted master channel back through the gate.
   *  A tab is dirty when its buffer differs from what was loaded — covering BOTH
   *  manual edits and programmatic ones (a light add rewrites the Visual buffer,
   *  so it saves too). Visual + Data combine into one `::key>` card def →
   *  `modify_content` (which VERSIONS the lineage, not a file); the Locale subtree
   *  → `modify_locale`; painted master channels → `upload_master` (dirty-only, so
   *  a map we never made is never written). Aspects is a read-out of the `:data`
   *  block — authored via the Data tab, so it has no separate source to write. */
  private onSave(): void {
    const src = contentSources();
    if (!src) return;
    const sent: string[] = [];

    // Visual + Data DSL: a card is authored as ONE versioned def. `modify_content`
    // takes the CARD LINEAGE (`key`) + a `<card>`-bucketed source defining `::key>`
    // — it versions the lineage (`::key>` → `::key.N>`) by appending a runtime
    // source, NOT a file rewrite. Since the loader merges facets by def NAME, the
    // new version must carry the card's FULL def, so combine the (possibly edited)
    // Data + Visual tab blocks into one `::key>` def. Send when either is dirty.
    if (this.cardKey && (this.tabDirty(1) || this.tabDirty(2))) {
      const source = buildCardSource(this.cardKey, [this.paneEditors[2]?.value ?? "", this.paneEditors[1]?.value ?? ""]);
      if (source) {
        this.ctx.client.modifyContent(this.cardKey, source);
        this.loadedTab[1] = this.paneEditors[1]?.value ?? this.loadedTab[1]; // re-baseline
        this.loadedTab[2] = this.paneEditors[2]?.value ?? this.loadedTab[2];
        sent.push(`card:${this.cardKey}`);
      }
    }

    // Locale: unflatten the edited subtree, merge into the cards-domain JSON → send.
    if (this.tabDirty(3)) {
      const loc = this.assembleLocale(src.locales);
      if (loc) {
        this.ctx.client.modifyLocale(loc.domain, loc.json);
        this.loadedTab[3] = this.paneEditors[3]!.value;
        sent.push(`locale:${loc.domain}`);
      }
    }

    // Master-channel texture write: upload each EDITED channel. The paint key is
    // `<stem>|<channel>`, stem `/textures/master/<aspect>/<faction>/<variant>`.
    const dirty = this.paint.dirtyChannels();
    for (const { key, canvas } of dirty) {
      const bar = key.lastIndexOf("|");
      if (bar < 0) continue;
      const stem = key.slice(0, bar);
      const channel = key.slice(bar + 1);
      const m = stem.match(/^\/textures\/master\/([^/]+)\/([^/]+)\/(.+)$/);
      if (!m) continue;
      const [, aspect, faction, variant] = m;
      this.uploadMasterChannel(aspect, faction, variant, channel, canvas);
    }
    debug.log(
      ["ui"],
      `[CardEditor] Save: sent [${sent.join(", ") || "no DSL"}] + ${dirty.length} master channel(s)`,
      2,
    );
  }

  /** Merge the edited Locale tab (a flattened `cards[type][key]` subtree) back
   *  into the full cards-domain JSON, returning the `{domain, json}` to send.
   *  `null` if the domain JSON is missing/unparseable or the card lacks a
   *  type/key. */
  private assembleLocale(locales: [string, string][]): { domain: string; json: string } | null {
    const domain = "cards";
    const entry = locales.find(([d]) => d === domain);
    if (!entry || !this.localeType || !this.cardKey) return null;
    let root: Record<string, Record<string, unknown>>;
    try { root = JSON.parse(entry[1]) as Record<string, Record<string, unknown>>; } catch { return null; }
    (root[this.localeType] ??= {})[this.cardKey] = unflattenLocale(this.paneEditors[3]!.value);
    return { domain, json: JSON.stringify(root) };
  }

  /** Encode an edited channel's display canvas as a PNG and ship it to the gate
   *  (`uploadMaster` → texture R2 bucket). Async (canvas → blob); fire-and-forget. */
  private uploadMasterChannel(
    aspect: string,
    faction: string,
    variant: string,
    channel: string,
    canvas: HTMLCanvasElement,
  ): void {
    canvas.toBlob((blob) => {
      if (!blob) return;
      void blob.arrayBuffer().then((buf) => {
        const b64 = bytesToBase64(new Uint8Array(buf));
        this.ctx.client.uploadMaster(aspect, faction, variant, channel, b64);
        debug.log(
          ["ui"],
          `[CardEditor] uploaded master ${aspect}/${faction}/${variant}.${channel}.png (${blob.size}b)`,
          2,
        );
      });
    }, "image/png");
  }

  // ── per-primitive edit controls ─────────────────────────────────────
  /** Rebuild the DOM edit controls for the selected primitive's kind. Called on
   *  selection change (not on each edit) so an in-progress field keeps focus. */
  private buildControls(): void {
    this.editControls.replaceChildren();
    const node = this.selected;
    if (!node) return;
    switch (node.kind) {
      case "text":
        this.addRow("Text", this.textInput(node.text ?? "", (v) => { node.text = v; this.onEdit(); }));
        break;
      case "rect":
      case "hex":
        this.addRow("Color", this.colorInput(node.tint ?? 0xffffff, (v) => { node.tint = v; this.onEdit(); }));
        this.addRow("Pos X", this.numberInput(node.pos.x, (v) => { node.pos.x = v; this.onEdit(); }));
        this.addRow("Pos Y", this.numberInput(node.pos.y, (v) => { node.pos.y = v; this.onEdit(); }));
        this.addRow("Width", this.numberInput(node.size.x, (v) => { node.size.x = v; this.onEdit(); }));
        this.addRow("Height", this.numberInput(node.size.y, (v) => { node.size.y = v; this.onEdit(); }));
        break;
      case "progress":
        this.addRow("Style", this.numberInput(node.style ?? 1, (v) => { node.style = v; this.onEdit(); }));
        break;
      case "sprite":
        this.addRow("Texture", this.textInput(node.texture?.name ?? "", (v) => {
          node.texture = { name: v, index: node.texture?.index };
          this.onEdit();
        }, false));
        // Variant index: 1-based pin; 0/empty → unset, so the card seed picks it.
        this.addRow("Index", this.numberInput(node.texture?.index ?? 0, (v) => {
          node.texture = { name: node.texture?.name ?? "", index: v > 0 ? v : undefined };
          this.onEdit();
        }));
        this.addRow("Pos X", this.numberInput(node.pos.x, (v) => { node.pos.x = v; this.onEdit(); }));
        this.addRow("Pos Y", this.numberInput(node.pos.y, (v) => { node.pos.y = v; this.onEdit(); }));
        this.addRow("Width", this.numberInput(node.size.x, (v) => { node.size.x = v; this.onEdit(); }));
        this.addRow("Height", this.numberInput(node.size.y, (v) => { node.size.y = v; this.onEdit(); }));
        break;
      case "light": {
        // Same variables as the cursor light: position, colour, height, radius,
        // intensity. Edits relight the preview (no full relayout — keeps focus).
        const lt = (node.light ??= { height: 0, radius: 0, intensity: 1 });
        this.addRow("Pos X", this.numberInput(node.pos.x, (v) => { node.pos.x = v; this.onLightEdit(); }));
        this.addRow("Pos Y", this.numberInput(node.pos.y, (v) => { node.pos.y = v; this.onLightEdit(); }));
        this.addRow("Color", this.colorInput(node.tint ?? 0xffffff, (v) => { node.tint = v; this.onLightEdit(); }));
        this.addRow("Height", this.numberInput(lt.height, (v) => { lt.height = v; this.onLightEdit(); }));
        this.addRow("Radius", this.numberInput(lt.radius, (v) => { lt.radius = v; this.onLightEdit(); }));
        this.addRow("Intensity", this.numberInput(lt.intensity, (v) => { lt.intensity = v; this.onLightEdit(); }));
        // Editor-authored prim → removable; the DSL region regenerates without it.
        this.addRow("", this.actionButton("Remove", () => this.removeSelectedPrim()));
        break;
      }
    }
  }

  /** A field changed — re-render the card copy + the selection views from the
   *  mutated working list. Does NOT rebuild controls (keeps input focus). */
  private onEdit(): void {
    this.redrawCard();
    this.relayout();
  }

  /** Remove the selected primitive from the working list (only offered for
   *  editor-authored prims, e.g. lights). Re-syncs the DSL region + preview. */
  private removeSelectedPrim(): void {
    const i = this.selectedIndex;
    if (i < 0 || i >= this.workingList.length) return;
    this.workingList.splice(i, 1);
    this.selectedIndex = Math.min(i, this.workingList.length - 1);
    this.populateSelect();
    this.select.selectedIndex = this.selectedIndex;
    this.buildControls();
    this.redrawCard();
    this.relayout();
    this.syncLightsToDsl();
  }

  /** A fixed-width action button styled like the number inputs. */
  private actionButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    Object.assign(btn.style, INPUT_CSS, { width: "84px", cursor: "pointer" });
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  private addRow(label: string, input: HTMLElement): void {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const lbl = document.createElement("span");
    Object.assign(lbl.style, CTRL_LABEL_CSS);
    lbl.textContent = label;
    row.appendChild(lbl);
    row.appendChild(input);
    this.editControls.appendChild(row);
  }

  /** `fill` (default) stretches the input to the row width — for free-form text
   *  like a primitive's `text`. Pass `false` for a fixed width matching the
   *  number inputs (the sprite Texture field). */
  private textInput(value: string, onChange: (v: string) => void, fill = true): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    Object.assign(input.style, INPUT_CSS, fill ? { flex: "1 1 auto", minWidth: "0" } : { width: "84px" });
    input.value = value;
    input.addEventListener("input", () => onChange(input.value));
    return input;
  }

  private numberInput(value: number, onChange: (v: number) => void): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "number";
    Object.assign(input.style, INPUT_CSS, { width: "84px" });
    input.value = String(value);
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      if (!Number.isNaN(v)) onChange(v);
    });
    return input;
  }

  private colorInput(value: number, onChange: (v: number) => void): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "color";
    Object.assign(input.style, INPUT_CSS, { width: "48px", height: "24px", padding: "0" });
    input.value = hexColor(value);
    input.addEventListener("input", () => onChange(parseInt(input.value.slice(1), 16)));
    return input;
  }

  // ── DOM positioning / visibility ────────────────────────────────────
  private positionSelect(): void {
    const g = this.geom;
    if (!g) return;
    // `content` (padding 0) sits at the body rect; content-local maps to body
    // viewport coords. Both DOM widgets are position:fixed → viewport coords.
    const body = this.bodyRect;
    const primX = g.squares.find((s) => s.kind === "prim")?.x ?? 0;
    this.select.style.left = `${body.left + primX}px`;
    this.select.style.top = `${body.top + g.rowY}px`;
    this.select.style.width = `${g.side}px`;
  }

  private positionControls(): void {
    const g = this.geom;
    if (!g) return;
    const body = this.bodyRect;
    this.editControls.style.left = `${body.left + PAD}px`;
    this.editControls.style.top = `${body.top + g.controlsY}px`;
    this.editControls.style.width = `${Math.max(0, body.width - 2 * PAD)}px`;
    this.editControls.style.height = `${Math.max(0, body.height - g.controlsY - PAD)}px`;
  }

  /** Place the side sections + save button. The 💾 sits at the top-right of the
   *  body (over the right column); the art tools shift down below it, leaving the
   *  top-right strip free for a few more tools later. */
  private positionSideSections(): void {
    const g = this.geom;
    if (!g) return;
    const body = this.bodyRect;
    place(this.leftSection, body.left + g.leftCol.x, body.top + g.bigY, g.leftCol.w, g.bigSide);
    // Top-right button strip (right-aligned): … undo redo save.
    const right = g.rightCol.x + g.rightCol.w;
    const y = body.top + g.bigY;
    const saveX = right - SAVE_BTN;
    const redoX = saveX - BTN_GAP - SAVE_BTN;
    const undoX = redoX - BTN_GAP - SAVE_BTN;
    place(this.undoBtn, body.left + undoX, y, SAVE_BTN, SAVE_BTN);
    place(this.redoBtn, body.left + redoX, y, SAVE_BTN, SAVE_BTN);
    place(this.saveBtn, body.left + saveX, y, SAVE_BTN, SAVE_BTN);
    // Art tools below the button strip.
    const artY = g.bigY + SAVE_BTN + PAD;
    place(this.artTools.element, body.left + g.rightCol.x, body.top + artY, g.rightCol.w, Math.max(0, g.bigSide - SAVE_BTN - PAD));
  }

  private syncDomVisibility(): void {
    const open = this.isOpen && !this.isMinimized;
    const hasList = open && this.workingList.length > 0;
    this.select.style.display = hasList ? "" : "none";
    this.editControls.style.display = hasList && this.editControls.childElementCount > 0 ? "" : "none";
    // Left section + save button are ALWAYS visible while the panel is open; art
    // tools only for a sprite selection.
    this.leftSection.style.display = open ? "flex" : "none";
    const btns = open ? "" : "none";
    this.undoBtn.style.display = btns;
    this.redoBtn.style.display = btns;
    this.saveBtn.style.display = btns;
    // Art tools + paint overlay are available whenever the card has a paintable
    // sprite (the pinned preview) — not tied to the selection.
    const paintable = open && !!this.previewSpriteNode;
    this.artTools.element.style.display = paintable ? "flex" : "none";
    this.paintOverlay.style.display = paintable ? "" : "none";
  }

  override destroy(): void {
    this.unsubRelayout();
    this.unsubVis();
    this.unsubVis2();
    this.select.remove();
    this.editControls.remove();
    this.leftSection.remove();
    this.undoBtn.remove();
    this.redoBtn.remove();
    this.saveBtn.remove();
    this.paintOverlay.remove();
    this.paint.clear();
    this.litTexture?.destroy(true);
    this.artTools.destroy();
    this.bigFace.destroy();
    this.smallFace.destroy();
    super.destroy();
  }
}

/** A square fixed-positioned top-right toolbar button (undo / redo / save). */
function topButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = icon;
  btn.title = title;
  Object.assign(btn.style, {
    position: "fixed",
    zIndex: "31",
    pointerEvents: "auto",
    display: "none",
    background: "rgba(30, 33, 42, 0.98)",
    border: "1px solid #3a3a4a",
    borderRadius: "3px",
    color: "#ecd6aa",
    cursor: "pointer",
    fontSize: "16px",
    padding: "0",
    lineHeight: "1",
  } satisfies Partial<CSSStyleDeclaration>);
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  btn.addEventListener("click", onClick);
  return btn;
}

/** Enable/disable a toolbar button (dim + ignore clicks when disabled). */
function setButtonEnabled(btn: HTMLButtonElement, enabled: boolean): void {
  btn.disabled = !enabled;
  btn.style.opacity = enabled ? "1" : "0.4";
  btn.style.cursor = enabled ? "pointer" : "default";
}

/** Read a canvas's pixels for lighting (`null` when absent). Same-origin canvas
 *  (we created it), so no taint. */
function canvasData(canvas: HTMLCanvasElement | null): ImageData | null {
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  return ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
}

/** Read a (master) texture's pixels by drawing its source image into a scratch
 *  canvas — for the paint bucket to flood-fill against a channel with no editable
 *  copy yet (diffuse, or an unpainted albedo/normal/emissive). */
function textureData(tex: Texture): ImageData | null {
  const src = tex.source;
  const w = src.pixelWidth || tex.width;
  const h = src.pixelHeight || tex.height;
  const resource = src.resource as CanvasImageSource | undefined;
  if (!resource || w <= 0 || h <= 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(resource, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Set a fixed-positioned DOM element's viewport rect. */
function place(el: HTMLElement, left: number, top: number, w: number, h: number): void {
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
}

/** Build a fixed-positioned tabbed section: a tab bar over a stack of panes,
 *  one visible at a time. Panes start empty (content TBD). */
function buildTabbedSection(labels: string[]): { root: HTMLDivElement; panes: HTMLDivElement[] } {
  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "fixed",
    zIndex: "30",
    pointerEvents: "auto",
    display: "none",
    flexDirection: "column",
    boxSizing: "border-box",
    overflow: "hidden",
    background: "rgba(20, 22, 30, 0.98)",
    border: "1px solid #3a3a4a",
    borderRadius: "4px",
    fontFamily: "sans-serif",
    fontSize: "12px",
    color: "#ecd6aa",
  } satisfies Partial<CSSStyleDeclaration>);
  root.addEventListener("pointerdown", (e) => e.stopPropagation());

  const tabBar = document.createElement("div");
  Object.assign(tabBar.style, { display: "flex", flex: "0 0 auto", borderBottom: "1px solid #3a3a4a" });
  const tabs: HTMLButtonElement[] = [];
  const panes: HTMLDivElement[] = [];
  labels.forEach((label, i) => {
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      flex: "1 1 0", background: "none", border: "none", borderRight: i < labels.length - 1 ? "1px solid #3a3a4a" : "none",
      color: "#a0a0b0", cursor: "pointer", padding: "6px 4px", fontFamily: "sans-serif", fontSize: "12px",
    } satisfies Partial<CSSStyleDeclaration>);
    btn.textContent = label;
    const pane = document.createElement("div");
    Object.assign(pane.style, { flex: "1 1 auto", overflowY: "auto", padding: "8px", display: i === 0 ? "block" : "none" });
    btn.addEventListener("click", () => {
      panes.forEach((p, j) => { p.style.display = j === i ? "block" : "none"; });
      tabs.forEach((t, j) => { t.style.color = j === i ? "#ecd6aa" : "#a0a0b0"; });
    });
    tabs.push(btn);
    panes.push(pane);
    tabBar.appendChild(btn);
  });
  tabs[0].style.color = "#ecd6aa";
  root.appendChild(tabBar);
  for (const p of panes) root.appendChild(p);
  return { root, panes };
}

/** Extract a card's `::<key>>` block from one `.rd` source — only within a
 *  `<card>` bucket (so a same-named `<recipe>`/`<blueprint>` def can't shadow
 *  it). The block runs from `::key>` to the next sibling `::` def or bucket. */
function extractCardBlock(text: string, key: string): string | null {
  const lines = text.split("\n");
  let inCard = false;
  let start = -1;
  let blockIndent = 0;
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    const bucket = /^<([a-z_]+)>/.exec(trimmed);
    if (bucket) {
      if (start >= 0) break; // a new bucket ends the block
      inCard = bucket[1] === "card";
      continue;
    }
    if (!inCard) continue;
    const def = /^::([A-Za-z0-9_.]+)>/.exec(trimmed);
    if (start < 0) {
      if (def && def[1] === key) { start = 0; blockIndent = indent; out.push(line); }
    } else if (def && indent <= blockIndent) {
      break; // next sibling def ends the block
    } else {
      out.push(line);
    }
  }
  if (start < 0) return null;
  // Drop trailing blank / comment lines (a comment block usually documents the
  // NEXT def, not this one).
  while (out.length && (out[out.length - 1].trim() === "" || out[out.length - 1].trim().startsWith(";"))) out.pop();
  return out.join("\n");
}

/** Flatten a locale subtree (`{label, description:{simple}}`) to `path: value`
 *  lines. */
function flattenLocale(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [`${prefix}: ${String(obj)}`];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out.push(...flattenLocale(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** `0xRRGGBB` → `#rrggbb` for an `<input type="color">`. */
function hexColor(tint: number): string {
  return `#${((tint >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** Padding (px) left around a sprite inside its channel square. */
const SQUARE_PAD = 8;

/** Placement of a texture scaled to FIT entirely inside the `(x, y, side)`
 *  square — aspect preserved, centred, with `SQUARE_PAD` margin. Returns the
 *  display origin + size + per-texel scale (the brush surface mapping reuses it). */
function fitPlacement(tex: Texture, x: number, y: number, side: number): { ox: number; oy: number; w: number; h: number; scale: number } {
  const avail = Math.max(1, side - 2 * SQUARE_PAD);
  const tw = tex.width || 1;
  const th = tex.height || 1;
  const scale = Math.min(avail / tw, avail / th);
  const w = tw * scale;
  const h = th * scale;
  return { ox: x + (side - w) / 2, oy: y + (side - h) / 2, w, h, scale };
}
