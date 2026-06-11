//! The input layer — a thin DOM→semantic-event adapter over the canvas.
//!
//! It turns raw pointer/key DOM events into game-level events (`left_drag_start`,
//! `left_click`, `key_down`, …), hit-testing the layout tree ONCE per
//! pointerdown/up (not per move) so a consumer knows WHAT was pressed. Consumers
//! (the viewport pan, future card drag, hotkeys) subscribe; they never touch the
//! DOM. The `hit` field is the seam: a pan only activates when the press landed on
//! the world surface, a card drag when it landed on a card.
//!
//! Coordinates are canvas-local CSS pixels — the same space the DOM panels' rects
//! live in (the canvas fills `#app` at the origin), so `hitRoot.hitTestLayout`
//! lines up with the panels' `setBounds`.

import type { LayoutNode } from "../layout/LayoutNode";

/** Movement (px) past which a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 5;

/** A single pointer sample: canvas-local position, what it hit, which button. */
export interface PointerEventData {
  x: number;
  y: number;
  /** The layout node under the pointer at sample time, or `null`. */
  hit: LayoutNode | null;
  button: number;
  /** `performance.now()` timestamp. */
  t: number;
}

/** A press→release pair — both endpoints, so a handler sees where it started. */
export interface UpEventData {
  down: PointerEventData;
  up: PointerEventData;
}

export interface KeyEventData {
  key: string;
  code: string;
}

/** Events whose payload is a single pointer sample (the press point). */
type DownEvent = "left_down" | "left_drag_start";
/** Events whose payload is a press→release pair. */
type UpEvent = "left_up" | "left_click" | "left_drag_stop";
type KeyEvent = "key_down" | "key_up";

type DownListener = (d: PointerEventData) => void;
type UpListener = (d: UpEventData) => void;
type KeyListener = (d: KeyEventData) => void;

export class InputManager {
  /** The latest pointer position (canvas-local CSS px). Updated on every move —
   *  a per-frame consumer (drag-pan) reads this rather than buffering moves. */
  readonly lastPointer = { x: 0, y: 0 };

  private readonly downListeners = new Map<DownEvent, Set<DownListener>>();
  private readonly upListeners = new Map<UpEvent, Set<UpListener>>();
  private readonly keyListeners = new Map<KeyEvent, Set<KeyListener>>();

  private down: PointerEventData | null = null;
  private pressing = false;
  private dragging = false;
  private activePointerId: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** Root of the layout tree to hit-test (the scene's top LayoutNode). */
    private readonly hitRoot: LayoutNode,
  ) {
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  /** Subscribe to a pointer-press event. Returns an unsubscribe fn. */
  on(event: DownEvent, fn: DownListener): () => void;
  on(event: UpEvent, fn: UpListener): () => void;
  on(event: DownEvent | UpEvent, fn: DownListener | UpListener): () => void {
    const map = (this.isUpEvent(event) ? this.upListeners : this.downListeners) as Map<string, Set<unknown>>;
    let set = map.get(event);
    if (!set) map.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Subscribe to a keyboard event. Returns an unsubscribe fn. */
  onKey(event: KeyEvent, fn: KeyListener): () => void {
    let set = this.keyListeners.get(event);
    if (!set) this.keyListeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  dispose(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.downListeners.clear();
    this.upListeners.clear();
    this.keyListeners.clear();
  }

  // ── DOM handlers ───────────────────────────────────────────────────
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const p = this.sample(e);
    this.lastPointer.x = p.x;
    this.lastPointer.y = p.y;
    this.down = p;
    this.pressing = true;
    this.dragging = false;
    this.activePointerId = e.pointerId;
    // Capture so a drag that leaves the canvas/window still streams moves here.
    this.canvas.setPointerCapture?.(e.pointerId);
    this.emitDown("left_down", p);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.lastPointer.x = e.clientX - rect.left;
    this.lastPointer.y = e.clientY - rect.top;
    if (this.pressing && !this.dragging && this.down) {
      const dx = this.lastPointer.x - this.down.x;
      const dy = this.lastPointer.y - this.down.y;
      if (dx * dx + dy * dy >= DRAG_THRESHOLD * DRAG_THRESHOLD) {
        this.dragging = true;
        // Payload is the PRESS sample — its `hit` is what the drag grabbed.
        this.emitDown("left_drag_start", this.down);
      }
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.down) return;
    const up = this.sample(e);
    const pair: UpEventData = { down: this.down, up };
    this.emitUp("left_up", pair);
    if (this.dragging) this.emitUp("left_drag_stop", pair);
    else this.emitUp("left_click", pair);
    this.canvas.releasePointerCapture?.(e.pointerId);
    this.reset();
  };

  private readonly onPointerCancel = (): void => {
    if (this.activePointerId !== null) {
      this.canvas.releasePointerCapture?.(this.activePointerId);
    }
    this.reset();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.emitKey("key_down", { key: e.key, code: e.code });
  };
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.emitKey("key_up", { key: e.key, code: e.code });
  };

  // ── helpers ────────────────────────────────────────────────────────
  private sample(e: PointerEvent): PointerEventData {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { x, y, hit: this.hitRoot.hitTestLayout(x, y), button: e.button, t: performance.now() };
  }

  private reset(): void {
    this.pressing = false;
    this.dragging = false;
    this.down = null;
    this.activePointerId = null;
  }

  private isUpEvent(event: string): event is UpEvent {
    return event === "left_up" || event === "left_click" || event === "left_drag_stop";
  }

  private emitDown(event: DownEvent, d: PointerEventData): void {
    const set = this.downListeners.get(event);
    if (set) for (const fn of set) fn(d);
  }
  private emitUp(event: UpEvent, d: UpEventData): void {
    const set = this.upListeners.get(event);
    if (set) for (const fn of set) fn(d);
  }
  private emitKey(event: KeyEvent, d: KeyEventData): void {
    const set = this.keyListeners.get(event);
    if (set) for (const fn of set) fn(d);
  }
}
