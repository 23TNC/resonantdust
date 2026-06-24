/**
 * Canonical light types for the tiered lighting model (docs/tiered_lighting.md).
 *
 * `LightCore` is the geometry+photometry the lightmap/shadow math consumes — identical to
 * the renderer's long-standing per-light shape. `Light` adds the tier + shadow flags that
 * route a light to cold (per-rect, baked) vs the dynamic pool (global, scatter + warm
 * bitfield). One type, bucketed by `tier`, replaces the old `ColdLight`-vs-hot-array split.
 */

/** The fields every light shares and the lightmap/shadow shaders read. WORLD px.
 *  `height` is the light's z above the ground plane (drives N·L *and* the shadow projection
 *  `h/(lightZ−h)`); `color` is packed `0xRRGGBB`; `brightness` is a separate scalar so
 *  colour stays a normalized hue and intensity scales independently. */
export interface LightCore {
  x: number;
  y: number;
  height: number;
  radius: number;
  color: number;
  brightness: number;
}

/** Cold = static, baked per-rect (count effectively unlimited across the world). Dynamic =
 *  the global pool of ≤32 movers (scatter shadows + the warm bitfield, see the doc). A
 *  dynamic light that settles migrates to cold; a cold light that moves promotes to dynamic. */
export type LightTier = "cold" | "dynamic";

/** A light with its routing. */
export interface Light extends LightCore {
  /** Does this light cast a shadow (consume a scatter channel / warm bit)? Most fills don't. */
  castsShadow: boolean;
  tier: LightTier;
}

/** Split a light list into its two tiers. The dynamic bucket feeds the scatter round-robin +
 *  uniforms; the cold bucket feeds the per-rect bake. */
export function bucketLights(lights: readonly Light[]): { cold: Light[]; dynamic: Light[] } {
  const cold: Light[] = [];
  const dynamic: Light[] = [];
  for (const l of lights) (l.tier === "cold" ? cold : dynamic).push(l);
  return { cold, dynamic };
}
