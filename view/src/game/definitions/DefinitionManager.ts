//! Definition access — backed by the shared `resonantdust_shared` wasm runtime
//! loaded from the gate (`contentBoot`). Adapts the DSL models the view renders
//! against:
//!  - **Aspects** are name-keyed in the DSL (multi-parent `satisfies`); the client
//!    wants numeric ids for its render code, so a stable client-local id space is
//!    built from `Content.aspectNames()` (ids never cross the wire).
//!  - **Visuals** are `color.{bg,title,text}`/`objects[]`/`texture`; `decode()`
//!    adapts them into the render-ready `CardDefinition`.
//!
//! Scope: what the viewport's card/tile draw needs — `decode` (style + art +
//! aspects), `cardFactionOverride` (faction art folder), and `label` /
//! `description` (locale strings, for the details panel). Recipe matching is
//! not ported yet.

import { onContentReloaded, sharedContent, sharedLocales } from "./contentBoot";

export type StockMode = "count" | "index";

export interface StockSlot {
  aspectId: number;
  max: number;
  default: number;
  mode: StockMode;
  /** Display visibility (0 hidden · 1 aspect slot · 2 function slot). */
  visibility: number;
}

/** The decoded, render-ready shape of a card definition (adapted from the DSL). */
export interface CardDefinition {
  cardType: number;
  definitionId: number;
  key: string;
  /** `[bg, title, text]` CSS hex strings (from the DSL `color.*`). */
  style: readonly string[];
  object?: { name: string; index?: number; scale?: { min: number; max: number } } | null;
  texture?: { name: string; index?: number; scale?: { min: number; max: number } } | null;
  /** `[aspectId, value, visibility]` — visibility is the card's effective
   *  level (its `:visuals` override or the aspect's registry default). */
  aspects: ReadonlyArray<readonly [number, number, number]>;
  flags: number;
  lifecycleRecipeKey?: string | null;
  lifecycleDurationMs?: number | null;
  stock: readonly StockSlot[];
}

export type AspectCategory = "aspect" | "feature" | "trait";

export interface AspectInfo {
  id: number;
  name: string;
  icon: string;
  /** `0xRRGGBB`. */
  color: number;
  /** Top-level family — the root of the `satisfies` chain. */
  group: string;
  /** First `satisfies` entry's id, or `null`. */
  parent: number | null;
  category: AspectCategory;
}

// ── DSL JSON shapes (the wasm returns these as JSON strings) ─────────
interface DslAspectInfo {
  name: string;
  icon: string;
  color: number;
  visibility: number;
  satisfies: string[];
  art: string | null;
}

interface DslCardDef {
  card_type: number;
  def_id: number;
  key: string;
  type_name: string;
  color_bg: number;
  color_title: number;
  color_text: number;
  texture: string | null;
  objects: string[];
  aspects: [string, number, number][];
  stock: { aspect: string; max: number; default: number; visibility: number }[];
  lifecycle_recipe: string | null;
  lifecycle_duration_ms: number | null;
}

function hex(color: number): string {
  return "#" + (color >>> 0).toString(16).padStart(6, "0");
}

/** Display category from a visibility level: `0`→trait (hidden), `2`→feature
 *  (function slot), else aspect (aspect slot). */
export function visibilityToCategory(visibility: number): AspectCategory {
  if (visibility === 0) return "trait";
  if (visibility === 2) return "feature";
  return "aspect";
}

export class DefinitionManager {
  constructor() {
    // Drop content-derived caches when the gate pushes a runtime reload.
    onContentReloaded(() => this.invalidate());
  }

  invalidate(): void {
    this.aspectIdToName = null;
    this.aspectNameToId = null;
    this.factionAspectId = undefined;
  }

  // ---- aspect id↔name space (client-local; ids never cross the wire) ----
  private aspectIdToName: string[] | null = null;
  private aspectNameToId: Map<string, number> | null = null;
  private factionAspectId: number | null | undefined = undefined;

  private ensureAspectMaps(): void {
    if (this.aspectIdToName !== null) return;
    const names = sharedContent().aspectNames();
    this.aspectIdToName = names;
    this.aspectNameToId = new Map(names.map((n, i) => [n, i + 1]));
  }

  aspectIdByName(name: string): number | null {
    this.ensureAspectMaps();
    return this.aspectNameToId!.get(name) ?? null;
  }

  private aspectNameById(id: number): string | null {
    this.ensureAspectMaps();
    return this.aspectIdToName![id - 1] ?? null;
  }

