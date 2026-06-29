import { Graphics, Text } from "pixi.js";
import { LayoutNode } from "../../layout/LayoutNode";
import type { GameContext } from "../../../GameContext";
import type { CardDefinition } from "../../definitions/DefinitionManager";
import { NOTO_EMOJI_FAMILY } from "../../../assets/fonts";
import { panelText } from "../panelStrings";
import { WORLD_LAYER, INVENTORY_LAYER } from "../../../server/data/packing";

/** Surface band → human label for the location subtitle. */
function surfaceLabel(surface: number): string {
  if (surface === WORLD_LAYER) return "world";
  if (surface === INVENTORY_LAYER) return "inventory";
  return `surface ${surface}`;
}

/// Neutral grey fallback when an aspect has no color (shouldn't
/// happen — the registry enforces a color on every aspect — but kept
/// as a defensive value so a stale aspectInfo lookup doesn't render
/// black).
const FALLBACK_PIP_COLOR = 0x556677;

// ── Per-pip display data ───────────────────────────────────────────────────────
interface PipData {
  aspectId: number;
  value: number;
  icon: string;
  /** Background fill colour from `AspectInfo.color`. Sub-aspects
   *  inherit their parent's colour via the registry, so an entire
   *  family renders with one hue without per-leaf wiring here. */
  color: number;
}

// ── Layout constants ──────────────────────────────────────────────────────────
const WIDTH           = 320;
const PADDING         = 8;

const NAME_FONT_SIZE  = 13;
const NAME_Y          = 8;
const NAME_H          = NAME_FONT_SIZE + 6;   // single-line name area

/** Optional world-coord label shown to the RIGHT of the name on the same line
 *  (right-aligned), so it costs no vertical space. Hidden when `coords === null`. */
const COORDS_FONT_SIZE = 10;

const PIP_SIZE        = 44;
const PIP_GAP         = 6;
const PIP_SLOT        = PIP_SIZE + PIP_GAP;
const PIP_ICON_FONT   = 20;
const PIP_VALUE_FONT  = 9;

// Feature pips render in their own smaller row directly UNDER the main
// aspect row — both are visible in the compact panel (no expand needed).
// Smaller so they read as secondary information.
const FEATURE_PIP_SIZE   = 28;
const FEATURE_PIP_GAP    = 4;
const FEATURE_PIP_SLOT   = FEATURE_PIP_SIZE + FEATURE_PIP_GAP;
const FEATURE_PIP_ICON_FONT  = 14;
const FEATURE_PIP_VALUE_FONT = 8;

const PIPS_Y          = NAME_Y + NAME_H + 6;  // top of the main pip row
const FEATURE_PIPS_Y  = PIPS_Y + PIP_SIZE + 6;    // feature row, directly below

const TOGGLE_H        = 20;
const COMPACT_HEIGHT  = FEATURE_PIPS_Y + FEATURE_PIP_SIZE + 6 + TOGGLE_H;
const COMPACT_BODY_BOTTOM = COMPACT_HEIGHT - TOGGLE_H;

const DESC_HEADER_Y   = COMPACT_BODY_BOTTOM + 6;
const DESC_HEADER_H   = 14;
const DESC_Y          = DESC_HEADER_Y + DESC_HEADER_H + 4;
const DESC_FONT       = 12;
const DESC_LINE_H     = 17;
const EXPANDED_HEIGHT = 310;
const EXPANDED_BODY_BOTTOM = EXPANDED_HEIGHT - TOGGLE_H;

const MAX_PIPS         = 20;
const MAX_FEATURE_PIPS = 10;

// ── ToggleButton ──────────────────────────────────────────────────────────────
class ToggleButton extends LayoutNode {
  private readonly bg = new Graphics();
  private readonly chevron: Text;
  private _expanded = false;

  constructor() {
    super();
    this.container.addChild(this.bg);
    this.chevron = new Text({
      text: "▼",
      style: { fill: 0xaab5c4, fontFamily: "sans-serif", fontSize: 11 },
    });
    this.chevron.anchor.set(0.5, 0.5);
    this.container.addChild(this.chevron);
  }

  setExpanded(v: boolean): void {
    if (this._expanded === v) return;
    this._expanded = v;
    this.invalidate();
  }

  protected override layout(): void {
    this.bg.clear();
    this.bg.rect(0, 0, this.width, this.height).fill({ color: 0x12161b });
    this.chevron.text = this._expanded ? "▲" : "▼";
    this.chevron.position.set(this.width / 2, this.height / 2);
  }
}

