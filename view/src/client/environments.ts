//! The gate environments the view can connect to. Each maps to a gate WS port
//! (the same ports `bin/gate` serves): dev is the user's gate, claude the
//! isolated agent gate, test the harness gate. The host is shared (the gate runs
//! on the same machine the view is served from) — only the port differs. The
//! wasm client is pointed at the selected env's URL at login.

export type Environment = "dev" | "claude" | "test";

/** Selectable environments, in display order. */
export const ENVIRONMENTS: readonly Environment[] = ["dev", "claude", "test"];

/** Gate WS port per environment — mirrors `bin/gate` (`GATE_PORT`). */
const GATE_PORT: Record<Environment, number> = {
  dev: 8473,
  claude: 8474,
  test: 8475,
};

/** The gateway WS endpoint for `env`. `host` defaults to wherever the view is
 *  served from (the gate runs alongside it). */
export function gateUrlFor(env: Environment, host = location.hostname || "localhost"): string {
  return `ws://${host}:${GATE_PORT[env]}/ws`;
}

/** The gate's HTTP origin for `env` (`http://host:port`) — for the `/content`
 *  fetch (DSL corpus). Same host/port as the WS, http scheme. */
export function httpBaseFor(env: Environment, host = location.hostname || "localhost"): string {
  return `http://${host}:${GATE_PORT[env]}`;
}

/** The env the view is currently connected to (set at login). Surfaced in the
 *  debug HUD so it's always unambiguous which gate's data you're looking at —
 *  dev vs claude vs test. `null` until the first login. */
let _current: Environment | null = null;
export function setCurrentEnvironment(env: Environment): void {
  _current = env;
}
export function currentEnvironment(): Environment | null {
  return _current;
}
