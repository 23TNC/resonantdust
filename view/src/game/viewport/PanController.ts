//! Drag-to-pan for a {@link WorldRenderer}, driven by the {@link InputManager}.
//!
//! It activates only when a drag STARTS on the world surface itself (`hit ===
//! world`) AND not on a card. Panel chrome hits a different node; a card press
//! hits the world node too (cards are a pixel hit-test inside it), so we also
//! exclude presses where `world.cardAt` finds a card — those start a card drag.
//! Pan and card-drag are thus mutually exclusive via `cardAt`, no shared state.
//! While active it reads `input.lastPointer` each frame and
//! moves the anchor opposite the drag (grab-and-drag feel), converting the pixel
//! delta to a cell delta via the world's hex math.

import type { InputManager } from "../input/InputManager";
import type { WorldRenderer } from "./WorldRenderer";

export class PanController {
  private active = false;
  private startX = 0;
  private startY = 0;
  private startQ = 0;
  private startR = 0;
  private readonly unsubs: Array<() => void> = [];

  constructor(
    private readonly input: InputManager,
    private readonly world: WorldRenderer,
  ) {
    this.unsubs.push(
      input.on("left_drag_start", (d) => {
        // Only an empty-world press pans — exclude chrome (other node) and a
        // press on a card (which starts a card drag instead).
        if (d.hit !== world || world.cardAt(d.x, d.y) !== null) return;
        this.active = true;
        this.startX = d.x;
        this.startY = d.y;
        const a = world.anchor();
        this.startQ = a.q;
        this.startR = a.r;
      }),
    );
    this.unsubs.push(input.on("left_drag_stop", () => (this.active = false)));
  }

  /** Per-frame: while panning, move the anchor by the accumulated pixel drag. */
  update(): void {
    if (!this.active) return;
    const dx = this.input.lastPointer.x - this.startX;
    const dy = this.input.lastPointer.y - this.startY;
    const d = this.world.pixelDeltaToCell(dx, dy);
    this.world.setAnchor(this.startQ - d.q, this.startR - d.r);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.active = false;
  }
}