// ── DetailsPanel ──────────────────────────────────────────────────────────────
interface Pip {
  gfx: Graphics;
  iconText: Text;
  valueText: Text;
}

/**
 * Details panel. Sits to the left of the inventory and shows information
 * about the last-clicked card.
 *
 * Compact mode: card name + aspect pips (single horizontal row, NotoEmoji
 * icons centred, value at bottom-right of each square).
 * Expanded mode: same header + full text description.
 *
 * In the `view` rebuild it's fed packed-definition-first
 * (`showByPackedDefinition`) from the world scene's click handler — the
 * selection already carries the packed def + world hex, so the panel
 * doesn't need a card-row mirror. Stock-derived pips are surfaced when
 * the caller passes the per-slot counts.
 */
export class DetailsPanel extends LayoutNode {
  static readonly WIDTH           = WIDTH;
  static readonly COMPACT_HEIGHT  = COMPACT_HEIGHT;
  static readonly EXPANDED_HEIGHT = EXPANDED_HEIGHT;

  private _isVisible = false;
  private _expanded  = false;

  /** Subscribers fired on every `_isVisible` flip. The host panel
   *  wrapper listens so it opens / closes in lockstep with `show()` /
   *  `hide()` calls. */
  private readonly visibilityListeners = new Set<(visible: boolean) => void>();
  /** Subscribers fired whenever `currentHeight` changes — visibility
   *  flips (0 ↔ COMPACT_HEIGHT) AND expand toggles (COMPACT_HEIGHT ↔
   *  EXPANDED_HEIGHT). The host panel uses this to drive an `"auto"`
   *  heightMode: push `currentHeight` in and it resizes to wrap. */
  private readonly sizeChangeListeners = new Set<(height: number) => void>();

  private cardName    = "";
  private def: CardDefinition | null = null;
  private description = "";
  private pipData: PipData[] = [];
  /** Same shape as `pipData` but for feature-category entries —
   *  rendered in a smaller second row, expanded-only. */
  private featurePipData: PipData[] = [];
  /** World hex (q, r) for cards / tiles on a world surface. `null` for
   *  inventory cards and any call site that didn't supply a position.
   *  Rendered as a small subtitle under the card name. */
  private coords: { surface: number; q: number; r: number } | null = null;
  /** The card_id of the selected card, shown as `#<hex>` to the right of the
   *  name (so commands can address it without a lookup). `null` for tiles / any
   *  call site that didn't supply one — the id label is then hidden. */
  private cardId: number | null = null;

  private readonly bg              = new Graphics();
  private readonly nameText:       Text;
  private readonly idText:         Text;
  private readonly coordsText:     Text;
  private readonly pips:           Pip[];
  private readonly featurePips:    Pip[];
  private readonly dividerGfx      = new Graphics();
  private readonly descHeaderText: Text;
  private readonly descText:       Text;
  readonly toggleButton: ToggleButton;

  get currentHeight(): number {
    if (!this._isVisible) return 0;
    return this._expanded ? EXPANDED_HEIGHT : COMPACT_HEIGHT;
  }

  get isVisible(): boolean { return this._isVisible; }

