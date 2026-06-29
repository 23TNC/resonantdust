//! `view` entry point — boots the copied scene + panel infrastructure.
//!
//! This is the foundation of the pixijs client rebuild: a PIXI Application, the
//! SceneManager, and the two panel taskbars + UI edit mode that the panel
//! framework needs, wired into a minimal `GameContext`. Game subsystems
//! (data/cards/actions/world) are rebuilt on top from here.

import { Application, Assets } from "pixi.js";
import { loadFonts } from "./assets/fonts";
import { SceneManager } from "./scenes/SceneManager";
import { LoginScene } from "./scenes/login/LoginScene";
import { PanelTaskbar } from "./ui/dom/PanelTaskbar";
import { UiEditMode } from "./ui/dom/UiEditMode";
import { PanelSettingsPopup } from "./ui/dom/PanelSettingsPopup";
import { DomPanel } from "./ui/dom/DomPanel";
import { DrawCallCounter } from "./debug/DrawCallCounter";
import { mountEnvOverlay } from "./debug/EnvOverlay";
import { SettingsMenu } from "./game/panels/titlebar/SettingsMenu";
import { DebugPanel } from "./game/panels/titlebar/DebugPanel";
import type { SyncStats } from "./game/panels/titlebar/DebugPanel";
import { SyncHistory } from "./game/panels/titlebar/syncHistory";
import type { ClockStats, CallStat, SubStat } from "./client/WasmClient";
// Panel layout defaults are a pure client concern (DOM panel geometry) — NOT
// gate-served content, so they live in the view, not the repo-root `content/`
// tree. This is the single source of truth the panel-settings "Copy All JSON"
// export pastes into; there is no repo-root copy to drift against.
import panelDefaults from "./content/panels/defaults.json";
import { WasmClient } from "./client/WasmClient";
import { gateUrlFor, httpBaseFor, type Environment } from "./client/environments";
import { TextureManager } from "./assets/textures/TextureManager";
import { LodTextureManager } from "./assets/textures/LodTextureManager";
import { GeometryStore } from "./assets/geometry/GeometryStore";
import { ObjectManager } from "./assets/ObjectManager";
import { DefinitionManager } from "./game/definitions/DefinitionManager";
import { reloadContent, initContentFromCache, sharedContent } from "./game/definitions/contentBoot";
import { lastEnv } from "./game/definitions/contentCache";
import { persistStorage } from "./assets/textures/previewCache";
import type { GameContext } from "./GameContext";


