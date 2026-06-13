import { Sprite, Texture } from "pixi.js";
import type { DeferredLighting } from "./DeferredLighting";

/**
 * A plain batched `Sprite` that also carries its normal-map frame, for deferred
 * lighting. Being a stock `Sprite` (default shader, single atlas texture) it
 * batches with every other sprite — unlike the old per-instance lit `Mesh`,
 * which forced one draw call each. The albedo is what draws on screen; the
 * `normalTexture` is the SAME atlas frame in the parallel normal page, picked
 * up by the deferred normal pass (which renders the registry's sprites with
 * `normalTexture` swapped in for `texture`).
 *
 * Registers itself with the viewport's `DeferredLighting` on construction so
 * the normal pass can find it, and unregisters on destroy.
 */
export class LitSprite extends Sprite {
  /** Normal frame at this sprite's atlas slot, or null → flat-up fallback. */
  normalTexture: Texture | null = null;
  /** Emissive frame at this sprite's atlas slot, or null → no self-illumination.
   *  Optional per art; the deferred emissive pass skips sprites without one. */
  emissiveTexture: Texture | null = null;
  /** The albedo, kept separately from the live `texture` so the normal/emissive
   *  passes can swap `texture` to their map, render, and restore the albedo. */
  albedoTexture: Texture = Texture.EMPTY;
  private readonly deferred: DeferredLighting;

  constructor(deferred: DeferredLighting, texture: Texture = Texture.EMPTY) {
    super(texture);
    this.deferred = deferred;
    deferred.register(this);
  }

  /** Set the displayed albedo and its normal + emissive siblings (null → flat-up
   *  / no glow). Anchor, size, tint, scale, etc. are the stock `Sprite` API the
   *  prims already use. */
  setTextures(albedo: Texture, normal: Texture | null, emissive: Texture | null = null): void {
    this.albedoTexture = albedo;
    this.normalTexture = normal;
    this.emissiveTexture = emissive;
    this.texture = albedo;
  }

  override destroy(options?: Parameters<Sprite["destroy"]>[0]): void {
    this.deferred.unregister(this);
    super.destroy(options);
  }
}
