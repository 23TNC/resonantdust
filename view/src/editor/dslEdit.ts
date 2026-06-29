//! DSL text editing for the Card Editor's tabs.
//!
//! The Visual / Data / Locale tabs hold the card's DSL as an EDITABLE buffer —
//! the working copy that's eventually written back to the corpus on save. As the
//! editor mutates the card (today: lights; later: any primitive — see the plan in
//! `CardEditorPanel`), it patches that text rather than regenerating it wholesale,
//! so hand-authored statements, function calls, and comments survive.
//!
//! The mechanism is an **editor-managed region**: a marker-delimited block the
//! editor owns and rewrites in full, leaving everything outside it untouched.
//! Lights are the first user of it.

/** A point light in game/DSL units — the shape we serialise to `^light`.
 *  x/y/height are card px; `radius` is in hex-tile units (the world's falloff
 *  unit, `radius × hex_radius` px). */
export interface DslLight {
  x: number;
  y: number;
  tint: number;
  height: number;
  radius: number;
  intensity: number;
}

const REGION_START = "; @editor:lights";
const REGION_END = "; @editor:lights-end";

/** Marker test that ignores the trailing description, so the start line can carry
 *  a human note without breaking re-detection. */
function isStart(trimmed: string): boolean {
  return trimmed.startsWith("; @editor:lights") && !trimmed.startsWith(REGION_END);
}
function isEnd(trimmed: string): boolean {
  return trimmed === REGION_END;
}

