//! The app-wide context handed to scenes and panels. In the `view` rebuild this
//! starts as the UI-framework surface only (the scene/panel infrastructure
//! copied across first); game-manager fields (cards/actions/zones/data/…) are
//! added back as each subsystem is rebuilt on top.

import type { Application } from "pixi.js";
import type { SceneManager } from "./scenes/SceneManager";
import type { PanelManager } from "./ui/panels/PanelManager";
import type { PanelTaskbar } from "./ui/dom/PanelTaskbar";
import type { UiEditMode } from "./ui/dom/UiEditMode";
import type { WasmClient } from "./client/WasmClient";
import type { TextureManager } from "./assets/textures/TextureManager";
import type { LodTextureManager } from "./assets/textures/LodTextureManager";
import type { ObjectManager } from "./assets/ObjectManager";
import type { DrawCallCounter } from "./debug/DrawCallCounter";
import type { DefinitionManager } from "./game/definitions/DefinitionManager";
import type { LayoutManager } from "./game/layout/LayoutManager";
import type { InputManager } from "./game/input/InputManager";

export interface GameContext {
  readonly app: Application;
  readonly scenes: SceneManager;

  /** Bridge to the Rust `client` core (gate connection + login + world state),
   *  compiled to wasm. The view never talks to a gateway directly. */
  readonly client: WasmClient;

  /** RenderTexture cache + atlas bookkeeping. */
  readonly textures: TextureManager;
  /** LOD-aware lazy loader / picker + per-URL atlas cache (the LOD atlas system). */
  readonly lodTextures: LodTextureManager;
  /** World-object sprite/texture resolver over the LOD atlas. */
  readonly objects: ObjectManager;
  /** Resolves once the 64px LOD prewarm floor is loaded. */
  readonly assetsReady: Promise<void>;

  /** The bottom (primary) panel taskbar. */
  readonly taskbar: PanelTaskbar;
  /** The top taskbar (title-bar tools). */
  readonly topTaskbar: PanelTaskbar;
  /** UI layout-edit toggle (drag/resize panels). */
  readonly uiEditMode: UiEditMode;

  /** Per-frame GL draw-call counter (patched at boot); read by the debug panel. */
  readonly drawCalls: DrawCallCounter;

  /** Open-panel registry — set once the active scene installs it. */
  panels: PanelManager | null;

  /** Packed-definition decoder + render metadata (stub until content loads). */
  readonly definitions: DefinitionManager;
  /** Zone→surface resolver used by card layout; null until a world scene installs it. */
  layout: LayoutManager | null;
  /** DOM→semantic input adapter (pointer/key events + hit-testing); null until a
   *  world scene installs it (the login screen uses DOM forms, not this). */
  input: InputManager | null;
}
