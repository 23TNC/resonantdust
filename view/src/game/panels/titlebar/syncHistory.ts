//! Bounded sparkline history for the debug HUD's "sync" tab.
//!
//! The wasm core pushes a fresh clock-diagnostics snapshot every pump (~20Hz);
//! `update` stashes the latest. `DebugPanel` ticks `sampleSyncHistory` on a fixed
//! frame cadence (independent of whether the panel is open), and we append the
//! current value of every tracked series to a bounded ring — so the sparklines
//! carry a continuous trail reflecting activity from before the panel opened.
//! `NaN` is a pen-up (no data / not synced yet), which the panel's draw routines
//! treat as a gap rather than a zero.

import type { SyncStats, SyncHistorySource } from "./DebugPanel";

/** Bounded sample window. At the panel's ~2Hz sample cadence this spans a couple
 *  of minutes of trail — long enough to see a jitter spike decay. */
const WINDOW = 240;

/** Every series the panel reads via `getHistory`. Each maps to one scalar of the
 *  latest `SyncStats` (see `scalar`). */
const SERIES = [
  "clientDelayMs",
  "runningDelayMs",
  "runningDeltaMs",
  "deltaMs",
  "offsetMs",
  "bestOffsetMs",
  "worstOffsetMs",
  // Per-tick count of captures that landed since the previous sample — drives the
  // "Captures" arrival-dots graph. Derived from `rttSamples` (one round-trip =
  // one clock capture), not projected from a snapshot scalar; see `sampleSyncHistory`.
  "captureArrivals",
  "rttMs",
  "bestRttMs",
  "captureOffsetMs",
] as const;
type SeriesName = (typeof SERIES)[number];

export class SyncHistory implements SyncHistorySource {
  /** The most recent snapshot, or `null` before the clock has synced (the panel
   *  then renders "—" and the sparklines stay empty). */
  private latest: SyncStats | null = null;
  private readonly buffers = new Map<SeriesName, number[]>();
  /** Total round-trips (≈ total captures) seen at the previous sample tick, so
   *  we can record the per-tick arrival count. `null` until the first sample. */
  private prevRttSamples: number | null = null;

  constructor() {
    for (const s of SERIES) this.buffers.set(s, []);
  }

  /** Replace the current snapshot (called when the worker pushes a new one).
   *  `null` parks the trail at a pen-up until the clock re-syncs. */
  update(stats: SyncStats | null): void {
    this.latest = stats;
  }

  /** The latest snapshot to hand straight to `DebugPanel.setStats`. */
  current(): SyncStats | null {
    return this.latest;
  }

  sampleSyncHistory(): void {
    const s = this.latest;
    // Captures since the last tick: the monotonic round-trip count's delta. A
    // pen-up (NaN) while unsynced; resets the baseline so a re-sync doesn't read
    // its whole backlog as one giant arrival spike.
    let arrivals: number;
    if (!s) {
      arrivals = NaN;
      this.prevRttSamples = null;
    } else {
      arrivals = this.prevRttSamples === null ? 0 : Math.max(0, s.rttSamples - this.prevRttSamples);
      this.prevRttSamples = s.rttSamples;
    }
    for (const name of SERIES) {
      const buf = this.buffers.get(name)!;
      buf.push(name === "captureArrivals" ? arrivals : s ? this.scalar(s, name) : NaN);
      if (buf.length > WINDOW) buf.shift();
    }
  }

  getHistory(name: string): readonly number[] {
    return this.buffers.get(name as SeriesName) ?? [];
  }

  /** Project one series' scalar out of a snapshot. `null` optional fields (no
   *  data yet) become `NaN` pen-ups. */
  private scalar(s: SyncStats, name: SeriesName): number {
    switch (name) {
      case "clientDelayMs":  return s.clientLagMs;
      case "runningDelayMs": return s.runningDelayMs;
      case "runningDeltaMs": return s.runningDeltaMs;
      case "deltaMs":        return s.deltaMs ?? NaN;
      case "offsetMs":       return s.offsetMs;
      case "bestOffsetMs":   return s.bestOffsetMs ?? NaN;
      case "worstOffsetMs":  return s.worstOffsetMs ?? NaN;
      // Derived in `sampleSyncHistory` from the round-trip delta, not from a
      // snapshot scalar — this branch is never hit, but keeps the switch total.
      case "captureArrivals": return NaN;
      case "rttMs":          return s.rttMs ?? NaN;
      case "bestRttMs":      return s.bestRttMs ?? NaN;
      // "Capture spread": the per-tick gap between the freshest and most-queued
      // sample offsets — a read on sampling jitter. Pen-up until synced.
      case "captureOffsetMs":
        return s.bestOffsetMs !== null && s.worstOffsetMs !== null
          ? s.bestOffsetMs - s.worstOffsetMs
          : NaN;
    }
  }
}
