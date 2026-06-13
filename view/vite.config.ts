import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Build fingerprints (bin/versions output at repo root). Injected as a compile-
// time constant so the bundle carries the source-closure hashes it was built
// against; the debug panel's Versions tab compares these to the gate's live
// /versions to flag a stale client/gate/shard. Best-effort — a missing snapshot
// (fresh checkout before first `bin/versions`) degrades to nulls, never a build
// break.
let buildVersions: unknown = null;
try {
  const p = fileURLToPath(new URL("../versions.json", import.meta.url));
  buildVersions = JSON.parse(readFileSync(p, "utf8"));
} catch {
  buildVersions = null;
}

export default defineConfig({
  define: {
    __BUILD_VERSIONS__: JSON.stringify(buildVersions),
  },
  server: {
    port: 5173,
    allowedHosts: [
      'resonantdust.com',
      'www.resonantdust.com',
      '.resonantdust.com',     // allows all subdomains (recommended)
      'localhost',
      '127.0.0.1'
    ],
  },
  build: {
    sourcemap: false,
  },
  optimizeDeps: {
    esbuildOptions: {
      sourcemap: false,
    },
  },

});