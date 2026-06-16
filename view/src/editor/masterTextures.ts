//! Master-texture URL builder for the Card Editor (dev-only).
//!
//! The editor previews a card's art at full MASTER resolution (the source the LOD
//! pyramid is baked from). Since the wasm `^r2` resolver now hands the renderer a
//! fully-resolved STEM (`<category>.<biome>/<object>.<faction>/<id>.<count>.<part>`)
//! and textures live on R2 (no local glob), this just maps a stem → a master
//! channel URL; PIXI's `Assets.init({ basePath })` fetches it from R2.

import { Assets, type Texture } from "pixi.js";

export type MasterChannel = "diffuse" | "albedo" | "normal" | "emissive";

/** The master URL for one channel of a resolved stem:
 *  `/textures/master/<stem>.<channel>.png`. The editor fetches from R2; a missing
 *  channel simply fails to load (the preview shows nothing for it). */
export function masterChannelUrl(stem: string, channel: MasterChannel): string | null {
  if (!stem) return null;
  return `/textures/master/${stem}.${channel}.png`;
}

/** Load (and cache, via Pixi `Assets`) the texture at `url`. */
export function loadMasterTexture(url: string): Promise<Texture> {
  return Assets.load<Texture>(url);
}