async function main(): Promise<void> {
  const app = new Application();
  await app.init({
    background: 0x101418,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    // The normal-mapped lighting shader (LitSprite) is composed as a GLSL-only
    // high-shader program, so force WebGL until a WGSL variant exists.
    preference: "webgl",
  });
  const host = document.getElementById("app");
  if (!host) throw new Error("#app element not found");
  host.appendChild(app.canvas);

  // Always-on env badge (top-left) so it's never ambiguous which gate this
  // session is talking to — dev/claude/test/alpha, color-coded.
  mountEnvOverlay();

  // Texture asset origin. LOD textures are served from a Cloudflare R2 bucket —
  // the only `Assets.load` consumer is LodTextureManager, and the relative
  // `/textures/lod/...` URL keys stay unchanged: PIXI's `basePath` rewrites a
  // leading-`/` URL against the base's origin at fetch time (see path.toAbsolute),
  // so `/textures/lod/x.png` -> `<base>/textures/lod/x.png`. Fonts use the
  // `FontFace` API (not Assets), so they're unaffected.
  //
  // Override with `VITE_TEXTURE_BASE`; set it to "" to serve same-origin from
  // local `public/` (faster remaster iteration). NOTE: the bucket MUST return
  // CORS headers (Access-Control-Allow-Origin) or WebGL rejects the cross-origin
  // textures — curl 200s but the browser won't upload them to a GL texture.
  const TEXTURE_BASE =
    import.meta.env.VITE_TEXTURE_BASE ??
    "https://r2.resonantdust.com";
  await Assets.init({ basePath: TEXTURE_BASE });

  // Content-shipped panel layout defaults — positions / sizes / toggle states
  // every `DomPanel` merges between its constructor opts and any persisted
  // localStorage state. Installed once here, before any panel constructs.
  // `_`-prefixed keys (comment metadata) are stripped inside setPanelDefaults.
  DomPanel.setPanelDefaults(panelDefaults as Parameters<typeof DomPanel.setPanelDefaults>[0]);

  // Per-frame draw-call counter — patches the GL context so the debug panel
  // can report draw calls. Read + reset once per scene tick.
  const drawCalls = new DrawCallCounter();
  drawCalls.patch(app.renderer);

  await loadFonts();

  // Texture management — the LOD atlas system, retained from the pixijs client.
  // `LodTextureManager` owns two atlases: the master atlas (full-res, fetched
  // per-stem at the footprint's LOD) and an internal low-res PREVIEW atlas it
  // falls back to before the white fallback — so a streaming texture shows a
  // placeholder, not a white square. Card-face baking (CardTextureManager) is
  // deferred to the card port.
  const textures = new TextureManager(app.renderer);
  const lodTextures = new LodTextureManager(textures, app.renderer);
  // On-miss LOD generation falls back to the gate; default to the dev gate until
  // login re-points it at the selected environment (mirrors the wasm client URL).
  lodTextures.setGateBase(httpBaseFor("dev"));
  // The R2/CDN origin Assets fetches from — the persisted-preview path needs it
  // for absolute `fetch()` byte reads. Ask for durable storage so the pinned
  // preview floor (IndexedDB) survives between sessions (best-effort).
  lodTextures.setTextureBase(TEXTURE_BASE);
  // Silhouette-geometry sidecars (first-frame placeholders) — same origins as the
  // LOD fetches: R2-direct, gate on miss (the gate generates the sidecar from the
  // master). Prewarmed over `previewStems()` at login so geometry is resident
  // before cards render.
  const geometry = new GeometryStore();
  geometry.setGateBase(httpBaseFor("dev"));
  geometry.setTextureBase(TEXTURE_BASE);
  // Wire the geo fill tier: a stem with no preview/LOD yet allocates its stable
  // frame from the sidecar silhouette, upgraded in place as content lands.
  lodTextures.setGeometry(geometry);
  void persistStorage();
  const objects = new ObjectManager(lodTextures);
  // Optimistic pre-login warm: if a previous session cached a corpus, seed the
  // content runtime from it and kick the LOW-lane preview prewarm now (during the
  // login screen). A returning player's placeholders fetch from HTTP disk cache
  // and are ready before login completes, so the world doesn't flash white. No-op
  // on a first-ever visit; reconciled against the gate's corpus at login.
  void prewarmFromCache(lodTextures);
  // Textures otherwise resolve per-stem from the wasm VM and stream from R2 (white
  // fallback until they land), so there's nothing to block boot on.
  const assetsReady = Promise.resolve();

  const scenes = new SceneManager(app);

  // Panel framework: a bottom + top taskbar and the UI layout-edit toggle.
  const taskbar = new PanelTaskbar({ position: "bottom" });
  const topTaskbar = new PanelTaskbar({ position: "top" });
  const uiEditMode = new UiEditMode({
    reservedTop: PanelTaskbar.HEIGHT,
    reservedBottom: PanelTaskbar.HEIGHT,
  });
  // The per-panel settings popup (UI-edit-mode flyout) is app-global so every
  // scene's panels are editable — including the login screen. Its labels
  // resolve via `panelStrings`, which falls back to a bundled English copy
  // before gate content loads, so they read correctly even pre-login.
  const settingsPopup = new PanelSettingsPopup();
  uiEditMode.settingsPopup = settingsPopup;

  // The Rust client core (wasm) — owns the gate connection + login + world.
  // Seeded with the dev gate; the login screen re-points it at the environment
  // the user selects before logging in.
  const client = new WasmClient(gateUrlFor("dev"));

  // Packed-definition decoder (stub until content loading lands in the worker).
  const definitions = new DefinitionManager();

  // Gate content hot-swap → refresh the render-side content. The worker has
  // already reloaded its matcher bundle; `reloadContent` re-fetches `/content`,
  // swaps `Content`/`Locales`, and fires `onContentReloaded` (DefinitionManager /
  // globals / each WorldRenderer rebuild). Session-long; no teardown needed.
  client.onContentChanged(() => {
    // A new manifest may have added masters that previously 404'd — let the
    // texture loader re-probe them (mirrors the gate's absent-cache flush).
    lodTextures.clearAbsent();
    void reloadContent();
  });

  const ctx: GameContext = {
    app,
    scenes,
    client,
    textures,
    lodTextures,
    geometry,
    objects,
    assetsReady,
    taskbar,
    topTaskbar,
    uiEditMode,
    drawCalls,
    panels: null,
    definitions,
    layout: null,
    input: null,
    logs: null,
  };
  scenes.setContext(ctx);

  // ── App-global title-bar tools ──────────────────────────────────────
  // Settings dropdown (⛯) + debug HUD (📊), pinned to the top taskbar and
  // alive across every scene — so debug info (fps / draw calls) and the panel
  // tools are reachable on the login screen and any future scene, not just the
  // world. Log Out returns to the login scene.
  const settingsMenu = new SettingsMenu(topTaskbar, uiEditMode);
  settingsMenu.onLogOut = () => { void scenes.change(new LoginScene()); };
  // Clock-sync HUD source: the worker drains the wasm core's clock diagnostics
  // each pump and pushes them here; the panel reads `current()` for the live
  // values and ticks `sampleSyncHistory()` for the sparklines.
  const syncHistory = new SyncHistory();
  const debugPanel = new DebugPanel(topTaskbar, uiEditMode, syncHistory);
  ctx.debugPanel = debugPanel; // expose for the world scene's cursor coord readout
  // Map the wasm core's diagnostics into the panel's `SyncStats`, adding the
  // `Date.now()`-relative fields the core can't know (it only tracks its server
  // estimate). Pre-sync (`server_now` not yet meaningful) we park at `null` so
  // the panel shows "—" rather than a nonsensical epoch-sized offset.
  client.onClockStats((s: ClockStats) => {
    syncHistory.update(s.synced ? toSyncStats(s) : null);
  });
  // Per-reducer gateway-call tally → the debug panel's "calls" tab. The worker
  // drains it from the wasm bridge each pump; the panel rebuilds its table (and
  // skips the DOM work when closed).
  client.onCallStats((stats: CallStat[]) => debugPanel.setCallStats(stats));
  // Per-table subscription tally → the debug panel's "subs" tab.
  client.onSubStats((stats: SubStat[]) => debugPanel.setSubStats(stats));

  // Couple UI edit mode with the per-panel settings popup: entering edit mode
  // closes the Settings dropdown and opens the popup (bound to the last-focused
  // editable panel); closing the popup exits edit mode. Both directions are
  // idempotent-guarded (`setEnabled` no-ops on an unchanged flag), so the
  // round-trip can't loop. The popup is `editTarget: false`, so it never binds
  // to itself.
  uiEditMode.on((enabled) => {
    if (enabled) {
      settingsMenu.close();
      const target = DomPanel.lastFocusedEditTarget();
      if (target) settingsPopup.show(target);
    } else {
      settingsPopup.close();
    }
  });
  settingsPopup.onOpenChange((open) => {
    if (!open) uiEditMode.setEnabled(false);
  });

  // Drive the debug HUD every frame, scene-independent: frame-time → fps, GL
  // draw-call tally, atlas occupancy, and the live clock-sync snapshot the
  // worker pushes (`undefined` until the clock first syncs → the sync tab and
  // server-time rows stay at "—"). Ticking from the app ticker rather than a
  // scene's `update` keeps the HUD live in scenes that don't have a game loop
  // (e.g. login).
  app.ticker.add((ticker) => {
    debugPanel.setStats(
      ticker.deltaMS,
      drawCalls.readAndReset(),
      textures.stats(),
      syncHistory.current() ?? undefined,
    );
  });

  await scenes.change(new LoginScene());
}

