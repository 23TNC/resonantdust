import { CardEditorPanel } from "./CardEditorPanel";
import type { GameContext } from "../GameContext";
import type { InputManager } from "../game/input/InputManager";
import type { LayoutNode } from "../game/layout/LayoutNode";
import type { ViewportPanel } from "../game/viewport/ViewportPanel";
import type { DetailsPanel } from "../game/panels/details/DetailsPanel";

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
 * Developer card-editing controller. Owns the Developer gate and the
 * {@link CardEditorPanel} lifecycle — lifted out of the world scene so no game
 * code references editor internals. Lazily imported behind
 * `ctx.client.isDeveloper`, so this module (and the panel it pulls in) never
 * ships in a normal player's bundle — Vite splits it into its own chunk that
 * only loads when a Developer logs in.
 *
 * The editor is opened via the chat `/edit` command (see `WorldScene` →
 * {@link editCard}); right-click no longer pops an action menu. The right-click
 * subscription is kept (it selects the card under the cursor + shows its
 * details) as the seam for future developer right-click tools.
 */
export class CardEditor {
  private panel?: CardEditorPanel;
  private readonly unsubRightClick: () => void;

  constructor(private readonly deps: CardEditorDeps) {
    this.unsubRightClick = deps.input.on("right_click", (d) => this.onRightClick(d.x, d.y, d.hit));
  }

  /** Right-click on a card selects it and surfaces its details — so a developer
   *  can right-click a card and then `/edit` it. The action menu was removed in
   *  favour of chat commands; this handler stays as the right-click seam for
   *  future tools. The native browser menu is already suppressed in
   *  `InputManager`; for everyone else a right-click is a no-op (this controller
   *  is only constructed for Developers). */
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
      this.deps.details.showByPackedDefinition(info.packed, this.deps.ctx, undefined, cardLoc, id);
    }
  }

  /** Open the appearance editor against a specific card — the public entry the
   *  chat `/edit` command drives. Same sandbox as the right-click "Appearance"
   *  menu item; a no-op if `packed` is null (no definition to edit). */
  editCard(cardId: number, packed: number | null): void {
    this.openEditor(cardId, packed);
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

  dispose(): void {
    this.unsubRightClick();
    this.panel?.destroy();
  }
}
