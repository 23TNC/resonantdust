import { debug } from "../../../debug";
import { DomPanel } from "../../../ui/dom/DomPanel";
import type { PanelTaskbar } from "../../../ui/dom/PanelTaskbar";
import type { UiEditMode } from "../../../ui/dom/UiEditMode";
import { panelTitle, panelText } from "../panelStrings";
import { currentEnvironment, httpBaseFor } from "../../../client/environments";
import { getContentVersion } from "../../definitions/contentBoot";
import type { CallStat, SubStat } from "../../../client/WasmClient";

/** The gate's `/versions` payload: baked source-closure hashes per component
 *  (`server`) plus the gate's live content fingerprint (`content_live`). */
interface VersionsResponse {
  server: {
    build: number;
    generated: string;
    components: Record<string, { hash: string; seq: number; ts: string }>;
  };
  content_live: string;
}

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

/** Versions-tab refresh button — full-width, subdued chrome. */
const REFRESH_BTN_CSS: Partial<CSSStyleDeclaration> = {
  display: "block",
  width: "calc(100% - 24px)",
  margin: "6px 12px",
  padding: "4px 0",
  background: "#23252e",
  border: "1px solid #34363f",
  borderRadius: "3px",
  color: "#ecd6aa",
  cursor: "pointer",
  font: "inherit",
};

/** Versions-tab value colours: match (green) / drift (red). */
const VERSION_OK_COLOR = "#7bd88f";
const VERSION_DRIFT_COLOR = "#e06c75";

/** Stat-table chrome (calls + subs tabs): full width, collapsed borders, small
 *  monospace-ish digits. */
const STAT_TABLE_CSS: Partial<CSSStyleDeclaration> = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.82em",
};

/** Stat-table header cell — dim, ruled underline, tight padding. */
const STAT_TH_CSS: Partial<CSSStyleDeclaration> = {
  color: "#6a6c78",
  fontWeight: "normal",
  padding: "4px 6px",
  borderBottom: "1px solid #23252e",
};

/** Stat-table body cell — value colour, tight padding. */
const STAT_TD_CSS: Partial<CSSStyleDeclaration> = {
  color: "#ecd6aa",
  padding: "3px 6px",
};

/** Calls-tab columns: [header label, text-align]. Order matches `renderCalls`. */
const CALLS_COLUMNS: ReadonlyArray<readonly [string, "left" | "right"]> = [
  ["cmd", "left"],
  ["req", "right"],
  ["ok", "right"],
  ["err", "right"],
  ["prom", "right"],
  ["tx", "right"],
  ["rx", "right"],
];

/** Subs-tab columns: [header label, text-align]. Order matches `renderSubs`. */
const SUBS_COLUMNS: ReadonlyArray<readonly [string, "left" | "right"]> = [
  ["table", "left"],
  ["subs", "right"],
  ["tx", "right"],
  ["rx", "right"],
];

/** Versions-tab value cell: hash stacked above its dim timestamp. */
const VERSION_VALUE_CSS: Partial<CSSStyleDeclaration> = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  color: "#ecd6aa",
};

