//! A small floating right-click menu — one shared instance, re-shown at the
//! cursor with a fresh item list each time. Mounts into the same `#app` host as
//! the panels and positions with `position: fixed` left/top in viewport pixels
//! (the input layer's canvas-local samples line up 1:1 with that space — the
//! canvas fills `#app` at the origin).
//!
//! Dismissal is deliberately eager: any pointerdown outside the menu, Escape, a
//! scroll, a window resize, or losing focus all close it — a context menu that
//! lingers after the world moves under it reads as stuck.

const HOST_ID = "app";

const MENU_CSS: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  zIndex: "1000", // above every panel (panels top out around 20-ish per band)
  minWidth: "140px",
  padding: "4px 0",
  background: "rgba(20, 22, 30, 0.98)",
  border: "1px solid #3a3a4a",
  borderRadius: "4px",
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)",
  color: "#ecd6aa",
  fontFamily: "sans-serif",
  fontSize: "13px",
  userSelect: "none",
};

const ITEM_CSS: Partial<CSSStyleDeclaration> = {
  padding: "6px 14px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/** One row in the menu. `onSelect` runs on click; the menu closes first. */
export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
}

export class ContextMenu {
  private readonly el: HTMLDivElement;
  private open = false;

  constructor() {
    this.el = document.createElement("div");
    Object.assign(this.el.style, MENU_CSS);
    // Clicks inside the menu must not bubble to the document-level
    // dismiss handler (that would close the menu before the item's own
    // click fires).
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
  }

  /** Open the menu at viewport `(x, y)` with `items`. Re-binds if already
   *  open. No-op for an empty item list. */
  show(x: number, y: number, items: readonly ContextMenuItem[]): void {
    if (items.length === 0) return;
    this.el.replaceChildren();
    for (const item of items) {
      const row = document.createElement("div");
      Object.assign(row.style, ITEM_CSS);
      row.textContent = item.label;
      row.addEventListener("mouseenter", () => { row.style.background = "#2a2d39"; });
      row.addEventListener("mouseleave", () => { row.style.background = ""; });
      row.addEventListener("click", () => {
        this.close();
        item.onSelect();
      });
      this.el.appendChild(row);
    }
    this.el.style.left = `${x}px`;
    this.el.style.top  = `${y}px`;

    if (!this.open) {
      const host = document.getElementById(HOST_ID) ?? document.body;
      host.appendChild(this.el);
      this.open = true;
      // Defer wiring the dismiss listeners to the next frame so the very
      // pointerup/contextmenu that opened the menu can't immediately close it.
      requestAnimationFrame(() => {
        if (this.open) this.attachDismiss();
      });
    }
  }

  close(): void {
    if (!this.open) return;
    this.detachDismiss();
    this.el.remove();
    this.open = false;
  }

  destroy(): void {
    this.close();
  }

  private attachDismiss(): void {
    document.addEventListener("pointerdown", this.onOutside, true);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onDismissEvent, true);
    window.addEventListener("scroll", this.onDismissEvent, true);
    window.addEventListener("blur", this.onDismissEvent, true);
  }

  private detachDismiss(): void {
    document.removeEventListener("pointerdown", this.onOutside, true);
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onDismissEvent, true);
    window.removeEventListener("scroll", this.onDismissEvent, true);
    window.removeEventListener("blur", this.onDismissEvent, true);
  }

  private readonly onOutside = (e: PointerEvent): void => {
    if (!this.el.contains(e.target as Node)) this.close();
  };
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.close();
  };
  private readonly onDismissEvent = (): void => this.close();
}
