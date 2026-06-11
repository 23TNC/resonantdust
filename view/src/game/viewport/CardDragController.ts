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

import type { Container } from "pixi.js";
import type { GameContext } from "../../GameContext";
import type { InputManager } from "../input/InputManager";
import type { ViewportPanel } from "./ViewportPanel";
import { GenericCardFace } from "../cards/generic/GenericCardFace";
import { global } from "../definitions/globals";
import { STACK_DIR_UP } from "../../server/data/packing";

/** Per-frame easing for the ghost following the cursor (slight lag = "weighty"). */
const GHOST_EASE = 0.4;

interface Drag {
  cardId: number;
  source: ViewportPanel;
  ghost: GenericCardFace;
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
    this.unsubs.push(input.on("left_drag_stop", (d) => this.onStop(d.up.x, d.up.y, d.up.hit)));
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
    const packed = source.cardPacked(cardId);
    if (packed === null) return;

    const ghost = new GenericCardFace(this.ctx, 0);
    ghost.draw(packed);
    ghost.pivot.set(global("card_width") / 2, global("body_height") / 2); // centre on cursor
    ghost.position.set(x, y);
    this.overlay.addChild(ghost);
    source.setCardDragging(cardId, true);
    this.drag = { cardId, source, ghost };
  }

  private onStop(x: number, y: number, hit: unknown): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    const { cardId, source, ghost } = drag;

    const target = this.viewports().find((v) => v.ownsHit(hit));
    if (target) {
      const onCard = target.cardAt(x, y);
      if (onCard !== null && onCard !== cardId) {
        // Dropped on another card → stack onto it (the core resolves direction +
        // validity; a finer drop-direction resolver can refine this later).
        this.ctx.client.placeStack(cardId, onCard, STACK_DIR_UP);
      } else {
        const cell = target.cellAt(x, y);
        this.ctx.client.placeLoose(cardId, target.surfaceBand, target.ownerId, cell.q, cell.r);
      }
      // Start the card at the drop point in the target so it tweens from there to
      // whatever cell the data settles on (no-op if the place is rejected and the
      // card never lands here).
      target.seedDropPosition(cardId, x, y);
    }
    // Un-dim the source card; the data-driven render takes over (tween to the new
    // cell on success, back to origin on rejection, wherever on a state change).
    source.setCardDragging(cardId, false);
    ghost.destroy();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.drag) {
      this.drag.source.setCardDragging(this.drag.cardId, false);
      this.drag.ghost.destroy();
      this.drag = null;
    }
  }
}