  constructor() {
    super();
    this.container.visible = false;
    this.container.addChild(this.bg);

    this.nameText = new Text({
      text: "",
      style: {
        fill: 0xecd6aa,
        fontFamily: "sans-serif",
        fontSize: NAME_FONT_SIZE,
        fontWeight: "700",
        wordWrap: true,
        wordWrapWidth: WIDTH - PADDING * 2,
      },
    });
    this.nameText.anchor.set(0, 0);
    this.container.addChild(this.nameText);

    // Card id (`#<hex>`), to the RIGHT of the name on the same line — same
    // colour/size/style as the coords label, so they read as one meta row
    // (`Corpus #403   world (2, 4)`). Left-anchored; positioned after the name.
    this.idText = new Text({
      text: "",
      style: {
        fill: 0x778899,
        fontFamily: "sans-serif",
        fontSize: COORDS_FONT_SIZE,
        fontStyle: "italic",
      },
    });
    this.idText.anchor.set(0, 0);
    this.idText.visible = false;
    this.container.addChild(this.idText);

    this.coordsText = new Text({
      text: "",
      style: {
        fill: 0x778899,
        fontFamily: "sans-serif",
        fontSize: COORDS_FONT_SIZE,
        fontStyle: "italic",
      },
    });
    this.coordsText.anchor.set(1, 0); // right-aligned — sits at the panel's right edge
    this.coordsText.visible = false;
    this.container.addChild(this.coordsText);

    // Pip pool — one row of squares, each with a centred emoji and a
    // small value number at the bottom-right corner.
    this.pips = Array.from({ length: MAX_PIPS }, (): Pip => {
      const gfx = new Graphics();
      gfx.visible = false;

      const iconText = new Text({
        text: "",
        style: {
          fill: 0xffffff,
          fontFamily: NOTO_EMOJI_FAMILY,
          fontSize: PIP_ICON_FONT,
        },
      });
      iconText.anchor.set(0.5, 0.5);
      iconText.visible = false;

      const valueText = new Text({
        text: "",
        style: {
          fill: 0xffffff,
          fontFamily: "sans-serif",
          fontSize: PIP_VALUE_FONT,
          fontWeight: "700",
        },
      });
      valueText.anchor.set(1, 1);
      valueText.visible = false;

      this.container.addChild(gfx);
      this.container.addChild(iconText);
      this.container.addChild(valueText);
      return { gfx, iconText, valueText };
    });

    // Feature pip pool — smaller squares, rendered in their own row
    // below the divider, expanded-only.
    this.featurePips = Array.from({ length: MAX_FEATURE_PIPS }, (): Pip => {
      const gfx = new Graphics();
      gfx.visible = false;

      const iconText = new Text({
        text: "",
        style: {
          fill: 0xffffff,
          fontFamily: NOTO_EMOJI_FAMILY,
          fontSize: FEATURE_PIP_ICON_FONT,
        },
      });
      iconText.anchor.set(0.5, 0.5);
      iconText.visible = false;

      const valueText = new Text({
        text: "",
        style: {
          fill: 0xffffff,
          fontFamily: "sans-serif",
          fontSize: FEATURE_PIP_VALUE_FONT,
          fontWeight: "700",
        },
      });
      valueText.anchor.set(1, 1);
      valueText.visible = false;

      this.container.addChild(gfx);
      this.container.addChild(iconText);
      this.container.addChild(valueText);
      return { gfx, iconText, valueText };
    });

    this.container.addChild(this.dividerGfx);

    this.descHeaderText = new Text({
      text: panelText("gameDetailsPanel", "descriptionHeader"),
      style: {
        fill: 0x778899,
        fontFamily: "sans-serif",
        fontSize: 10,
        fontStyle: "italic",
      },
    });
    this.descHeaderText.anchor.set(0, 0);
    this.container.addChild(this.descHeaderText);

    this.descText = new Text({
      text: "",
      style: {
        fill: 0xc0c8d8,
        fontFamily: "sans-serif",
        fontSize: DESC_FONT,
        lineHeight: DESC_LINE_H,
        wordWrap: true,
        wordWrapWidth: WIDTH - PADDING * 2,
      },
    });
    this.descText.anchor.set(0, 0);
    this.container.addChild(this.descText);

    this.toggleButton = new ToggleButton();
    this.addChild(this.toggleButton);
  }

