/// <reference types="vite/client" />

/** Per-component build fingerprints baked in at build time (see vite.config.ts /
 * `bin/versions`). `null` if the snapshot was absent at build. */
declare const __BUILD_VERSIONS__: {
  build: number;
  generated: string;
  components: Record<string, { hash: string; seq: number }>;
} | null;
