//! Master-texture URL builder for the Card Editor (dev-only).
//!
//! The editor previews a card's art at full MASTER resolution (the source the LOD
//! pyramid is baked from). Since the wasm `^r2` resolver now hands the renderer a
//! fully-resolved STEM (`<category>.<biome>/<object>.<faction>/<id>.<count>.<part>`)
//! and textures live on R2 (no local glob), this just maps a stem → a master
//! channel URL; PIXI's `Assets.init({ basePath })` fetches it from R2.

import { Assets, type Texture } from "pixi.js";
import { isTexSentinel } from "../game/cards/generic/visualSpec";

export type MasterChannel = "diffuse" | "albedo" | "normal" | "emissive";

/** The BASE master stem behind a (possibly versioned) resolved texture:
 *  `<aspect>/<faction>/<variant>` with the `?v=<hash>` cache-bust suffix stripped.
 *  Masters are UNVERSIONED (the LOD pyramid is baked from them), so all editor
 *  master ops — URLs, paint-layer keys, upload parse — key off this base, while the
 *  renderer keeps the full versioned stem for LOD resolution. Returns `null` for an
 *  empty stem or a built-in sentinel (`^white` / `^transparent` have no master). */
export function baseStem(texture: string | null | undefined): string | null {
  if (!texture || isTexSentinel(texture)) return null;
  const q = texture.indexOf("?");
  const base = q < 0 ? texture : texture.slice(0, q);
  return base || null;
}

/** The master URL for one channel of a resolved stem:
 *  `/textures/master/<aspect>/<faction>/<variant>.<channel>.png`. The editor
 *  fetches from R2; a missing channel simply fails to load (the preview shows
 *  nothing for it). The `?v=` version suffix is stripped — masters are unversioned. */
export function masterChannelUrl(stem: string, channel: MasterChannel): string | null {
  const base = baseStem(stem);
  if (!base) return null;
  return `/textures/master/${base}.${channel}.png`;
}

/** Load (and cache, via Pixi `Assets`) the texture at `url`. */
export function loadMasterTexture(url: string): Promise<Texture> {
  return Assets.load<Texture>(url);
}
