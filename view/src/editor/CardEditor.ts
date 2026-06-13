import { ContextMenu } from "./ContextMenu";
import { CardEditorPanel } from "./CardEditorPanel";
import type { GameContext } from "../GameContext";
import type { InputManager } from "../game/input/InputManager";
import type { LayoutNode } from "../game/layout/LayoutNode";
import type { ViewportPanel } from "../game/viewport/ViewportPanel";
import type { DetailsPanel } from "../game/panels/details/DetailsPanel";
import { debug } from "../debug";

/** What the controller needs from the host scene — a thin seam so the scene
 *  holds only an opaque `CardEditor` handle and references no editor internals. */
export interface CardEditorDeps {
  ctx: GameContext;
  input: InputManager;
  /** Layer the editor panel parents into (the scene's overlay layer). */
  parent: LayoutNode;
  /** The live viewports to hit-test for the right-clicked card. */
  viewports: () => ViewportPanel[];
  /** Card details panel — a right-clicked card surfaces its details. */
  details: DetailsPanel;
}

/**
 * Developer card-editing controller. Owns the right-click context menu, the
 * Developer gate, and the {@link CardEditorPanel} lifecycle — lifted out of the
 * world scene so no game code references editor internals. Lazily imported
 * behind `ctx.client.isDeveloper`, so this module (and the panel it pulls in)
 * never ships in a normal player's bundle — Vite splits it into its own chunk
 * that only loads when a Developer logs in.
 */
export class CardEditor {
  private readonly cardMenu = new ContextMenu();
  private panel?: CardEditorPanel;
  private readonly unsubRightClick: () => void;

  constructor(private readonly deps: CardEditorDeps) {
    this.unsubRightClick = deps.input.on("right_click", (d) => this.onRightClick(d.x, d.y, d.hit));
  }

  /** Right-click on a card opens the developer action menu at the cursor. The
   *  targeted card is selected first, so "the selected card" and "the
   *  right-clicked card" coincide when the menu opens. The native browser menu
   *  is already suppressed in `InputManager`; for everyone else a right-click is
   *  a no-op (this controller is only constructed for Developers). */
  private onRightClick(x: number, y: number, hit: LayoutNode | null): void {
    const vp = this.deps.viewports().find((v) => v.ownsHit(hit));
    if (!vp) return;
    const id = vp.cardAt(x, y);
    if (id === null) return;
    vp.focus();
    for (const v of this.deps.viewports()) v.selectCard(v === vp ? id : null);
    const info = vp.cardInfo(id);
    if (info) {
      const cardLoc = { surface: vp.surfaceBand, q: info.q, r: info.r };
      this.deps.details.showByPackedDefinition(info.packed, this.deps.ctx, undefined, cardLoc);
    }
    const packed = info?.packed ?? null;
    this.cardMenu.show(x, y, [
      { label: "Appearance", onSelect: () => this.openEditor(id, packed) },
      { label: "Definition", onSelect: () => this.onDefinition(id) },
    ]);
  }

  /** Open the Card Editor on a deep copy of the card's `:visuals` (a sandbox —
   *  edits never touch the live card). `cardId` seeds variant picking so art
   *  matches the on-screen card. */
  private openEditor(cardId: number, packed: number | null): void {
    if (packed === null) return;
    if (!this.panel) {
      this.panel = new CardEditorPanel({
        parent: this.deps.parent,
        ctx: this.deps.ctx,
        taskbar: this.deps.ctx.taskbar,
        uiEditMode: this.deps.ctx.uiEditMode,
      });
      this.deps.ctx.panels?.registerNode(this.panel.content, this.panel);
    }
    this.panel.show(packed, cardId);
  }

  /** Developer menu → Definition. TODO: open the card's definition (DSL) view. */
  private onDefinition(cardId: number): void {
    debug.log(["ui"], `[CardEditor] Definition for card ${cardId} (not implemented)`, 2);
  }

  dispose(): void {
    this.unsubRightClick();
    this.cardMenu.destroy();
    this.panel?.destroy();
  }
}
