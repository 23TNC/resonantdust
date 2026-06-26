//! The render-feed contract — a SECOND channel on the client worker, separate
//! from the login/event game-logic channel. A viewport asks the client "what is
//! in this region of the world?" and the client streams back batches of
//! renderables. The viewport is dumb: it does not know game rules, only how to
//! draw what the feed reports (via the DSL). The client owns "what to draw"; the
//! DSL owns "how"; the viewport owns "where on screen".
//!
//! This file is the shared type surface for both ends (main thread + worker). The
//! Rust `client` core will implement the region query against its read-only world
//! snapshot — a module kept STRICTLY apart from the matcher/NPC/action logic.
//! Until that lands, a clearly-labelled mock (`mockRenderFeed.ts`) stands in.

/** A rectangular-ish slice of one surface the viewport wants drawn. Center is in
 *  fractional world-hex axial coords (so a smooth pan still rounds to a stable
 *  query); the half-extents are in whole cells, sized by the viewport from its
 *  display rectangle. The client decides which renderables fall inside. */
export interface RenderRegion {
  /** The surface band: `WORLD_LAYER` for the world, `INVENTORY_LAYER` for an
   *  inventory. */
  surface: number;
  /** The owning card_id — `0` for the world, the soul card_id for an inventory
   *  (so an inventory viewport sees only that soul's items). */
  owner: number;
  /** Anchor cell — the hex centred in the display. */
  q: number;
  r: number;
  /** How many cells out from the anchor to cover, per axis (incl. margin). */
  halfCols: number;
  halfRows: number;
}

/** One drawable the client reports as inside a region. A `tile` is a world hex
 *  (its packed def + the two zone stock bytes); a `card` is a positioned card
 *  the client has already resolved to absolute world coords + within-cell offset
 *  (the viewport never decodes `micro_location` — that's game logic). */
export type Renderable =
  | {
      layer: "tile";
      q: number;
      r: number;
      /** Packed tile definition (`packed_definition`). */
      packed: number;
      /** The two zone stock slots driving the tile's `:visuals`. */
      stock0: number;
      stock1: number;
    }
  | {
      layer: "card";
      cardId: number;
      /** Cell the card rests in (client-resolved from its placement). */
      q: number;
      r: number;
      /** Within-cell pixel offset (loose cards); 0 for snapped. */
      offsetX: number;
      offsetY: number;
      packed: number;
      /** Per-card `stock` u64 (string — exceeds JS safe-int range; BigInt it for
       *  bit reads) + propagating `flags` u32 (state/placement). */
      stock: string;
      flags: number;
      /** Progress-bar timing windows as `(total, remaining)` ms — the view fills
       *  locally with its own clock (no per-frame worker round-trip). `p*` = build
       *  (`source = 0`, the server-confirmed completion window); `q*` = queue
       *  (`source = 1`, the pre-fire debounce). `0` total ⇒ no active bar.
       *  Optional so older/test snapshots without timing still parse. */
      pTotalMs?: number;
      pRemainingMs?: number;
      qTotalMs?: number;
      qRemainingMs?: number;
    };

/** One streamed chunk of a region's renderables. `gen` rises every time the
 *  client (re)computes a region for this `viewId` — a pan/resize supersedes the
 *  prior generation, so the viewport drops stale lower-`gen` batches. `final`
 *  marks the last chunk of a generation: on it the viewport drops any retained
 *  cell/card the generation didn't mention. */
export interface RenderBatch {
  viewId: number;
  gen: number;
  items: Renderable[];
  final: boolean;
}

/** Handle a viewport holds onto its feed by. `update` re-aims the region (pan /
 *  resize); `close` tears the subscription down. */
export interface ViewportFeed {
  update(region: RenderRegion): void;
  close(): void;
}
