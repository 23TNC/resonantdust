import type { GameContext } from "../../../GameContext";
import type { ChatMessage } from "../../../client/WasmClient";
import { debug } from "../../../debug";
import { DomPanel } from "../../../ui/dom/DomPanel";
import { panelTitle, panelText } from "../panelStrings";

/** How close to the bottom the scroll has to be (in px) before we
 *  consider the user "anchored" and auto-scroll new messages into
 *  view. Anything further up means the user is reading scrollback;
 *  in that case we don't yank the viewport to the new message. */
const AUTO_SCROLL_EPSILON = 4;

const TAB_CONTENT_CSS: Partial<CSSStyleDeclaration> = {
  flex: "1 1 auto",
  overflowY: "auto",
  overflowX: "hidden",
  padding: "6px 8px",
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  fontFamily: "sans-serif",
  fontSize: "13px",
  color: "#dddddd",
};

const MESSAGE_ROW_CSS: Partial<CSSStyleDeclaration> = {
  wordBreak: "break-word",
  lineHeight: "1.35",
};

const SENDER_CSS: Partial<CSSStyleDeclaration> = {
  color: "#ecd6aa",
  fontWeight: "600",
  marginRight: "4px",
};

const LOG_ROW_CSS: Partial<CSSStyleDeclaration> = {
  wordBreak: "break-word",
  lineHeight: "1.35",
  color: "#a0c0e0",
  fontStyle: "italic",
};

/** Client-only feedback line for a slash command (echoed in the general feed,
 *  never sent). Dimmer + italic so it reads as chrome, not a real message. */
const SYSTEM_ROW_CSS: Partial<CSSStyleDeclaration> = {
  wordBreak: "break-word",
  lineHeight: "1.35",
  color: "#8a93a3",
  fontStyle: "italic",
};

/** Handler for a slash command. `args` is the whitespace-split tail after the
 *  command name. Return a string to echo a feedback line in the feed, or
 *  nothing for a silent command. */
export type ChatCommand = (args: string[]) => string | void;

const FOOTER_CSS: Partial<CSSStyleDeclaration> = {
  padding: "6px 8px",
  borderTop: "1px solid #2a3340",
  background: "rgba(12, 14, 20, 0.96)",
};

const INPUT_CSS: Partial<CSSStyleDeclaration> = {
  width: "100%",
  boxSizing: "border-box",
  background: "#0e1318",
  color: "#ffffff",
  border: "1px solid #2a3340",
  borderRadius: "3px",
  outline: "none",
  fontFamily: "sans-serif",
  fontSize: "13px",
  padding: "4px 8px",
  margin: "0",
};

/**
 * Chat panel — pure DOM. Hosts two tabs ("general" / "logs") inside a
 * `DomPanel` shell, with a footer-anchored input for sending messages.
 *
 * The shell handles drag, resize, minimize/close, position + tab
 * persistence, and the chrome (title bar, action buttons). This class
 * is just data wiring:
 *   - subscribes to `ctx.client.onChat` for the general feed (the worker
 *     drains the wasm client's `chat_messages` subscription each pump and
 *     forwards batches sorted by `sentAt`; the actual gate subscription
 *     was issued by the worker on login)
 *   - subscribes to `ctx.logs` for the client-only flavor-text feed
 *   - sends on `Enter` via `ctx.client.sendChat` — the sender id/name are
 *     filled from the session inside the client core, so the message
 *     echoes back through `onChat` like everyone else's (no local echo)
 *
 * Per-message rendering is a single `<div>` appended to the general tab's
 * scroll container, keyed by `sentAt` so duplicate batches (or a re-fold)
 * don't double-render. Auto-scroll-to-bottom kicks in only when the user
 * is already pinned to the bottom — scrolling up to read older messages
 * keeps the viewport steady when new rows arrive.
 *
 * Lifecycle: the panel is owned by `WorldScene`. `destroy()` tears down
 * the chat + logs subscriptions and removes the DOM element. The gate
 * chat subscription itself lives for the connection (the worker owns it).
 */
export class ChatPanel {
  private readonly panel: DomPanel;
  private readonly generalContent: HTMLDivElement;
  private readonly logsContent:    HTMLDivElement;
  private readonly inputEl:        HTMLInputElement;