/** Project the wasm core's `ClockStats` into the debug panel's `SyncStats`,
 *  filling the `Date.now()`-relative fields the core can't compute (it tracks
 *  only its own server estimate). `offset` is the gap between our server-time
 *  estimate and local wall-clock — the headline clock-skew read. The panel
 *  renames `clientDelay` → `clientLag`. Only called once `s.synced`. */
function toSyncStats(s: ClockStats): SyncStats {
  const dateNowMs = Date.now();
  return {
    serverNowMs: s.serverNowMs,
    dateNowMs,
    offsetMs: s.serverNowMs - dateNowMs,
    captures: s.captures,
    bestOffsetMs: s.bestOffsetMs,
    worstOffsetMs: s.worstOffsetMs,
    deltaMs: s.deltaMs,
    clientLagMs: s.clientDelayMs,
    rttMs: s.rttMs,
    bestRttMs: s.bestRttMs,
    rttSamples: s.rttSamples,
    runningDeltaMs: s.runningDeltaMs,
    runningDelayMs: s.runningDelayMs,
  };
}

/** Optimistic pre-login preview warm. Seeds the content runtime from the last
 *  session's cached corpus (IndexedDB) and kicks the LOW-lane preview prewarm, so
 *  a returning player's placeholders are ready (served from HTTP disk cache)
 *  before login. Best-effort — no cache, or any failure, falls back to the normal
 *  post-login prewarm in WorldRenderer. */
async function prewarmFromCache(lod: LodTextureManager): Promise<void> {
  try {
    const env = await lastEnv();
    if (!env) return;
    if (!(await initContentFromCache(env))) return;
    lod.setGateBase(httpBaseFor(env as Environment));
    lod.prewarmPreviews(sharedContent().previewStems());
    // Geometry is fetched lazily on-demand (see WorldRenderer.prewarmPreviews) —
    // prewarming every stem here would flood the gate/network and stall textures.
  } catch {
    /* best-effort warm — the normal cold path still runs at login */
  }
}

main().catch((e) => console.error("view: boot failed", e));
