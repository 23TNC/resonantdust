import { global } from "../../definitions/globals";

/** Size at which world hex tiles (and hex cards placed on world hexes) are
 *  *displayed*, read from the gate-served DSL `<globals>` (`hex_radius` /
 *  `hex_width` / `hex_height`) — the SAME numbers the DSL itself draws the hex
 *  body from. This is deliberately not a hardcoded constant: the radius lives in
 *  exactly one place (the content global), so the tile spacing (client) and the
 *  tile body (DSL) can never drift. Width = √3·r, height = 2·r, matching the DSL
 *  `hex_width`/`hex_height` derivations in `content/visuals/functions/01.rd`.
 *
 *  Call these after `initGlobals()` — i.e. anywhere in the world scene; login
 *  loads the content runtime before entering it. */
export const worldHexRadius = (): number => global("hex_radius");
export const worldHexWidth = (): number => global("hex_width");
export const worldHexHeight = (): number => global("hex_height");
