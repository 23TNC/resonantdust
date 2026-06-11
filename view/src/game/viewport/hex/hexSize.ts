/** Size at which world hex tiles (and hex cards placed on world hexes)
 *  are *displayed*.
 *
 *  Derived from the card so cards intersect the hexagon rather than floating in
 *  an oversized one: the hex is sized so its inscribed rectangle is
 *  `BODY_WIDTH × (BODY_WIDTH + 2·TITLE_HEIGHT)` = 72×120 (matching the DSL
 *  `hex_radius` global in `content/visuals/functions/01.rd`). For a pointy-top
 *  hex inscribing a W×H rect with H > R, the rect's top/bottom corners sit on
 *  the sloped caps where half-width = √3·(R − H/2), so W = 2√3·(R − H/2) ⇒
 *  `R = W/(2√3) + H/2` ≈ 80.78 (down from the old hardcoded 96). Keep in sync
 *  with the DSL global. */
const BODY_WIDTH = 72;    // = globals card_width / body_width
const TITLE_HEIGHT = 24;  // = globals title_height
const INSCRIBE_W = BODY_WIDTH;
const INSCRIBE_H = BODY_WIDTH + 2 * TITLE_HEIGHT;
export const WORLD_HEX_RADIUS = INSCRIBE_W / (2 * Math.sqrt(3)) + INSCRIBE_H / 2;
export const WORLD_HEX_WIDTH  = Math.sqrt(3) * WORLD_HEX_RADIUS;
export const WORLD_HEX_HEIGHT = WORLD_HEX_RADIUS * 2;
