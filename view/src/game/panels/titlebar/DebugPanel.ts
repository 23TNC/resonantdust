import { debug } from "../../../debug";
import { DomPanel } from "../../../ui/dom/DomPanel";
import type { PanelTaskbar } from "../../../ui/dom/PanelTaskbar";
import type { UiEditMode } from "../../../ui/dom/UiEditMode";
import { panelTitle, panelText } from "../panelStrings";
import { currentEnvironment } from "../../../client/environments";

/** Frames between history samples. At ~60fps that's roughly 2Hz —
 *  combined with the source's bounded history window, the sparkline
 *  spans a few minutes of trail. Tune here for a different visual
 *  trail length (smaller = denser/shorter, larger = sparser/longer). */
const HISTORY_SAMPLE_INTERVAL_FRAMES = 30;

/** Exponential-lerp factor for FPS smoothing — each tick blends the
 *  instant fps into the running average by this fraction so the readout
 *  doesn't jitter on every frame-time hiccup. */
const FPS_SMOOTHING = 0.05;

/** Format a unix-ms timestamp as `mm:ss.sss` within the current hour.
 *  Drops the high-order date/hour digits that would overflow the
 *  panel's column width and aren't useful for visual comparison
 *  between server time and `Date.now()`. */
function formatHourClock(ms: number): string {
  const intoHour = ((ms % 3_600_000) + 3_600_000) % 3_600_000;
  const minutes = Math.floor(intoHour / 60_000);
  const seconds = Math.floor((intoHour % 60_000) / 1_000);
  const millis = Math.floor(intoHour % 1_000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Format a ms delta with an explicit sign for direction-at-a-glance.
 *  Rounded to integer ms — sub-ms precision isn't meaningful here. */
function formatSignedMs(ms: number): string {
  const rounded = Math.round(ms);
  return rounded >= 0 ? `+${rounded} ms` : `${rounded} ms`;
}

const ROW_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "6px 12px",
  borderBottom: "1px solid #23252e",
};

const LABEL_CSS: Partial<CSSStyleDeclaration> = {
  color: "#a0a0b0",
};

const VALUE_CSS: Partial<CSSStyleDeclaration> = {
  color: "#ecd6aa",
};

/** Glyph button for a toggle row — transparent so only the ▣ / ▢
 *  reads, matching the value-column colour. */
const TOGGLE_BTN_CSS: Partial<CSSStyleDeclaration> = {
  background: "none",
  border: "none",
  color: "#ecd6aa",
  cursor: "pointer",
  font: "inherit",
  padding: "0",
};

/** Right-side cluster wrapping a sparkline canvas + the live value span. */
const GRAPH_RIGHT_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const SPARKLINE_W = 80;
const SPARKLINE_H = 16;

/** Draw `samples` as a sparkline into `canvas`. Auto-scales the Y axis
 *  to the range of finite values in the window, and treats `NaN` as a
 *  pen-up. Clears on each call; cheap enough to do per-frame. */
function drawSparkline(canvas: HTMLCanvasElement, samples: readonly number[]): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  if (samples.length === 0) return;
  let min = Infinity;
  let max = -Infinity;
  for (const v of samples) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const n = samples.length;
  ctx.strokeStyle = "#ecd6aa";
  ctx.lineWidth = 1;
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) { pen = false; continue; }
    const x = n === 1 ? w / 2 : (i / (n - 1)) * (w - 1) + 0.5;
    const y = h - 1 - ((v - min) / range) * (h - 2) + 0.5;
    if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
  }
  ctx.stroke();
}

/** Like `drawSparkline` but plots each sample as an isolated dot — right
 *  for series where the sample-to-sample sequence isn't a smooth curve
 *  (per-capture delivery offsets). */
function drawScatter(canvas: HTMLCanvasElement, samples: readonly number[]): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  if (samples.length === 0) return;
  let min = Infinity;
  let max = -Infinity;
  for (const v of samples) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const n = samples.length;
  ctx.fillStyle = "#ecd6aa";
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) continue;
    const x = n === 1 ? w / 2 : (i / (n - 1)) * (w - 1);
    const y = h - 1 - ((v - min) / range) * (h - 2);
    ctx.fillRect(x, y, 1, 1);
  }
}

/** Snapshot of the client-server time-sync state. Optional input to
 *  `setStats`; whatever clock source the view wires in (a future
 *  `ReducerManager` equivalent) fills it. All ms unless noted. */
export interface SyncStats {
  serverNowMs: number;
  dateNowMs: number;
  offsetMs: number;
  captures: number;
  bestOffsetMs: number | null;
  worstOffsetMs: number | null;
  deltaMs: number | null;
  clientLagMs: number;
  rttMs: number | null;
  bestRttMs: number | null;
  rttSamples: number;
  runningDeltaMs: number;
  runningDelayMs: number;
}