  /** Map of chat `sentAt` (the packed-u64 PK, as a string) → rendered DOM
   *  node. Dedupes against repeated batches and is the seam for a future
   *  retention-sweep delete (drop one node without re-rendering). */
  private readonly generalRows = new Map<string, HTMLDivElement>();

  private readonly unsubChat: () => void;
  private readonly unsubLogs: () => void;
  private readonly client: GameContext["client"];
  /** Slash-command handlers, keyed by lowercased command name (no leading `/`).
   *  The host scene registers these via {@link registerCommand} — the panel
   *  itself knows nothing about what they do. */
  private readonly commands = new Map<string, ChatCommand>();

  get isOpen(): boolean { return this.panel.isOpen; }

  constructor(ctx: GameContext) {
    this.client = ctx.client;
    this.panel = new DomPanel({
      title: panelTitle("chatPanel"),
      storageKey: "chatPanel",
      // Bottom-left above the taskbar strip. Content defaults
      // (`view/src/content/panels/defaults.json` → `chatPanel`) snap + pin it
      // there; this rect is just the pre-defaults fallback.
      defaultRect: { left: "0", bottom: "32px", width: "360px", height: "260px" },
      minWidth:  280,
      minHeight: 160,
      taskbar: ctx.taskbar,
      pinned: true,
      uiEditMode: ctx.uiEditMode,
    });

    this.generalContent = this.makeScrollContainer();
    this.logsContent    = this.makeScrollContainer();
    this.panel.addTab("general", "💬", this.generalContent);
    this.panel.addTab("logs",    "📜", this.logsContent);

    // Footer: one input shared across tabs. Native focus / caret / IME
    // come for free.
    const footer = document.createElement("div");
    Object.assign(footer.style, FOOTER_CSS);
    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.autocomplete = "off";
    this.inputEl.placeholder = panelText("chatPanel", "inputPlaceholder");
    Object.assign(this.inputEl.style, INPUT_CSS);
    this.inputEl.addEventListener("keydown", (e) => this.onInputKeyDown(e));
    footer.appendChild(this.inputEl);
    this.panel.setFooter(footer);

    // ── Chat feed ─────────────────────────────────────────────────
    // The worker subscribed `chat_messages` on login and forwards each
    // pump's freshly-folded messages here, sorted by `sentAt`. We just
    // append. A batch that arrives before this listener is installed is
    // lost to the panel — but in practice the panel opens in the same
    // `onEnter` tick as login resolves, and the gate replays the recent
    // backlog (1 h retention) right after the subscription applies.
    this.unsubChat = ctx.client.onChat((messages) => {
      debug.log(["chat"], `[ChatPanel] received ${messages.length} message(s)`);
      for (const m of messages) this.appendChatRow(m);
    });

    // ── Client-only logs feed ─────────────────────────────────────
    // `ctx.logs` is a `LogManager` (push-only, no retention sweep); we
    // render the buffer on every push. Null until a game system wires
    // one in — the tab just stays empty.
    if (ctx.logs) {
      this.renderLogs(ctx);
      this.unsubLogs = ctx.logs.subscribe(() => this.renderLogs(ctx));
    } else {
      this.unsubLogs = () => { /* no logs source — no-op */ };
    }
  }

  open():   void { this.panel.open();   }
  close():  void { this.panel.close();  }

  /** Register a slash command. Typing `/<name> …` in the input runs `handler`
   *  with the whitespace-split args instead of sending a message; a returned
   *  string is echoed as a system line. Re-registering a name replaces it. The
   *  host scene owns the handlers (selection, editor, …); the panel only parses. */
  registerCommand(name: string, handler: ChatCommand): void {
    this.commands.set(name.toLowerCase(), handler);
  }

  destroy(): void {
    this.unsubChat();
    this.unsubLogs();
    this.panel.destroy();
  }

  // ── Internals ────────────────────────────────────────────────────

  private makeScrollContainer(): HTMLDivElement {
    const div = document.createElement("div");
    Object.assign(div.style, TAB_CONTENT_CSS);
    return div;
  }

