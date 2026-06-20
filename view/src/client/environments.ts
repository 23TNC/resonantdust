//! The gate environments the view can connect to. Each env dictates its own
//! endpoint — host + port + scheme — so the client can point at a LOCAL gate or a
//! REMOTE (lightsail) one from the same login screen:
//!  - dev / claude / test → local gates on the page's host, ports mirroring
//!    `bin/gate` (dev is the user's, claude the agent's, test the harness's).
//!  - alpha → the lightsail deployment at `gateway.resonantdust.com`.
//! The wasm client is pointed at the selected env's URL at login.

export type Environment = "dev" | "claude" | "test" | "alpha";

/** Selectable environments, in display order. The login `Server` select is built
 *  straight from this list, so adding one here surfaces it in the UI. */
export const ENVIRONMENTS: readonly Environment[] = ["dev", "claude", "test", "alpha"];

/** A gate endpoint. `host` omitted → the page's host (a local gate served from the
 *  same machine); set → a fixed remote host. `secure` picks `wss`/`https` vs
 *  `ws`/`http`. */
interface GateEndpoint {
  host?: string;
  port: number;
  secure: boolean;
}

/** Per-env endpoint. Local envs share the page host and differ only by port
 *  (mirrors `bin/gate`'s `GATE_PORT`); alpha is the lightsail host. */
const ENDPOINTS: Record<Environment, GateEndpoint> = {
  dev: { port: 8473, secure: false },
  claude: { port: 8474, secure: false },
  test: { port: 8475, secure: false },
  // Lightsail. The gate isn't fully up there yet, and it's plain HTTP like the
  // lightsail spacetime server (no TLS proxy today) — flip `secure` to true and
  // adjust `port` once a reverse proxy / final exposure lands.
  alpha: { host: "gateway.resonantdust.com", port: 8473, secure: false },
};

/** The host for `env`: its fixed remote host, or the page's host for a local gate. */
function hostFor(env: Environment): string {
  return ENDPOINTS[env].host ?? (location.hostname || "localhost");
}

/** The gateway WS endpoint for `env`. `host` defaults to the env's host (local =
 *  the page's host, alpha = lightsail); pass one to override. */
export function gateUrlFor(env: Environment, host = hostFor(env)): string {
  const { port, secure } = ENDPOINTS[env];
  return `${secure ? "wss" : "ws"}://${host}:${port}/ws`;
}

/** The gate's HTTP origin for `env` (`http(s)://host:port`) — for the `/content`
 *  fetch (DSL corpus). Same host/port as the WS, http(s) scheme. */
export function httpBaseFor(env: Environment, host = hostFor(env)): string {
  const { port, secure } = ENDPOINTS[env];
  return `${secure ? "https" : "http"}://${host}:${port}`;
}

/** The env the view is currently connected to (set at login). Surfaced in the
 *  debug HUD so it's always unambiguous which gate's data you're looking at —
 *  dev / claude / test / alpha. `null` until the first login. */
let _current: Environment | null = null;
const _listeners = new Set<(env: Environment | null) => void>();
export function setCurrentEnvironment(env: Environment): void {
  _current = env;
  for (const cb of _listeners) cb(env);
}
export function currentEnvironment(): Environment | null {
  return _current;
}

/** Subscribe to environment changes (login / server switch). Fires immediately
 *  with the current value so a freshly-mounted consumer (e.g. the env overlay)
 *  renders correctly before the first login. Returns an unsubscribe fn. */
export function onEnvironmentChange(cb: (env: Environment | null) => void): () => void {
  _listeners.add(cb);
  cb(_current);
  return () => _listeners.delete(cb);
}
