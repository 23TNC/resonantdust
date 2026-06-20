//! Always-on environment badge, pinned top-left. The view can connect to any of
//! several gates (dev / claude / test / alpha), and acting on the wrong one is an
//! easy, costly mistake — so this surfaces the *currently-connected* env at all
//! times, color-coded (alpha = red to flag the remote/shared box). It reads the
//! single source of truth in `environments.ts` and re-renders on every login /
//! server switch via `onEnvironmentChange`. Pure DOM, mounted once at boot.

import { onEnvironmentChange, type Environment } from "../client/environments";

/** Per-env accent. alpha (remote lightsail, shared) is red so it can't be
 *  mistaken for a throwaway local gate; locals are cool/calm colours. */
const ENV_COLOR: Record<Environment, string> = {
  dev: "#3fb950", // green — the user's local gate
  claude: "#a371f7", // purple — the agent's local gate
  test: "#d29922", // amber — the harness gate
  alpha: "#f85149", // red — REMOTE lightsail, shared/persistent
};

/** Mount the env badge into `document.body`. Idempotent-ish: call once at boot. */
export function mountEnvOverlay(): void {
  const el = document.createElement("div");
  el.id = "env-overlay";
  Object.assign(el.style, {
    position: "fixed",
    top: "4px",
    left: "4px",
    zIndex: "2147483647", // above every panel/popup
    padding: "2px 7px",
    font: "600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
    letterSpacing: "0.08em",
    borderRadius: "4px",
    color: "#fff",
    background: "#6e7681",
    border: "1px solid rgba(255,255,255,0.25)",
    pointerEvents: "none", // never intercept clicks
    userSelect: "none",
    textTransform: "uppercase",
    opacity: "0.85",
  } satisfies Partial<CSSStyleDeclaration>);

  onEnvironmentChange(env => {
    if (env) {
      el.textContent = env;
      el.style.background = ENV_COLOR[env];
    } else {
      el.textContent = "— no env (pre-login)";
      el.style.background = "#6e7681";
    }
  });

  document.body.appendChild(el);
}