  private onInputKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      const text = this.inputEl.value.trim();
      this.inputEl.value = "";
      if (text.length > 0) {
        // A leading `/` is a command, not a message — parse + dispatch locally,
        // never hit the wire. `//foo` escapes to a literal message starting `/`.
        if (text.startsWith("/") && !text.startsWith("//")) {
          this.runCommand(text);
        } else {
          const body = text.startsWith("//") ? text.slice(1) : text;
          debug.log(["chat"], `[ChatPanel] sending message len=${body.length}`);
          // Fire-and-forget: the core fills sender id/name, the shard
          // trims/validates, and the message echoes back through `onChat`.
          this.client.sendChat(body);
        }
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.inputEl.blur();
    }
    // Keep keystrokes from bubbling to the game's input handling.
    e.stopPropagation();
  }

  /** Parse `/<name> <args…>` and dispatch to a registered handler. Unknown
   *  commands echo a system line; a handler's returned string is echoed too. */
  private runCommand(raw: string): void {
    const parts = raw.slice(1).trim().split(/\s+/);
    const name = (parts.shift() ?? "").toLowerCase();
    if (name.length === 0) return;
    debug.log(["chat"], `[ChatPanel] command /${name} args=[${parts.join(", ")}]`);
    const handler = this.commands.get(name);
    if (!handler) {
      this.appendSystemLine(`Unknown command: /${name}`);
      return;
    }
    const feedback = handler(parts);
    if (typeof feedback === "string" && feedback.length > 0) {
      this.appendSystemLine(feedback);
    }
  }

  /** Append a chat message's `<div>` to the general tab, keyed by
   *  `sentAt` to dedupe. When the user was pinned to the bottom before
   *  the append, scroll the new row into view; otherwise leave the
   *  viewport where the user parked it (reading scrollback). */
  private appendChatRow(m: ChatMessage): void {
    if (this.generalRows.has(m.sentAt)) return;
    const pinned = this.isPinnedToBottom(this.generalContent);
    const node = document.createElement("div");
    Object.assign(node.style, MESSAGE_ROW_CSS);
    const sender = document.createElement("span");
    Object.assign(sender.style, SENDER_CSS);
    sender.textContent = `${m.senderName}:`;
    const body = document.createElement("span");
    body.textContent = ` ${m.body}`;
    node.appendChild(sender);
    node.appendChild(body);
    this.generalContent.appendChild(node);
    this.generalRows.set(m.sentAt, node);
    if (pinned) this.scrollToBottom(this.generalContent);
  }

  /** Echo a client-only system line into the general feed (command feedback —
   *  unknown command, "no card selected", etc.). Not keyed in `generalRows`
   *  (it's ephemeral local chrome, not a server row) and follows the same
   *  pin-to-bottom auto-scroll rule as real messages. */
  private appendSystemLine(text: string): void {
    const pinned = this.isPinnedToBottom(this.generalContent);
    const node = document.createElement("div");
    Object.assign(node.style, SYSTEM_ROW_CSS);
    node.textContent = text;
    this.generalContent.appendChild(node);
    if (pinned) this.scrollToBottom(this.generalContent);
  }

  /** Full re-render of the logs tab — the buffer is push-only and short
   *  (game-event blurbs), so re-rendering is cheaper than the bookkeeping
   *  needed for incremental appends. */
  private renderLogs(ctx: GameContext): void {
    const log = ctx.logs;
    if (!log) return;
    const pinned = this.isPinnedToBottom(this.logsContent);
    while (this.logsContent.firstChild) {
      this.logsContent.removeChild(this.logsContent.firstChild);
    }
    for (const entry of log.getAll()) {
      const node = document.createElement("div");
      Object.assign(node.style, LOG_ROW_CSS);
      node.textContent = entry.text;
      this.logsContent.appendChild(node);
    }
    if (pinned) this.scrollToBottom(this.logsContent);
  }

  private isPinnedToBottom(el: HTMLDivElement): boolean {
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distance <= AUTO_SCROLL_EPSILON;
  }

  private scrollToBottom(el: HTMLDivElement): void {
    el.scrollTop = el.scrollHeight;
  }
}