  private dslAspect(name: string): DslAspectInfo | null {
    return JSON.parse(sharedContent().aspectInfo(name)) as DslAspectInfo | null;
  }

  aspectInfo(id: number): AspectInfo | null {
    const name = this.aspectNameById(id);
    if (name === null) return null;
    const dsl = this.dslAspect(name);
    if (dsl === null) return null;
    // group = root of the satisfies chain.
    let group = name;
    let cur: string | undefined = dsl.satisfies[0];
    for (let i = 0; i < 8 && cur !== undefined; i++) {
      group = cur;
      cur = this.dslAspect(cur)?.satisfies[0];
    }
    const parentName = dsl.satisfies[0];
    return {
      id,
      name,
      icon: dsl.icon,
      color: dsl.color,
      group,
      parent: parentName !== undefined ? this.aspectIdByName(parentName) : null,
      category: visibilityToCategory(dsl.visibility),
    };
  }

  /** Decode a packed definition → render-ready `CardDefinition` (null on miss). */
  decode(packed: number): CardDefinition | null {
    const dsl = JSON.parse(sharedContent().cardDef(packed)) as DslCardDef | null;
    if (dsl === null) return null;
    return {
      cardType: dsl.card_type,
      definitionId: dsl.def_id,
      key: dsl.key,
      style: [hex(dsl.color_bg), hex(dsl.color_title), hex(dsl.color_text)],
      object: dsl.objects.length > 0 ? { name: dsl.objects[0] } : null,
      texture: dsl.texture !== null ? { name: dsl.texture } : null,
      aspects: dsl.aspects.map(([n, v, vis]) => [this.aspectIdByName(n) ?? 0, v, vis] as const),
      flags: 0,
      lifecycleRecipeKey: dsl.lifecycle_recipe,
      lifecycleDurationMs: dsl.lifecycle_duration_ms,
      stock: dsl.stock.map((s) => ({
        aspectId: this.aspectIdByName(s.aspect) ?? 0,
        max: s.max,
        default: s.default,
        mode: "count" as StockMode,
        visibility: s.visibility,
      })),
    };
  }

  /** The folded value of a named aspect on a packed def (the static aspect value,
   *  resolving the `satisfies` chain), or `null` if the def doesn't carry it. Used
   *  to test e.g. the `inventory` aspect (a soul → its inventory capacity). */
  aspectValue(packed: number, name: string): number | null {
    const v = sharedContent().aspectValue(packed, name);
    return v === undefined || v === null ? null : Number(v);
  }

  /** Display label for a packed def. Locale key is `cards.<type>.<key>.label`
   *  (falling back to `cards.<key>.label`, then the bare key). Mirrors the
   *  pixijs lookup so the details panel reads the same strings. */
  label(packed: number): string {
    const dsl = JSON.parse(sharedContent().cardDef(packed)) as DslCardDef | null;
    if (dsl === null) return "?";
    const loc = sharedLocales();
    return (
      loc.string(`cards.${dsl.type_name}.${dsl.key}.label`) ??
      loc.string(`cards.${dsl.key}.label`) ??
      dsl.key
    );
  }

  /** Simple (plain-language) description for a packed def, or `""` on a miss.
   *  Locale key is `cards.<type>.<key>.description.simple` (falling back to the
   *  type-less form). */
  description(packed: number): string {
    const dsl = JSON.parse(sharedContent().cardDef(packed)) as DslCardDef | null;
    if (dsl === null) return "";
    const loc = sharedLocales();
    return (
      loc.string(`cards.${dsl.type_name}.${dsl.key}.description.simple`) ??
      loc.string(`cards.${dsl.key}.description.simple`) ??
      ""
    );
  }

  /** The faction art folder for a def — the name of its aspect whose `satisfies`
   *  chain reaches the `faction` aspect — or null. Drives faction-specific art
   *  selection in the generic draw pipeline. */
  cardFactionOverride(def: CardDefinition | null | undefined): string | null {
    if (!def) return null;
    if (this.factionAspectId === undefined) {
      this.factionAspectId = this.aspectIdByName("faction");
    }
    const factionId = this.factionAspectId;
    if (factionId === null) return null;
    for (const [aspectId] of def.aspects ?? []) {
      let cur: number | null = aspectId;
      for (let depth = 0; depth < 16 && cur !== null; depth++) {
        const info = this.aspectInfo(cur);
        if (!info) break;
        if (info.id === factionId) {
          return this.aspectInfo(aspectId)?.name ?? null;
        }
        cur = info.parent;
      }
    }
    return null;
  }
}