  /** Open the panel for a `packedDefinition` — the view's entry point.
   *  The world-scene click handler resolves the packed def (+ optional
   *  world hex) off the selection and hands it here; the panel body
   *  (name, aspects, description) only depends on the def.
   *
   *  `stockValues` carries the current per-slot stock counters
   *  (indexed by `def.stock` slot order — `stockValues[0]` ↔
   *  `def.stock[0]`). When provided, stock-derived pips display the
   *  current value and are omitted entirely for slots whose current
   *  count is 0. When absent, no stock pips are shown. */
  showByPackedDefinition(
    packedDefinition: number,
    ctx: GameContext,
    stockValues?: readonly number[],
    location?: { surface: number; q: number; r: number } | null,
    cardId?: number | null,
  ): void {
    this.def      = ctx.definitions.decode(packedDefinition);
    this.cardName = ctx.definitions.label(packedDefinition);
    this.coords   = location ?? null;
    this.cardId   = cardId ?? null;
    this.description = ctx.definitions.description(packedDefinition);

    // Static aspects + stock-slot aspects. Stock pips show the current
    // per-slot count (from `stockValues`) and are omitted when that
    // count is 0. Dedupe by aspectId first-wins so a def that still
    // declares both renders once.
    //
    // Visibility (the card's per-aspect level): 1 → main pip row (always);
    // 2 → the smaller feature row (expanded only); 0 → hidden, skipped.
    const aspectPips: PipData[] = [];
    const featurePips: PipData[] = [];
    const seen = new Set<number>();
    const push = (aspectId: number, value: number, visibility: number): void => {
      if (seen.has(aspectId)) return;
      seen.add(aspectId);
      if (visibility === 0) return;
      const info = ctx.definitions.aspectInfo(aspectId);
      if (!info) return;
      const pip: PipData = {
        aspectId,
        value,
        icon:  info.icon  || "?",
        color: info.color || FALLBACK_PIP_COLOR,
      };
      (visibility === 2 ? featurePips : aspectPips).push(pip);
    };
    for (const [aspectId, value, visibility] of this.def?.aspects ?? []) push(aspectId, value, visibility);
    if (stockValues) {
      const slots = this.def?.stock ?? [];
      for (let i = 0; i < slots.length; i++) {
        const current = stockValues[i] ?? 0;
        if (current === 0) continue;
        push(slots[i].aspectId, current, slots[i].visibility);
      }
    }
    this.pipData = aspectPips;
    this.featurePipData = featurePips;

    this.setVisible(true);
    this.parent?.invalidate();
    this.invalidate();
  }

  hide(): void {
    if (!this._isVisible) return;
    this.setVisible(false);
    this.parent?.invalidate();
  }

  /** Internal helper that flips `_isVisible` + the Pixi container's
   *  visibility AND notifies subscribers. */
  private setVisible(visible: boolean): void {
    if (this._isVisible === visible) return;
    this._isVisible = visible;
    this.container.visible = visible;
    for (const cb of this.visibilityListeners) {
      try { cb(visible); }
      catch (err) { console.error("[DetailsPanel] visibility listener threw", err); }
    }
    this.fireSizeChange();
  }

  /** Fire `sizeChangeListeners` with the current natural height. */
  private fireSizeChange(): void {
    const h = this.currentHeight;
    for (const cb of this.sizeChangeListeners) {
      try { cb(h); }
      catch (err) { console.error("[DetailsPanel] size-change listener threw", err); }
    }
  }

  /** Subscribe to visibility flips. Fires synchronously on every
   *  `show()` / `hide()`. Returns an unsubscribe fn. */
  onVisibilityChange(cb: (visible: boolean) => void): () => void {
    this.visibilityListeners.add(cb);
    return () => this.visibilityListeners.delete(cb);
  }

  /** Subscribe to `currentHeight` changes — visibility flips +
   *  compact / expanded toggles. Returns an unsubscribe fn. */
  onSizeChange(cb: (height: number) => void): () => void {
    this.sizeChangeListeners.add(cb);
    return () => this.sizeChangeListeners.delete(cb);
  }

  handleClick(hit: LayoutNode | null): boolean {
    if (!this._isVisible) return false;
    if (hit === this.toggleButton) {
      this._expanded = !this._expanded;
      this.toggleButton.setExpanded(this._expanded);
      this.parent?.invalidate();
      this.invalidate();
      // `currentHeight` jumped between COMPACT and EXPANDED — let
      // anyone tracking natural height resize accordingly.
      this.fireSizeChange();
      return true;
    }
    let node: LayoutNode | null = hit;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }

