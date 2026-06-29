//! Art-tools toolbar for the Card Editor — shown beside the large card preview
//! when a `sprite` primitive is selected. Pure DOM widget: it owns its tool
//! state (primary/secondary colour, active tool, brush size, shape, layer) and
//! its element; the host panel positions `element` and toggles its visibility.
//!
//! The painting/sampling integration (pipette reads a pixel into primary on
//! left-click / secondary on right-click; brush strokes onto the active layer)
//! lands once there's an editable paint surface — for now this exposes the tool
//! state those handlers will read.

import type { BrushShape } from "./brush";

export type ArtTool = "brush" | "erase" | "bucket" | "pan" | "light";
export type ArtLayer = "albedo" | "normal" | "emissive";

const PANEL_CSS: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  zIndex: "30",
  pointerEvents: "auto", // re-enable over the pointer-events:none panel
  display: "none",
  flexDirection: "column",
  gap: "8px",
  padding: "8px",
  boxSizing: "border-box",
  overflowY: "auto",
  background: "rgba(20, 22, 30, 0.98)",
  border: "1px solid #3a3a4a",
  borderRadius: "4px",
  fontFamily: "sans-serif",
  fontSize: "12px",
  color: "#ecd6aa",
};
const HEADING_CSS: Partial<CSSStyleDeclaration> = {
  color: "#a0a0b0",
  fontSize: "11px",
  letterSpacing: "0.5px",
  textTransform: "uppercase",
};
const ROW_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
};
const LABEL_CSS: Partial<CSSStyleDeclaration> = {
  flex: "0 0 auto",
  width: "42px",
  color: "#a0a0b0",
};
const BTN_CSS: Partial<CSSStyleDeclaration> = {
  background: "rgba(30, 33, 42, 0.98)",
  border: "1px solid #3a3a4a",
  borderRadius: "3px",
  color: "#ecd6aa",
  cursor: "pointer",
  fontFamily: "sans-serif",
  fontSize: "12px",
  padding: "4px 6px",
  lineHeight: "1",
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
const SWATCH_CSS: Partial<CSSStyleDeclaration> = {
  width: "34px",
  height: "26px",
  padding: "0",
  border: "1px solid #3a3a4a",
  borderRadius: "3px",
  background: "none",
  cursor: "pointer",
};
export class ArtToolsPanel {
  readonly element: HTMLDivElement;

  /** Fill colour applied on a primary (left-click) paint; the pipette samples
   *  into this. `0xRRGGBB`. */
  primary = 0xffffff;
  /** Secondary (right-click) paint / pipette target. */
  secondary = 0x000000;
  /** Active tool (from the Tool dropdown). One option for now. */
  tool: ArtTool = "brush";
  /** Brush radius in texels (the painting pass will read this). */
  brushSize = 4;
  /** Brush footprint shape. */
  shape: BrushShape = "square";
  /** Edge hardness, 0–1: fraction of the radius kept fully opaque before the edge
   *  feathers out (1 = hard edge). */
  hardness = 1;
  /** Stroke opacity, 0–1: the dab's peak alpha — below 1, paint builds up for
   *  blending. */
  opacity = 1;
  /** Paint-bucket fill tolerance, 0–255 per channel. */
  tolerance = 32;
  /** Which channel paints target. More to come (e.g. emissive). */
  layer: ArtLayer = "albedo";

  // Light tool — the variables a placed/cursor light gets. Height is card px;
  // radius is in HEX-TILE units (the world's unit, so the preview matches the
  // game); intensity is unitless. The light's colour is the primary swatch.
  lightHeight = 50;
  lightRadius = 1.5;
  lightIntensity = 1.3;
  /** Whether the preview's default (fixed white) inspection light is active.
   *  Unchecking it previews the card's OWN lights alone. */
  defaultLight = true;
  /** Whether to overlay a red cross at each object primitive's anchor point (its
   *  `0,0`) — an alignment aid. Off by default. */
  showAnchors = false;

  private readonly primaryInput: HTMLInputElement;
  private readonly secondaryInput: HTMLInputElement;
  /** Option rows tagged with the tools they apply to, toggled by {@link refreshRows}. */
  private readonly toolRows: { el: HTMLDivElement; tools: ArtTool[] }[] = [];
  /** Fired when a change should re-light the preview (the default-light toggle). */
  private readonly onLightingChange: () => void;
  /** Fired when the object-centres overlay should be redrawn (its toggle). */
  private readonly onOverlayChange: () => void;

  constructor(opts: { onLightingChange?: () => void; onOverlayChange?: () => void } = {}) {
    this.onLightingChange = opts.onLightingChange ?? (() => {});
    this.onOverlayChange = opts.onOverlayChange ?? (() => {});
    this.element = document.createElement("div");
    Object.assign(this.element.style, PANEL_CSS);
    this.element.addEventListener("pointerdown", (e) => e.stopPropagation());

    this.element.appendChild(heading("Art Tools"));

    // Colours: [primary] [⇄ swap] [secondary].
    this.primaryInput = swatch(this.primary, (v) => { this.primary = v; });
    this.secondaryInput = swatch(this.secondary, (v) => { this.secondary = v; });
    const swap = button("⇄", "Swap primary / secondary", () => this.swap());
    const colorRow = row();
    colorRow.append(this.primaryInput, swap, this.secondaryInput);
    this.element.appendChild(colorRow);

    // Default light — always visible (a preview control, not tool-specific).
    // Uncheck to preview the card's own lights alone.
    const defLight = checkbox("Default light", this.defaultLight, (on) => {
      this.defaultLight = on;
      this.onLightingChange();
    });
    this.element.appendChild(defLight);

    // Object anchors — a red cross at each object prim's anchor point (alignment aid).
    const anchors = checkbox("Object anchors", this.showAnchors, (on) => {
      this.showAnchors = on;
      this.onOverlayChange();
    });
    this.element.appendChild(anchors);

    // Tool — a dropdown (pipette is folded into the colour selectors, so it's
    // not a tool here).
    const toolSel = select(
      [["brush", "Brush"], ["erase", "Erase"], ["bucket", "Bucket"], ["pan", "Pan"], ["light", "Light"]],
      this.tool,
      (v) => { this.tool = v as ArtTool; this.refreshRows(); },
    );
    this.element.appendChild(labelled("Tool", toolSel));

    // Per-tool option rows — only the active tool's are shown (see refreshRows).
    const PAINT: ArtTool[] = ["brush", "erase"];

    // Brush size.
    const sizeInput = numberField(this.brushSize, 1, (v) => { this.brushSize = v; });
    this.addToolRow("Size", sizeInput, PAINT);

    // Shape.
    const shapeSel = select([["square", "Square"], ["round", "Round"]], this.shape, (v) => { this.shape = v as BrushShape; });
    this.addToolRow("Shape", shapeSel, PAINT);

    // Hardness — 0–100% mapped to 0–1 (soft → hard edge).
    const hardInput = numberField(Math.round(this.hardness * 100), 0, (v) => { this.hardness = clamp01(v / 100); }, 100);
    this.addToolRow("Hardness", hardInput, PAINT);

    // Opacity — 0–100% mapped to 0–1 (translucent build-up → solid). The bucket
    // uses it as the fill's flat alpha.
    const opacityInput = numberField(Math.round(this.opacity * 100), 0, (v) => { this.opacity = clamp01(v / 100); }, 100);
    this.addToolRow("Opacity", opacityInput, [...PAINT, "bucket"]);

    // Tolerance — paint-bucket fill spread, 0–255 per channel.
    const tolInput = numberField(this.tolerance, 0, (v) => { this.tolerance = Math.min(255, v); }, 255);
    this.addToolRow("Tolerance", tolInput, ["bucket"]);

    // Layer — paint target channel (paint + bucket).
    const layerSel = select([["albedo", "Albedo"], ["normal", "Normal"], ["emissive", "Emissive"]], this.layer, (v) => {
      this.layer = v as ArtLayer;
    });
    this.addToolRow("Layer", layerSel, ["brush", "erase", "bucket"]);

    // Light — the variables a placed/cursor light gets (height in card px, radius
    // in hex-tile units, intensity unitless; colour is the primary swatch).
    const heightInput = numberField(this.lightHeight, 0, (v) => { this.lightHeight = v; });
    this.addToolRow("Height", heightInput, ["light"]);
    const radiusInput = floatField(this.lightRadius, 0, (v) => { this.lightRadius = v; });
    this.addToolRow("Radius", radiusInput, ["light"]);
    const intensityInput = floatField(this.lightIntensity, 0, (v) => { this.lightIntensity = v; });
    this.addToolRow("Intensity", intensityInput, ["light"]);

    this.refreshRows();
  }

  /** Append a labelled option row tagged with the tools it applies to. */
  private addToolRow(label: string, control: HTMLElement, tools: ArtTool[]): void {
    const el = labelled(label, control);
    this.toolRows.push({ el, tools });
    this.element.appendChild(el);
  }

  /** Show only the active tool's option rows. */
  private refreshRows(): void {
    for (const { el, tools } of this.toolRows) el.style.display = tools.includes(this.tool) ? "flex" : "none";
  }

  private swap(): void {
    [this.primary, this.secondary] = [this.secondary, this.primary];
    this.primaryInput.value = hexColor(this.primary);
    this.secondaryInput.value = hexColor(this.secondary);
  }

  destroy(): void {
    this.element.remove();
  }
}

// ── tiny DOM builders ───────────────────────────────────────────────
function heading(text: string): HTMLDivElement {
  const el = document.createElement("div");
  Object.assign(el.style, HEADING_CSS);
  el.textContent = text;
  return el;
}

function row(): HTMLDivElement {
  const el = document.createElement("div");
  Object.assign(el.style, ROW_CSS);
  return el;
}

function labelled(label: string, control: HTMLElement): HTMLDivElement {
  const r = row();
  const lbl = document.createElement("span");
  Object.assign(lbl.style, LABEL_CSS);
  lbl.textContent = label;
  Object.assign(control.style, { flex: "1 1 auto", minWidth: "0" });
  r.append(lbl, control);
  return r;
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  Object.assign(btn.style, BTN_CSS);
  btn.textContent = text;
  btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

/** A full-width numeric `<input>` accepting integers in `[min, max]`. */
function numberField(value: number, min: number, onChange: (v: number) => void, max?: number): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  if (max !== undefined) input.max = String(max);
  Object.assign(input.style, INPUT_CSS, { width: "100%" });
  input.value = String(value);
  input.addEventListener("input", () => {
    const v = parseInt(input.value, 10);
    if (!Number.isNaN(v) && v >= min) onChange(v);
  });
  return input;
}

/** Like {@link numberField} but accepts fractional values (e.g. light intensity). */
function floatField(value: number, min: number, onChange: (v: number) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.step = "0.1";
  Object.assign(input.style, INPUT_CSS, { width: "100%" });
  input.value = String(value);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    if (!Number.isNaN(v) && v >= min) onChange(v);
  });
  return input;
}

/** A `[✓] label` row; calls `onChange` with the new checked state. */
function checkbox(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLDivElement {
  const r = row();
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  Object.assign(input.style, { flex: "0 0 auto", margin: "0", cursor: "pointer" });
  input.addEventListener("change", () => onChange(input.checked));
  const lbl = document.createElement("label");
  lbl.textContent = label;
  Object.assign(lbl.style, { flex: "1 1 auto", cursor: "pointer", color: "#a0a0b0" });
  lbl.addEventListener("click", () => { input.checked = !input.checked; onChange(input.checked); });
  r.append(input, lbl);
  return r;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function swatch(value: number, onChange: (v: number) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "color";
  Object.assign(input.style, SWATCH_CSS);
  input.value = hexColor(value);
  input.addEventListener("input", () => onChange(parseInt(input.value.slice(1), 16)));
  return input;
}

function select(options: [string, string][], current: string, onChange: (v: string) => void): HTMLSelectElement {
  const sel = document.createElement("select");
  Object.assign(sel.style, INPUT_CSS);
  for (const [value, label] of options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  sel.value = current;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

/** `0xRRGGBB` → `#rrggbb` for an `<input type="color">`. */
function hexColor(tint: number): string {
  return `#${((tint >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`;
}
