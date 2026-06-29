//! Scene-level card drag-and-drop, driven by the {@link InputManager}.
//!
//! Press a card → a ghost ({@link GenericCardFace} in the scene overlay) tweens
//! toward the mouse; release → the wasm client `place`s the card at the drop
//! target; the real card then tweens to wherever its DATA lands (the dropped
//! cell on success, its origin on rejection, elsewhere if the state changed).
//! It spans viewports — pick up in one, drop on whichever viewport the release
//! lands on — so the ghost floats above every panel and the drop resolves the
//! target surface/owner. Mutually exclusive with pan via `cardAt` (a press on a
//! card starts a drag; an empty press pans).

import { Container } from "pixi.js";
import type { GameContext } from "../../GameContext";
import type { InputManager } from "../input/InputManager";
import type { ViewportPanel } from "./ViewportPanel";
import { GenericCardFace } from "../cards/generic/GenericCardFace";
import { global } from "../definitions/globals";
import { STACK_DIR_UP } from "../../server/data/packing";

/** Per-frame easing for the ghost following the cursor (slight lag = "weighty"). */
const GHOST_EASE = 0.4;

/** Failsafe: how long the drop waits for wasm's place decision before releasing the
 *  ghost anyway, so a hung/missing worker never strands a dragged card. */
const PLACE_SETTLE_TIMEOUT_MS = 1000;

interface Drag {
  /** The grabbed card — the one the drop `place`s (the resolver carries the run). */
  cardId: number;
  /** The whole pickup set (grabbed first), dimmed in place + copied into the
   *  ghost. Grows when the core's `carriedRun` reply lands. */
  ids: number[];
  source: ViewportPanel;
  /** Holds a {@link GenericCardFace} copy per dragged card, fanned like the stack. */
  ghost: Container;
  /** The grabbed card's fan offset — ghost copies sit at `cardFanDy - this`. */
  grabbedFanDy: number;
}

export class CardDragController {
  private drag: Drag | null = null;
  private readonly unsubs: Array<() => void> = [];

  constructor(
    private readonly ctx: GameContext,
    private readonly input: InputManager,
    /** Live viewport list (inventories open/close), most-recent first is fine. */
    private readonly viewports: () => ViewportPanel[],
    /** The scene overlay container the ghost floats in (above all viewports). */
    private readonly overlay: Container,
  ) {
    this.unsubs.push(input.on("left_drag_start", (d) => this.onStart(d.x, d.y, d.hit)));
    this.unsubs.push(input.on("left_drag_stop", (d) => void this.onStop(d.up.x, d.up.y, d.up.hit)));
  }

  /** Per-frame: glide the ghost toward the cursor. Called by the scene. */
  update(): void {
    if (!this.drag) return;
    const g = this.drag.ghost.position;
    const m = this.input.lastPointer;
    g.set(g.x + (m.x - g.x) * GHOST_EASE, g.y + (m.y - g.y) * GHOST_EASE);
  }

  private onStart(x: number, y: number, hit: unknown): void {
    if (this.drag) return;
    const source = this.viewports().find((v) => v.ownsHit(hit));
    if (!source) return;
    const cardId = source.cardAt(x, y);
    if (cardId === null) return;
    if (source.cardPacked(cardId) === null) return;

    const ghost = new Container();
    ghost.pivot.set(global("card_width") / 2, global("body_height") / 2); // centre on cursor
    ghost.position.set(x, y);
    // Faces join out of stack order (grabbed card first, carried run later); sort by
    // an explicit per-face zIndex so a member never paints over its root.
    ghost.sortableChildren = true;
    this.overlay.addChild(ghost);

    const grabbedFanDy = source.cardFanDy(cardId);
    // Show the grabbed card immediately (instant feedback); the rest of the carried
    // run joins when the headless core reports the pickup set.
    this.addGhostFace(ghost, source, cardId, grabbedFanDy);
    source.setCardDragging(cardId, true);
    this.drag = { cardId, ids: [cardId], source, ghost, grabbedFanDy };

    // Ask the core which cards a loose drag lifts (grabbed + the run the resolver
    // carries) and copy + dim the rest. Async (worker round-trip), so guard against
    // a drag that already ended or was replaced.
    void this.ctx.client.carriedRun(cardId).then((ids) => {
      const drag = this.drag;
      if (!drag || drag.ghost !== ghost) return;
      for (const id of ids) {
        if (id === cardId) continue;
        drag.ids.push(id);
        drag.source.setCardDragging(id, true);
        this.addGhostFace(ghost, drag.source, id, drag.grabbedFanDy);
      }
    });
  }