  protected override layout(): void {
    if (!this._isVisible) return;

    const h = this._expanded ? EXPANDED_HEIGHT : COMPACT_HEIGHT;

    this.bg.clear();
    this.bg.rect(0, 0, WIDTH, h).fill({ color: 0x1a1f24 });
    this.bg.rect(WIDTH - 1, 0, 1, h).fill({ color: 0x2a2f36 });

    // ── Card name ─────────────────────────────────────────────────────
    this.nameText.text = this.cardName;
    this.nameText.position.set(PADDING, NAME_Y);

    // ── Card id (`#<hex>`) — right of the name, same style as coords ──
    if (this.cardId !== null) {
      this.idText.text = `#${this.cardId.toString(16)}`;
      // Sit just after the name; nudged down to baseline-align with the larger
      // name font (same offset the coords label uses).
      this.idText.position.set(this.nameText.x + this.nameText.width + 6, NAME_Y + 2);
      this.idText.visible = true;
    } else {
      this.idText.visible = false;
    }

    // ── World coords (cards / tiles on a world surface) ───────────────
    if (this.coords !== null) {
      this.coordsText.text = `${surfaceLabel(this.coords.surface)} (${this.coords.q}, ${this.coords.r})`;
      // Right-aligned on the name's line; nudged down to baseline-align with the
      // larger name font.
      this.coordsText.position.set(WIDTH - PADDING, NAME_Y + 2);
      this.coordsText.visible = true;
    } else {
      this.coordsText.visible = false;
    }

    // ── Aspect pips — single left-to-right row ────────────────────────
    const count = Math.min(this.pipData.length, MAX_PIPS);

    for (let i = 0; i < MAX_PIPS; i++) {
      const { gfx, iconText, valueText } = this.pips[i];
      if (i >= count) {
        gfx.visible       = false;
        iconText.visible  = false;
        valueText.visible = false;
        continue;
      }
      const { value, icon, color } = this.pipData[i];
      const x = PADDING + i * PIP_SLOT;
      const y = PIPS_Y;

      gfx.clear();
      gfx.rect(x, y, PIP_SIZE, PIP_SIZE).fill({ color });
      gfx.rect(x, y, PIP_SIZE, PIP_SIZE).stroke({ color: 0xffffff, width: 0.5, alpha: 0.2 });
      gfx.visible = true;

      iconText.text = icon;
      iconText.position.set(x + PIP_SIZE / 2, y + PIP_SIZE / 2);
      iconText.visible = true;

      valueText.text = String(value);
      valueText.position.set(x + PIP_SIZE - 2, y + PIP_SIZE - 2);
      valueText.visible = true;
    }

    // ── Divider (expanded only) ───────────────────────────────────────
    this.dividerGfx.clear();
    if (this._expanded) {
      this.dividerGfx
        .rect(PADDING, COMPACT_BODY_BOTTOM, WIDTH - PADDING * 2, 1)
        .fill({ color: 0x2a2f36 });
    }

    // ── Feature pips — secondary row, always shown under the aspects ──
    const featureCount = Math.min(this.featurePipData.length, MAX_FEATURE_PIPS);
    for (let i = 0; i < MAX_FEATURE_PIPS; i++) {
      const { gfx, iconText, valueText } = this.featurePips[i];
      if (i >= featureCount) {
        gfx.visible       = false;
        iconText.visible  = false;
        valueText.visible = false;
        continue;
      }
      const { value, icon, color } = this.featurePipData[i];
      const x = PADDING + i * FEATURE_PIP_SLOT;
      const y = FEATURE_PIPS_Y;

      gfx.clear();
      gfx.rect(x, y, FEATURE_PIP_SIZE, FEATURE_PIP_SIZE).fill({ color });
      gfx.rect(x, y, FEATURE_PIP_SIZE, FEATURE_PIP_SIZE)
        .stroke({ color: 0xffffff, width: 0.5, alpha: 0.2 });
      gfx.visible = true;

      iconText.text = icon;
      iconText.position.set(x + FEATURE_PIP_SIZE / 2, y + FEATURE_PIP_SIZE / 2);
      iconText.visible = true;

      // Hide the value badge when it's the trivial "1" — most feature
      // entries are presence markers (`inventory: 1`, `faction.chorus:
      // 1`); the visible icon already conveys "carried".
      if (value === 1) {
        valueText.visible = false;
      } else {
        valueText.text = String(value);
        valueText.position.set(
          x + FEATURE_PIP_SIZE,
          y + FEATURE_PIP_SIZE,
        );
        valueText.visible = true;
      }
    }

    // ── Description (expanded only) ───────────────────────────────────
    const showDesc = this._expanded;
    this.descHeaderText.visible = showDesc;
    this.descText.visible       = showDesc;
    if (showDesc) {
      this.descHeaderText.position.set(PADDING, DESC_HEADER_Y);
      this.descText.text = this.description.length > 0
        ? this.description
        : "No description available.";
      this.descText.position.set(PADDING, DESC_Y);
      void (EXPANDED_BODY_BOTTOM - DESC_Y); // available height for future clamp
    }

    // ── Toggle button ─────────────────────────────────────────────────
    const toggleY = h - TOGGLE_H;
    this.toggleButton.setBounds(0, toggleY, WIDTH, TOGGLE_H);
    this.toggleButton.layoutIfDirty();
  }
}
