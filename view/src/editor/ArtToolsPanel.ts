//! Art-tools toolbar for the Card Editor — shown beside the large card preview
//! when a `sprite` primitive is selected. Pure DOM widget: it owns its tool
//! state (primary/secondary colour, active tool, brush size, shape, layer) and
//! its element; the host panel positions `element` and toggles its visibility.
//!
//! The painting/sampling integration (pipette reads a pixel into primary on
//! left-click / secondary on right-click; brush strokes onto the active layer)
//! lands once there's an editable paint surface — for now this exposes the tool
//! state those handlers will read.

export type ArtTool = "brush" | "pan" | "light";
export type ArtLayer = "albedo" | "normal";

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
  /** Brush footprint shape. One option for now. */
  shape = "square";
  /** Which channel paints target. More to come (e.g. emissive). */
  layer: ArtLayer = "albedo";

  private readonly primaryInput: HTMLInputElement;
  private readonly secondaryInput: HTMLInputElement;

  constructor() {
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

    // Tool — a dropdown (pipette is folded into the colour selectors, so it's
    // not a tool here). One option for now.
    const toolSel = select([["brush", "Brush"], ["pan", "Pan"], ["light", "Light"]], this.tool, (v) => { this.tool = v as ArtTool; });
    this.element.appendChild(labelled("Tool", toolSel));

    // Brush size.
    const sizeInput = document.createElement("input");
    sizeInput.type = "number";
    sizeInput.min = "1";
    Object.assign(sizeInput.style, INPUT_CSS, { width: "100%" });
    sizeInput.value = String(this.brushSize);
    sizeInput.addEventListener("input", () => {
      const v = parseInt(sizeInput.value, 10);
      if (!Number.isNaN(v) && v > 0) this.brushSize = v;
    });
    this.element.appendChild(labelled("Size", sizeInput));

    // Shape — one option for now.
    const shapeSel = select([["square", "Square"]], this.shape, (v) => { this.shape = v; });
    this.element.appendChild(labelled("Shape", shapeSel));

    // Layer — paint target channel. More to come (emissive, …).
    const layerSel = select([["albedo", "Albedo"], ["normal", "Normal"]], this.layer, (v) => {
      this.layer = v as ArtLayer;
    });
    this.element.appendChild(labelled("Layer", layerSel));
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