  /** Add a ghost copy of card `id` to the drag ghost, offset so it fans the same
   *  way it does in the stack (relative to the grabbed card at `baseFanDy`). */
  private addGhostFace(ghost: Container, source: ViewportPanel, id: number, baseFanDy: number): void {
    const packed = source.cardPacked(id);
    if (packed === null) return;
    const face = new GenericCardFace(this.ctx, id);
    face.draw(packed);
    face.position.set(0, source.cardFanDy(id) - baseFanDy);
    // Mirror the world renderer's stack depth: members fanned down (positive offset)
    // sit in front of the root, fanned up (negative) behind — the fan offset is
    // proportional to `stackZ`, so its sign + order match.
    face.zIndex = Math.round(face.position.y);
    ghost.addChild(face);
  }

  private async onStop(x: number, y: number, hit: unknown): Promise<void> {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null; // stops `update` easing — the ghost freezes at the drop point
    const { cardId, ids, source, ghost, grabbedFanDy } = drag;

    const target = this.viewports().find((v) => v.ownsHit(hit));
    if (target) {
      let moved: Promise<boolean>;
      const onCard = target.cardAt(x, y);
      if (onCard !== null && onCard !== cardId) {
        // Dropped on another card → stack onto it (the core resolves direction +
        // validity; a finer drop-direction resolver can refine this later).
        moved = this.ctx.client.placeStack(cardId, onCard, STACK_DIR_UP);
      } else {
        // Dropped loose → the resolver carries the same set we lifted (shared
        // `drag_travelers`): the grabbed card + its outward run.
        const cell = target.cellAt(x, y);
        moved = this.ctx.client.placeLoose(cardId, target.surfaceBand, target.ownerId, cell.q, cell.r);
      }
      // Wait for wasm to make up its mind (and re-emit the new position) before
      // releasing the ghost — otherwise the card tweens toward its stale cell while
      // the prediction is still in flight, flashing "back to start". The ghost stays
      // frozen at the drop point during the wait; a failsafe timeout guards a hung
      // worker.
      await Promise.race([
        moved,
        new Promise<boolean>((r) => setTimeout(() => r(false), PLACE_SETTLE_TIMEOUT_MS)),
      ]);
      // Start every lifted card at the drop point so they all tween from there to
      // whatever cells the data settled on (the dropped cells on success, their
      // origins on rejection) — without this only the root seeds and the carried
      // members snap back to tween in from their old data cells.
      //
      // Seed ALL cards at the SAME node point: a stack's members share one node
      // position (the cell centre) and the DSL fan lives INSIDE the prims, not the
      // node position. So the node only needs to land the grabbed card under the
      // cursor (`y - grabbedFanDy`); each card's prims re-add its own fan. Adding
      // `cardFanDy` here too would double the fan — the small upward "jump".
      const seedY = y - grabbedFanDy;
      for (const id of ids) {
        target.seedDropPosition(id, x, seedY);
      }
    }
    // Un-dim every lifted card; the data-driven render takes over.
    for (const id of ids) source.setCardDragging(id, false);
    ghost.destroy({ children: true });
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.drag) {
      for (const id of this.drag.ids) this.drag.source.setCardDragging(id, false);
      this.drag.ghost.destroy({ children: true });
      this.drag = null;
    }
  }
}
