import { Container } from "pixi.js";
import type { GameContext } from "../../../GameContext";
import { global } from "../../definitions/globals";
import { cardBox } from "./cardBox";
import { atlasHex, atlasWhite } from "./atlasFills";
import { DeferredLighting } from "../../lighting/DeferredLighting";
import { PrimitiveLayer } from "./PrimitiveLayer";
import type { PrimDeps } from "./primitives";
import { drawVisuals, type HostValue, type VisualHost } from "./drawVisuals";
import type { PrimList } from "./visualSpec";

/**
 * Build the `:visuals @init` {@link PrimList} for a def WITHOUT drawing it —
 * the same faction derivation + VM call {@link GenericCardFace.draw} runs,
 * exposed so callers (the appearance editor) can enumerate + deep-copy the
 * primitives as their own editable working set, then render that copy back via
 * {@link GenericCardFace.drawList}.
 */
export function buildCardPrimList(
  ctx: GameContext,
  packedDefinition: number,
  fallbackFaction?: string | null,
): { list: PrimList; faction: string | undefined } {
  const def = ctx.definitions.decode(packedDefinition);
  const faction =
    (def ? ctx.definitions.cardFactionOverride(def) : null) ??
    fallbackFaction ??
    undefined;
  const host: VisualHost = { card_data: PREVIEW_CARD_DATA };
  if (faction) host.faction = faction;
  return { list: drawVisuals(packedDefinition, host, "init"), faction };
}

/**
 * A standalone, offline render of a card definition's `:visuals` — the same
 * generic PrimList pipeline a live `LayoutGenericCard` uses, but with no card
 * row, no LayoutNode, and no easing loop. Drives a single `PrimitiveLayer`
 * whose `init` draw snaps every primitive straight to its target (see
 * `BasePrim.update` seeding `cur = tgt`), so one `draw()` produces a fully
 * positioned card with no tick.
 *
 * Use for preview surfaces that render a *def*, not a *card*: the drag ghost
 * today; blueprint / wrench previews later. Re-call `draw()` on
 * `lodTextures.onLoad` so lazily-loaded art upgrades in place.
 *
 * Origin matches `LayoutGenericCard`: (0,0) is the body's top-left corner; the
 * title strip prims sit OUTSIDE the body (negative y for a loose card). This is
 * the same convention the drag grab-offset is measured against, so a ghost
 * lines up with the real card under the cursor.
 */
export class GenericCardFace extends Container {
  private readonly layer: PrimitiveLayer;
  private readonly deps: PrimDeps;

  constructor(
    private readonly ctx: GameContext,
    seed: number,
  ) {
    super();
    this.deps = {
      lod: ctx.lodTextures,
      // Offline preview → plain albedo (never goes through the deferred passes).
      deferred: DeferredLighting.offline(),
      whiteTexture: atlasWhite(ctx.textures, ctx.app.renderer),
      hexTexture: atlasHex(ctx.textures, ctx.app.renderer),
      seed,
      // Preview: no live row → no progress timing. Bars hide on `< 0`.
      progress: () => -1,
      queue: () => -1,
    };
    this.layer = new PrimitiveLayer(cardBox(global("card_width"), global("body_height")), this.deps);
    this.addChild(this.layer);
  }

  /** (Re)render the def's `:visuals @init`. `fallbackFaction` is the viewer's
   *  faction folder; a card-side `faction` sub-aspect override beats it (mirrors
   *  `LayoutGenericCard.rebuildSpec`) so faction-specific cards preview the same
   *  across viewers. */
  draw(packedDefinition: number, fallbackFaction?: string | null): void {
    const { list, faction } = buildCardPrimList(this.ctx, packedDefinition, fallbackFaction);
    this.deps.faction = faction;
    this.layer.draw(list);
  }

  /** Render a caller-supplied {@link PrimList} instead of re-running the VM
   *  from a packed def. The appearance editor drives this from its deep-copied
   *  working list so tweaks show here without touching the game's live cards.
   *
   *  Clears the retained prims first (`draw([])`) so the following draw seeds
   *  fresh and SNAPS to target — the face has no per-frame tick to ease a
   *  re-draw, so an in-place reconcile would set new targets that never move.
   *
   *  `seed` overrides the variant-picker seed for this draw (the layer captures
   *  `deps.seed` at draw time). Pass the source card's id so seed-picked art
   *  (single-sprite packs — soul portraits, …) resolves to the SAME variant the
   *  live card shows, instead of the construction-time default. */
  drawList(list: PrimList, faction?: string | null, seed?: number): void {
    this.deps.faction = faction ?? undefined;
    if (seed !== undefined) this.deps.seed = seed;
    this.layer.draw([]);
    this.layer.draw(list);
  }

  override destroy(): void {
    this.layer.destroy();
    super.destroy();
  }
}

/** Static `^card_data` for a def preview: a plain loose card — no stack fan, no
 *  hover/select/pending/drag overlays, no progress bars. Mirrors the shape of
 *  `LayoutGenericCard.buildCardData` so the DSL reads the same keys. */
const PREVIEW_CARD_DATA: HostValue = {
  stack: { state: 0, index: 0, dir: 0 },
  loose: 1,
  hovered: 0,
  selected: 0,
  pending: 0,
  dragging: 0,
  progress: [],
};