/** The sparkline history backing store the panel reads. Decoupled from
 *  any concrete manager so the view can drive it from whatever clock /
 *  sync subsystem it eventually grows; when no source is wired the sync
 *  graphs simply stay empty. */
export interface SyncHistorySource {
  /** Append one sample to every tracked series (called on a fixed cadence). */
  sampleSyncHistory(): void;
  /** The bounded sample window for a named series (NaN = no-data tick). */
  getHistory(name: string): readonly number[];
}

/**
 * Read-only stats HUD. Three tabs:
 *   ⓘ main — at-a-glance: clocks, offset, fps, draw calls
 *   🖌 textures — atlas occupancy + slot counts per size
 *   🛰 sync — full time-sync state (offsets, captures, RTT)
 *
 * All chrome (title bar, drag, resize, tabs, minimize, close,
 * persistence) lives in `DomPanel`. This class builds the row structure
 * for each tab and updates value spans on every `setStats` call, gated
 * on `panel.isOpen` so a closed panel doesn't churn DOM.
 */
export class DebugPanel {
  private readonly panel: DomPanel;

  // ── Main tab values ─────────────────────────────────────────────
  private readonly mainEnv:        HTMLSpanElement;
  private readonly mainServerNow:  HTMLSpanElement;
  private readonly mainOffset:     HTMLSpanElement;
  private readonly mainFps:        HTMLSpanElement;
  private readonly mainDrawCalls:  HTMLSpanElement;

  // ── Textures tab values ─────────────────────────────────────────
  private readonly texFps:         HTMLSpanElement;
  private readonly texDrawCalls:   HTMLSpanElement;
  private readonly texAtlases:     HTMLSpanElement;
  private readonly texS256:        HTMLSpanElement;
  private readonly texS128:        HTMLSpanElement;
  private readonly texS64:         HTMLSpanElement;