/** `0xRRGGBB` → `#rrggbb`. */
function hex(tint: number): string {
  return `#${((tint >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** Compact number: integer when whole, else up to 3 decimals with trailing
 *  zeros trimmed (the DSL accepts floats). */
function num(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return parseFloat(n.toFixed(3)).toString();
}

/** The `^light` statements for one light, indented by `pad`, using local var
 *  `&l<i>`. */
function lightStatements(l: DslLight, i: number, pad: string): string[] {
  const v = `&l${i}`;
  return [
    `${pad}^light call ${v} set`,
    `${pad}${Math.round(l.x)} ${Math.round(l.y)} ${v}.pos vec2`,
    `${pad}${hex(l.tint)} ${v}.tint set`,
    `${pad}${Math.round(l.height)} ${v}.light.height set`,
    `${pad}${num(l.radius)} ${v}.light.radius set`,
    `${pad}${num(l.intensity)} ${v}.light.intensity set`,
  ];
}

/** The full managed region (markers + every light), indented by `pad`. */
function buildRegion(lights: DslLight[], pad: string): string[] {
  const out = [pad + REGION_START];
  lights.forEach((l, i) => out.push(...lightStatements(l, i, pad)));
  out.push(pad + REGION_END);
  return out;
}

/** Leading-whitespace width of a line. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** A fresh `::key>` visuals block holding only the managed light region — used
 *  when the buffer has no `:visuals @init>` to splice into (e.g. a card that
 *  ships no visuals yet). Mirrors the corpus's 2-space nesting. */
function scaffold(lights: DslLight[], key: string): string {
  return [
    `::${key}>`,
    `  :visuals>`,
    `    @init>`,
    ...buildRegion(lights, "      "),
  ].join("\n");
}

/**
 * Return `text` with the editor-managed light region rewritten to match
 * `lights`. Everything outside the markers is preserved verbatim.
 *
 * - Markers already present → replace the region in place (same indent).
 * - No markers but an `@init>` exists → insert the region as the first
 *   statements of the init body (indent = `@init>` + 2).
 * - Neither → scaffold a minimal `::key>` visuals block (replacing a placeholder
 *   buffer, or appended after existing content).
 * - `lights` empty → strip the region (and markers) entirely.
 */
export function syncLightRegion(text: string, lights: DslLight[], key: string): string {
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => isStart(l.trimStart()));
  const endIdx = startIdx >= 0 ? lines.findIndex((l, i) => i > startIdx && isEnd(l.trimStart())) : -1;

  // Existing region → replace (or remove when no lights).
  if (startIdx >= 0 && endIdx > startIdx) {
    const pad = " ".repeat(indentOf(lines[startIdx]));
    const region = lights.length ? buildRegion(lights, pad) : [];
    lines.splice(startIdx, endIdx - startIdx + 1, ...region);
    return lines.join("\n");
  }

  if (lights.length === 0) return text; // nothing to add, no region to clear

  // No region yet — insert after `@init>` if there is one.
  const initIdx = lines.findIndex((l) => l.trimStart().startsWith("@init>"));
  if (initIdx >= 0) {
    const pad = " ".repeat(indentOf(lines[initIdx]) + 2);
    lines.splice(initIdx + 1, 0, ...buildRegion(lights, pad));
    return lines.join("\n");
  }

  // No `@init>` at all — scaffold a block. Replace a placeholder buffer outright.
  const block = scaffold(lights, key || "card");
  return text.trim() === "" || text.trim().startsWith("(no") ? block : `${text.trimEnd()}\n\n${block}`;
}

/**
 * Rebuild a nested locale subtree from the panel's flattened `path: value` lines
 * (the inverse of `flattenLocale`) — for assembling a `modify_locale` payload on
 * save. Splits each line on the FIRST `": "`; the dotted path becomes nested
 * objects, the remainder the (string) leaf value. Blank / malformed lines are
 * skipped. Locale leaves are strings, so no type recovery is attempted.
 */
export function unflattenLocale(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const sep = line.indexOf(": ");
    if (sep < 0) continue;
    const path = line.slice(0, sep).trim().split(".");
    const value = line.slice(sep + 2);
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
      node = node[k] as Record<string, unknown>;
    }
    node[path[path.length - 1]] = value;
  }
  return root;
}

/**
 * Assemble a standalone `.rd` card SOURCE from the editor's per-facet tab blocks
 * (each a `::key>` block holding one facet — `:data>` or `:visuals>`). This is
 * what the gate's `modify_content` actually wants: ONE `<card>`-bucketed def
 * under the card's bare `::key>` header carrying ALL its facets — NOT a whole
 * source file. The gate versions it (`::key>` → `::key.N>`, append-only), and
 * because the loader merges facets by def NAME, a new version must carry every
 * facet or it loses the ones left in the base files. Blocks that don't define
 * `::key>` (a placeholder / empty tab) are skipped; the bodies are stitched under
 * one header at their existing indentation. `""` if no block defines the card.
 */
export function buildCardSource(key: string, blocks: string[]): string {
  const bodies: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const hi = lines.findIndex((l) => l.trimStart().startsWith(`::${key}>`));
    if (hi < 0) continue; // placeholder / unrelated buffer — no def here
    const body = lines.slice(hi + 1).join("\n").replace(/\s+$/, "");
    if (body.trim()) bodies.push(body);
  }
  if (!bodies.length) return "";
  return `<card>\n  ::${key}>\n${bodies.join("\n")}\n`;
}

/**
 * Splice an edited card block back into its full source file — the inverse of the
 * panel's `extractCardBlock`. Retained as a utility; `modify_content` saves use
 * {@link buildCardSource} instead (the gate versions a card def, it does not
 * rewrite files). Returns `null` if the block isn't found.
 */
export function replaceCardBlock(fileText: string, key: string, block: string): string | null {
  const lines = fileText.split("\n");
  let inCard = false;
  let start = -1;
  let blockIndent = 0;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const indent = lines[i].length - trimmed.length;
    const bucket = /^<([a-z_]+)>/.exec(trimmed);
    if (bucket) {
      if (start >= 0) { end = i; break; } // next bucket ends the block
      inCard = bucket[1] === "card";
      continue;
    }
    if (!inCard) continue;
    const def = /^::([A-Za-z0-9_.]+)>/.exec(trimmed);
    if (start < 0) {
      if (def && def[1] === key) { start = i; blockIndent = indent; }
    } else if (def && indent <= blockIndent) {
      end = i; break; // next sibling def ends the block
    }
  }
  if (start < 0) return null;
  if (end < 0) end = lines.length;
  // Keep trailing blank / comment lines just before the next def with that def.
  let last = end - 1;
  while (last > start && (lines[last].trim() === "" || lines[last].trim().startsWith(";"))) last--;
  lines.splice(start, last - start + 1, ...block.split("\n"));
  return lines.join("\n");
}