/** The per-component change timestamp under each hash — small + subdued. */
const VERSION_TS_CSS: Partial<CSSStyleDeclaration> = {
  color: "#6a6c78",
  fontSize: "0.82em",
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
  // Cursor coordinate readout (debug): tile → zone (macro) → region, derived
  // from the codec formula so it's the REFERENCE to compare against where tiles
  // actually load/render.
  private readonly mainTile:       HTMLSpanElement;
  private readonly mainZone:       HTMLSpanElement;
  private readonly mainRegion:     HTMLSpanElement;

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

  // ── Versions tab — per-component build-hash drift ───────────────
  private readonly versionsBody: HTMLDivElement;

  // ── Calls tab — per-reducer gateway-call tally ──────────────────
  private readonly callsBody: HTMLDivElement;
  /** Latest tally pushed from the worker, retained so opening the panel can
   *  render immediately (the worker only pushes every pump). */
  private lastCallStats: CallStat[] = [];

  // ── Subs tab — per-table subscription tally ─────────────────────
  private readonly subsBody: HTMLDivElement;
  /** Latest tally pushed from the worker, retained so opening renders at once. */
  private lastSubStats: SubStat[] = [];

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
    const versionsContent = document.createElement("div");
    const callsContent    = document.createElement("div");
    const subsContent     = document.createElement("div");

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
    this.mainTile      = this.addRow(mainContent, "tile local (world)");
    this.mainZone      = this.addRow(mainContent, "zone (q,r)");
    this.mainRegion    = this.addRow(mainContent, "region (q,r)");

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

    // ── Versions tab — client vs gate build hashes ────────────────
    // A refresh button + a body the fetch repopulates. The client side comes
    // from the build-injected snapshot (__BUILD_VERSIONS__); the gate side from
    // a live /versions fetch. Compared per component to surface a stale
    // deployment (or a stale client).
    const refreshBtn = document.createElement("button");
    Object.assign(refreshBtn.style, REFRESH_BTN_CSS);
    refreshBtn.textContent = panelText("debugPanel", "refresh");
    refreshBtn.onclick = () => { void this.refreshVersions(); };
    versionsContent.appendChild(refreshBtn);
    this.versionsBody = document.createElement("div");
    versionsContent.appendChild(this.versionsBody);

    // ── Calls tab — per-reducer gateway-call tally ────────────────
    // A body the worker's per-pump `callStats` push repopulates with a table
    // (one row per reducer + a totals row). Empty until the first call goes out.
    this.callsBody = document.createElement("div");
    callsContent.appendChild(this.callsBody);
    this.renderCalls();

    // ── Subs tab — per-table subscription tally ───────────────────
    // A body the worker's per-pump `subStats` push repopulates with a table
    // (one row per subscribed table + a totals row). Empty until the first sub.
    this.subsBody = document.createElement("div");
    subsContent.appendChild(this.subsBody);
    this.renderSubs();

    this.panel.addTab("main",     "🛈", mainContent);
    this.panel.addTab("textures", "🖌", texturesContent);
    this.panel.addTab("sync",     "🛰", syncContent);
    this.panel.addTab("versions", "🏷", versionsContent);
    this.panel.addTab("calls",    "📡", callsContent);
    this.panel.addTab("subs",     "📥", subsContent);

    // Initial fill (best-effort — shows "not connected" until login sets the env).
    void this.refreshVersions();
  }

  /** Live cursor coordinate readout. `tileLocal` is the cell INSIDE the current
   *  macro_zone (0..6, the owner-origin at 3,3); `tileWorld` is the global tile.
   *  `zone` / `region` are the macro_zone / region the cell maps to (codec
   *  formula). Drives the debug bug-hunt for the 7×7 / centre-at-(0,0) handling. */
  setCursorCoords(
    tileLocal: { q: number; r: number },
    tileWorld: { q: number; r: number },
    zone: { q: number; r: number },
    region: { q: number; r: number },
  ): void {
    if (!this.panel.isOpen) return;
    this.mainTile.textContent   = `${tileLocal.q}, ${tileLocal.r}   (w ${tileWorld.q}, ${tileWorld.r})`;
    this.mainZone.textContent   = `${zone.q}, ${zone.r}`;
    this.mainRegion.textContent = `${region.q}, ${region.r}`;
  }

  get isOpen(): boolean { return this.panel.isOpen; }

  toggle(): void { this.panel.toggle(); }
  open():   void { this.panel.open(); void this.refreshVersions(); this.renderCalls(); this.renderSubs(); }
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

  // ── Versions tab ────────────────────────────────────────────────

  /** Render the client-baked hashes immediately (the core of the tab — no
   *  network needed), then TRY to fetch the gate's `/versions` to add a
   *  comparison column. A missing env or a failed fetch is non-fatal: the
   *  hashes stay on screen, just without the gate column. */
  private async refreshVersions(): Promise<void> {
    this.renderVersions(null); // always show client hashes first
    const env = currentEnvironment();
    if (!env) return;
    try {
      const resp = await fetch(`${httpBaseFor(env)}/versions`);
      if (resp.ok) this.renderVersions((await resp.json()) as VersionsResponse);
      // A non-OK / unreachable gate just means no comparison — leave the
      // client-only view in place (already rendered above).
    } catch {
      /* gate without /versions yet, or offline — client-only view stands. */
    }
  }

  /** Rebuild the versions body from the build-injected snapshot. When `server`
   *  is present, each row also compares against the gate (green ✓ / red drift);
   *  when it's null, rows just display the client hash. */
  private renderVersions(server: VersionsResponse | null): void {
    const body = this.versionsBody;
    body.replaceChildren();

    const client = __BUILD_VERSIONS__;
    if (!client) {
      const row = document.createElement("div");
      Object.assign(row.style, ROW_CSS);
      row.textContent = "no build snapshot (run bin/versions)";
      body.appendChild(row);
      return;
    }

    // Build number (the running ledger version), stamped with when the snapshot
    // was generated.
    body.appendChild(this.versionRow(
      panelText("debugPanel", "build"),
      String(client.build),
      server ? String(server.server.build) : undefined,
      client.generated,
    ));

    // Per-component source-closure hashes + the timestamp each last changed.
    // Union both key sets so a component on only one side still shows.
    const names = new Set<string>([
      ...Object.keys(client.components),
      ...Object.keys(server?.server.components ?? {}),
    ]);
    for (const name of names) {
      if (name === "content") continue; // shown live below, not by source hash
      body.appendChild(this.versionRow(
        name,
        client.components[name]?.hash,
        server?.server.components[name]?.hash,
        client.components[name]?.ts,
      ));
    }

    // Content hot-swaps without a rebuild, so its LIVE fingerprint is the real
    // signal: what the client loaded vs (when available) the gate's current.
    body.appendChild(this.versionRow(
      panelText("debugPanel", "contentLive"),
      getContentVersion() || undefined,
      server?.content_live,
    ));
  }

  /** One row: label on the left; on the right the hash (or client ⇄ gate
   *  comparison) above a dim timestamp of when that component last changed.
   *  No gate value → plain client hash; otherwise green ✓ / red drift. */
  private versionRow(label: string, clientH?: string, serverH?: string, ts?: string): HTMLDivElement {
    const row = document.createElement("div");
    Object.assign(row.style, ROW_CSS);
    const labelEl = document.createElement("span");
    Object.assign(labelEl.style, LABEL_CSS);
    labelEl.textContent = label;

    const valueEl = document.createElement("div");
    Object.assign(valueEl.style, VERSION_VALUE_CSS);
    const hashEl = document.createElement("span");
    if (serverH === undefined) {
      hashEl.style.color = VALUE_CSS.color ?? "";
      hashEl.textContent = short(clientH);
    } else {
      const match = !!clientH && clientH === serverH;
      hashEl.style.color = match ? VERSION_OK_COLOR : VERSION_DRIFT_COLOR;
      hashEl.textContent = match ? `✓ ${short(clientH)}` : `${short(clientH)} ⇄ ${short(serverH)}`;
    }
    valueEl.appendChild(hashEl);
    if (ts) {
      const tsEl = document.createElement("span");
      Object.assign(tsEl.style, VERSION_TS_CSS);
      tsEl.textContent = fmtTs(ts);
      valueEl.appendChild(tsEl);
    }

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    return row;
  }

  // ── Calls tab ───────────────────────────────────────────────────

  /** Receive the latest per-reducer gateway-call tally (pushed each pump). Retain
   *  it so a later `open()` can render immediately, and rebuild the table now if
   *  the panel is open (skip the DOM churn otherwise). */
  setCallStats(stats: CallStat[]): void {
    this.lastCallStats = stats;
    if (this.panel.isOpen) this.renderCalls();
  }

  /** Rebuild the calls table from {@link lastCallStats}: one row per reducer
   *  (command, request count, ok/err/promise reply counts, tx/rx byte estimates)
   *  plus a totals row. Error counts highlight red when non-zero. */
  private renderCalls(): void {
    const body = this.callsBody;
    body.replaceChildren();

    if (this.lastCallStats.length === 0) {
      body.appendChild(this.statEmpty("no gateway calls yet"));
      return;
    }

    const table = this.statTable(CALLS_COLUMNS);
    const tbody = table.createTBody();
    const totals = { requests: 0, ok: 0, err: 0, promise: 0, tx: 0, rx: 0 };
    for (const s of this.lastCallStats) {
      totals.requests += s.requests;
      totals.ok += s.ok;
      totals.err += s.err;
      totals.promise += s.promise;
      totals.tx += s.tx;
      totals.rx += s.rx;
      const row = tbody.insertRow();
      this.statCell(row, s.command, "left");
      this.statCell(row, String(s.requests), "right");
      this.statCell(row, String(s.ok), "right");
      this.statCell(row, String(s.err), "right", s.err > 0 ? VERSION_DRIFT_COLOR : undefined);
      this.statCell(row, String(s.promise), "right");
      this.statCell(row, fmtBytes(s.tx), "right");
      this.statCell(row, fmtBytes(s.rx), "right");
    }

    // Totals row — bold, top-ruled, to separate it from the per-reducer rows.
    const totalRow = tbody.insertRow();
    this.statCell(totalRow, "total", "left", undefined, true);
    this.statCell(totalRow, String(totals.requests), "right", undefined, true);
    this.statCell(totalRow, String(totals.ok), "right", undefined, true);
    this.statCell(totalRow, String(totals.err), "right", totals.err > 0 ? VERSION_DRIFT_COLOR : undefined, true);
    this.statCell(totalRow, String(totals.promise), "right", undefined, true);
    this.statCell(totalRow, fmtBytes(totals.tx), "right", undefined, true);
    this.statCell(totalRow, fmtBytes(totals.rx), "right", undefined, true);

    body.appendChild(table);
  }

  // ── Subs tab ────────────────────────────────────────────────────

  /** Receive the latest per-table subscription tally (pushed each pump). Retain
   *  it for a later `open()`, and rebuild the table now if the panel is open. */
  setSubStats(stats: SubStat[]): void {
    this.lastSubStats = stats;
    if (this.panel.isOpen) this.renderSubs();
  }

  /** Rebuild the subs table from {@link lastSubStats}: one row per subscribed
   *  table (open-subscription count + tx/rx byte estimates) plus a totals row.
   *  `subs` is a LIVE gauge (current open count); `tx`/`rx` are cumulative. */
  private renderSubs(): void {
    const body = this.subsBody;
    body.replaceChildren();

    if (this.lastSubStats.length === 0) {
      body.appendChild(this.statEmpty("no subscriptions yet"));
      return;
    }

    const table = this.statTable(SUBS_COLUMNS);
    const tbody = table.createTBody();
    const totals = { subs: 0, tx: 0, rx: 0 };
    for (const s of this.lastSubStats) {
      totals.subs += s.subs;
      totals.tx += s.tx;
      totals.rx += s.rx;
      const row = tbody.insertRow();
      this.statCell(row, s.table, "left");
      this.statCell(row, String(s.subs), "right");
      this.statCell(row, fmtBytes(s.tx), "right");
      this.statCell(row, fmtBytes(s.rx), "right");
    }

    const totalRow = tbody.insertRow();
    this.statCell(totalRow, "total", "left", undefined, true);
    this.statCell(totalRow, String(totals.subs), "right", undefined, true);
    this.statCell(totalRow, fmtBytes(totals.tx), "right", undefined, true);
    this.statCell(totalRow, fmtBytes(totals.rx), "right", undefined, true);

    body.appendChild(table);
  }

  // ── Stat-table builders (shared by the calls + subs tabs) ───────

  /** An empty `<table>` with a styled header row built from `columns`. */
  private statTable(columns: ReadonlyArray<readonly [string, "left" | "right"]>): HTMLTableElement {
    const table = document.createElement("table");
    Object.assign(table.style, STAT_TABLE_CSS);
    const head = table.createTHead().insertRow();
    for (const [label, align] of columns) {
      const th = document.createElement("th");
      th.textContent = label;
      Object.assign(th.style, STAT_TH_CSS);
      th.style.textAlign = align;
      head.appendChild(th);
    }
    return table;
  }

  /** A dim "nothing yet" placeholder row for an empty stat table. */
  private statEmpty(text: string): HTMLDivElement {
    const empty = document.createElement("div");
    Object.assign(empty.style, ROW_CSS);
    Object.assign(empty.style, LABEL_CSS);
    empty.textContent = text;
    return empty;
  }

  /** Append one `<td>` to `row` with the stat-table cell styling. */
  private statCell(
    row: HTMLTableRowElement,
    text: string,
    align: "left" | "right",
    color?: string,
    total = false,
  ): void {
    const td = row.insertCell();
    td.textContent = text;
    Object.assign(td.style, STAT_TD_CSS);
    td.style.textAlign = align;
    if (color) td.style.color = color;
    if (total) {
      td.style.fontWeight = "bold";
      td.style.borderTop = "1px solid #34363f";
    }
  }
}

/** Format a byte count compactly: `B` / `K` / `M` (1024-based), for the calls
 *  tab's tx/rx columns where exact bytes would overflow the narrow cell. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} K`;
  return `${(n / 1024 / 1024).toFixed(1)} M`;
}

/** Compact UTC `YYYY-MM-DD HH:MM` from an ISO timestamp (no Date parse — the
 *  ledger stamps are already ISO `…Z`). */
function fmtTs(iso: string): string {
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;
}

/** First 10 chars of a hash (enough to eyeball), or an em dash if absent. */
function short(h?: string): string {
  return h ? h.slice(0, 10) : "—";
}