  // ── Sync tab values ─────────────────────────────────────────────
  private readonly syncDateNow:    HTMLSpanElement;
  private readonly syncServerNow:  HTMLSpanElement;
  private readonly syncClientLag:     { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncRunningDelta:  { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncRunningDelay:  { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncDelta:         { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncOffset:        { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncBestOffset:    { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncWorstOffset:   { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncCaptures:      { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncCaptureOffset: { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncRtt:           { value: HTMLSpanElement; canvas: HTMLCanvasElement };
  private readonly syncBestRtt:       { value: HTMLSpanElement; canvas: HTMLCanvasElement };

  private fps = 60;

  /** Optional handle to the live sync-history source. When set,
   *  `setStats` drives `sampleSyncHistory()` on a fixed-frame cadence
   *  so the sparklines have continuous history regardless of whether
   *  the panel is open. */
  private reducers?: SyncHistorySource;
  private historyTick = 0;

  constructor(
    taskbar?: PanelTaskbar,
    uiEditMode?: UiEditMode,
    reducers?: SyncHistorySource,
  ) {
    this.reducers = reducers;
    this.panel = new DomPanel({
      title: panelTitle("debugPanel"),
      storageKey: "debugPanel",
      defaultRect: { right: "36px", top: "32px", width: "260px" },
      taskbar,
      pinned: true,
      taskbarIcon: "📊",
      taskbarSide: "right",
      uiEditMode,
    });

    const mainContent     = document.createElement("div");
    const texturesContent = document.createElement("div");
    const syncContent     = document.createElement("div");

    // ── Main tab — at-a-glance ────────────────────────────────────
    this.addToggleRow(
      mainContent,
      panelText("debugPanel", "debugInfo"),
      () => debug.showInfo,
      () => debug.toggleInfo(),
    );
    this.mainEnv       = this.addRow(mainContent, panelText("debugPanel", "environment"));
    this.mainServerNow = this.addRow(mainContent, panelText("debugPanel", "serverNow"));
    this.mainOffset    = this.addRow(mainContent, panelText("debugPanel", "offset"));
    this.mainFps       = this.addRow(mainContent, panelText("debugPanel", "fps"));
    this.mainDrawCalls = this.addRow(mainContent, panelText("debugPanel", "drawCalls"));

    // ── Textures tab — atlas / slot counts ────────────────────────
    this.texFps       = this.addRow(texturesContent, panelText("debugPanel", "fps"));
    this.texDrawCalls = this.addRow(texturesContent, panelText("debugPanel", "drawCalls"));
    this.texAtlases   = this.addRow(texturesContent, panelText("debugPanel", "atlases"));
    this.texS256      = this.addRow(texturesContent, panelText("debugPanel", "size256"));
    this.texS128      = this.addRow(texturesContent, panelText("debugPanel", "size128"));
    this.texS64       = this.addRow(texturesContent, panelText("debugPanel", "size64"));

    // ── Sync tab — full time-sync state ───────────────────────────
    this.syncDateNow       = this.addRow(syncContent, panelText("debugPanel", "dateNow"));
    this.syncServerNow     = this.addRow(syncContent, panelText("debugPanel", "serverNow"));
    this.syncClientLag     = this.addGraphRow(syncContent, panelText("debugPanel", "clientDelay"));
    this.syncRunningDelay  = this.addGraphRow(syncContent, panelText("debugPanel", "runningDelay"));
    this.syncRunningDelta  = this.addGraphRow(syncContent, panelText("debugPanel", "runningDelta"));
    this.syncDelta         = this.addGraphRow(syncContent, panelText("debugPanel", "delta"));
    this.syncOffset        = this.addGraphRow(syncContent, panelText("debugPanel", "offset"));
    this.syncBestOffset    = this.addGraphRow(syncContent, panelText("debugPanel", "bestCapture"));
    this.syncWorstOffset   = this.addGraphRow(syncContent, panelText("debugPanel", "worstCapture"));
    this.syncCaptures      = this.addGraphRow(syncContent, panelText("debugPanel", "captures"));
    this.syncCaptureOffset = this.addGraphRow(syncContent, panelText("debugPanel", "captureSpread"));
    this.syncRtt           = this.addGraphRow(syncContent, panelText("debugPanel", "rtt"));
    this.syncBestRtt       = this.addGraphRow(syncContent, panelText("debugPanel", "rttBest"));

    this.panel.addTab("main",     "🛈", mainContent);
    this.panel.addTab("textures", "🖌", texturesContent);
    this.panel.addTab("sync",     "🛰", syncContent);
  }

  get isOpen(): boolean { return this.panel.isOpen; }

  toggle(): void { this.panel.toggle(); }
  open():   void { this.panel.open();   }
  close():  void { this.panel.close();  }
  destroy(): void { this.panel.destroy(); }

  /** Late-bind the sync-history source after panel construction. */
  setReducers(reducers: SyncHistorySource): void {
    this.reducers = reducers;
  }

  setStats(
    deltaMS: number,
    drawCalls: number,
    atlasStats?: { atlases: number; slotCounts: ReadonlyMap<number, number> },
    syncStats?: SyncStats,
  ): void {
    if (deltaMS > 0) {
      const instant = 1000 / deltaMS;
      this.fps = this.fps * (1 - FPS_SMOOTHING) + instant * FPS_SMOOTHING;
    }
    // History sampling runs unconditionally so the trail reflects
    // activity from before the panel was opened — the source owns the
    // bounded buffer, we just tick the clock.
    if (this.reducers && ++this.historyTick >= HISTORY_SAMPLE_INTERVAL_FRAMES) {
      this.historyTick = 0;
      this.reducers.sampleSyncHistory();
    }
    // The instant-fps calculation runs unconditionally so the running
    // average stays current; the DOM updates skip when closed.
    if (!this.panel.isOpen) return;

    this.mainEnv.textContent = currentEnvironment() ?? "—";

    const fpsText = String(Math.round(this.fps));
    const dcText  = String(drawCalls);
    this.mainFps.textContent       = fpsText;
    this.mainDrawCalls.textContent = dcText;
    this.texFps.textContent        = fpsText;
    this.texDrawCalls.textContent  = dcText;

    if (atlasStats) {
      this.texAtlases.textContent = String(atlasStats.atlases);
      this.texS256.textContent    = String(atlasStats.slotCounts.get(256) ?? 0);
      this.texS128.textContent    = String(atlasStats.slotCounts.get(128) ?? 0);
      this.texS64.textContent     = String(atlasStats.slotCounts.get(64)  ?? 0);
    }
    if (syncStats) {
      const dateNowText   = formatHourClock(syncStats.dateNowMs);
      const serverNowText = formatHourClock(syncStats.serverNowMs);
      const offsetText    = formatSignedMs(syncStats.offsetMs);
      this.mainServerNow.textContent   = serverNowText;
      this.mainOffset.textContent      = offsetText;
      this.syncDateNow.textContent     = dateNowText;
      this.syncServerNow.textContent   = serverNowText;
      this.syncOffset.value.textContent = offsetText;
      this.syncBestOffset.value.textContent =
        syncStats.bestOffsetMs === null
          ? "—"
          : formatSignedMs(syncStats.bestOffsetMs);
      this.syncWorstOffset.value.textContent =
        syncStats.worstOffsetMs === null
          ? "—"
          : formatSignedMs(syncStats.worstOffsetMs);
      this.syncDelta.value.textContent =
        syncStats.deltaMs === null
          ? "—"
          : formatSignedMs(syncStats.deltaMs);
      this.syncCaptures.value.textContent = String(syncStats.captures);
      this.syncClientLag.value.textContent     = `${Math.round(syncStats.clientLagMs)} ms`;
      this.syncRunningDelay.value.textContent  = `${Math.round(syncStats.runningDelayMs)} ms`;
      this.syncRunningDelta.value.textContent  = formatSignedMs(syncStats.runningDeltaMs);
      this.syncRtt.value.textContent =
        syncStats.rttMs === null ? "—" : `${Math.round(syncStats.rttMs)} ms`;
      this.syncBestRtt.value.textContent =
        syncStats.bestRttMs === null
          ? "—"
          : `${Math.round(syncStats.bestRttMs)} ms (n=${syncStats.rttSamples})`;

      if (this.reducers) {
        drawSparkline(this.syncClientLag.canvas,    this.reducers.getHistory("clientDelayMs"));
        drawSparkline(this.syncRunningDelay.canvas, this.reducers.getHistory("runningDelayMs"));
        drawSparkline(this.syncRunningDelta.canvas, this.reducers.getHistory("runningDeltaMs"));
        drawSparkline(this.syncDelta.canvas,        this.reducers.getHistory("deltaMs"));
        drawSparkline(this.syncOffset.canvas,       this.reducers.getHistory("offsetMs"));
        drawSparkline(this.syncBestOffset.canvas,   this.reducers.getHistory("bestOffsetMs"));
        drawSparkline(this.syncWorstOffset.canvas,  this.reducers.getHistory("worstOffsetMs"));
        drawSparkline(this.syncCaptures.canvas,     this.reducers.getHistory("captures"));
        drawSparkline(this.syncRtt.canvas,          this.reducers.getHistory("rttMs"));
        drawSparkline(this.syncBestRtt.canvas,      this.reducers.getHistory("bestRttMs"));
        const capOffsetHist = this.reducers.getHistory("captureOffsetMs");
        drawScatter(this.syncCaptureOffset.canvas, capOffsetHist);
        let capMin = Infinity;
        let capMax = -Infinity;
        for (const v of capOffsetHist) {
          if (!Number.isFinite(v)) continue;
          if (v < capMin) capMin = v;
          if (v > capMax) capMax = v;
        }
        this.syncCaptureOffset.value.textContent =
          Number.isFinite(capMin) && Number.isFinite(capMax)
            ? `${Math.round(capMax - capMin)} ms`
            : "—";
      }
    }
  }

  /** Build a toggle row: a label plus a ▣ / ▢ glyph button reflecting
   *  `getState()`. */
  private addToggleRow(
    parent: HTMLDivElement,
    label: string,
    getState: () => boolean,
    onToggle: () => void,
  ): void {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = label;
    const btn = document.createElement("button");
    Object.assign(btn.style, TOGGLE_BTN_CSS);
    const sync = (): void => { btn.textContent = getState() ? "▣" : "▢"; };
    sync();
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onToggle();
      sync();
    });
    row.appendChild(labelEl);
    row.appendChild(btn);
    parent.appendChild(row);
  }

  private addRow(parent: HTMLDivElement, label: string): HTMLSpanElement {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    Object.assign(valueEl.style, VALUE_CSS);
    valueEl.textContent = "--";
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    parent.appendChild(row);
    return valueEl;
  }

  /** Row variant with a sparkline canvas between the label and value. */
  private addGraphRow(parent: HTMLDivElement, label: string): {
    value: HTMLSpanElement;
    canvas: HTMLCanvasElement;
  } {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = label;
    const right = document.createElement("div");
    Object.assign(right.style, GRAPH_RIGHT_CSS);
    const canvas = document.createElement("canvas");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SPARKLINE_W * dpr;
    canvas.height = SPARKLINE_H * dpr;
    canvas.style.width = `${SPARKLINE_W}px`;
    canvas.style.height = `${SPARKLINE_H}px`;
    const ctx2d = canvas.getContext("2d");
    if (ctx2d) ctx2d.scale(dpr, dpr);
    const valueEl = document.createElement("span");
    Object.assign(valueEl.style, VALUE_CSS);
    valueEl.textContent = "--";
    right.appendChild(valueEl);
    right.appendChild(canvas);
    row.appendChild(labelEl);
    row.appendChild(right);
    parent.appendChild(row);
    return { value: valueEl, canvas };
  }
}
