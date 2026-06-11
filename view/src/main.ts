//! `view` entry point — boots the copied scene + panel infrastructure.
//!
//! This is the foundation of the pixijs client rebuild: a PIXI Application, the
//! SceneManager, and the two panel taskbars + UI edit mode that the panel
//! framework needs, wired into a minimal `GameContext`. Game subsystems
//! (data/cards/actions/world) are rebuilt on top from here.

import { Application } from "pixi.js";
import { loadFonts } from "./assets/fonts";
import { SceneManager } from "./scenes/SceneManager";
import { LoginScene } from "./scenes/login/LoginScene";
import { PanelTaskbar } from "./ui/dom/PanelTaskbar";
import { UiEditMode } from "./ui/dom/UiEditMode";
import { PanelSettingsPopup } from "./ui/dom/PanelSettingsPopup";
import { DomPanel } from "./ui/dom/DomPanel";
import { DrawCallCounter } from "./debug/DrawCallCounter";
import { SettingsMenu } from "./game/panels/titlebar/SettingsMenu";
import { DebugPanel } from "./game/panels/titlebar/DebugPanel";
import panelDefaults from "./content/panels/defaults.json";
import { WasmClient } from "./client/WasmClient";
import { gateUrlFor } from "./client/environments";
import { TextureManager } from "./assets/textures/TextureManager";
import { LodTextureManager } from "./assets/textures/LodTextureManager";
import { ObjectManager } from "./assets/ObjectManager";
import { smallestLodUrls } from "./assets/lodUrls";
import { DefinitionManager } from "./game/definitions/DefinitionManager";
import type { GameContext } from "./GameContext";


async function main(): Promise<void> {
  const app = new Application();
  await app.init({
    background: 0x101418,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  const host = document.getElementById("app");
  if (!host) throw new Error("#app element not found");
  host.appendChild(app.canvas);

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
  // The 64px prewarm floor (every aspect's smallest LOD) is kicked off now and
  // joined via `ctx.assetsReady` before a world scene builds against the white
  // fallback. Card-face baking (CardTextureManager) is deferred to the card port.
  const textures = new TextureManager(app.renderer);
  const lodTextures = new LodTextureManager(textures, app.renderer);
  const objects = new ObjectManager(lodTextures);
  const assetsReady = lodTextures.prewarm(smallestLodUrls());

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

  const ctx: GameContext = {
    app,
    scenes,
    client,
    textures,
    lodTextures,
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
  };
  scenes.setContext(ctx);

  // ── App-global title-bar tools ──────────────────────────────────────
  // Settings dropdown (⛯) + debug HUD (📊), pinned to the top taskbar and
  // alive across every scene — so debug info (fps / draw calls) and the panel
  // tools are reachable on the login screen and any future scene, not just the
  // world. Log Out returns to the login scene.
  const settingsMenu = new SettingsMenu(topTaskbar, uiEditMode);
  settingsMenu.onLogOut = () => { void scenes.change(new LoginScene()); };
  const debugPanel = new DebugPanel(topTaskbar, uiEditMode);

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
  // draw-call tally, atlas occupancy. (No sync-stats source is wired yet — the
  // clock lives in the worker — so the sync tab stays empty until a bridge
  // lands.) Ticking from the app ticker rather than a scene's `update` keeps
  // the HUD live in scenes that don't have a game loop (e.g. login).
  app.ticker.add((ticker) => {
    debugPanel.setStats(ticker.deltaMS, drawCalls.readAndReset(), textures.stats());
  });

  await scenes.change(new LoginScene());
}

main().catch((e) => console.error("view: boot failed", e));
