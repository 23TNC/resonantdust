import type { Texture } from "pixi.js";
import type { CardDefinition } from "../../definitions/DefinitionManager";
import type { DeferredLighting } from "../../lighting/DeferredLighting";
import { LitSprite } from "../../lighting/LitSprite";

const FALLBACK_STYLE = ["#3a3a4a", "#7a7a8a", "#0b1426"] as const;

/** Flat-top pointy-side hexagon vertex list centred on (cx, cy). Still used to
 *  bake the atlas hex mask (`atlasHex`) and to stroke tile outlines. */
export function hexPoints(cx: number, cy: number, radius: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    pts.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
  }
  return pts;
}

/**
 * Hex tile background — the white hex mask from the shared atlas
 * (`atlasHex` / `deps.hexTexture`) as a batched `LitSprite`, tinted to the
 * definition's `style[0]` (white mask × tint = solid colour).
 *
 * As a `LitSprite` with NO normal map, the deferred normal pass leaves it at
 * the flat-up clear, so it lights evenly like a floor. (It used to be a
 * `Graphics` fill, which both broke batching and — under deferred lighting —
 * wrote its flat colour into the normal G-buffer as a bogus tilted normal,
 * causing the directional "lit on one side" shading.)
 */
export class HexTileVisual extends LitSprite {
  constructor(radius: number, deferred: DeferredLighting, hexTexture: Texture) {
    super(deferred, hexTexture);
    // null normal → flat-up in the pass; anchor (0,0) = tile corner; size to box.
    this.setTextures(hexTexture, null);
    this.width = Math.sqrt(3) * radius;
    this.height = 2 * radius;
  }

  /** Tint to the definition's primary style colour. Safe to call every frame. */
  draw(definition: CardDefinition | null): void {
    const style = definition?.style ?? FALLBACK_STYLE;
    this.tint = style[0];
  }
}
