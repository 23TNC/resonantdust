//! G4 renderer feature flag. Toggle in dev by adding `?g4` to the URL — lets us A/B
//! the G4 path against the live deferred pipeline without a rebuild while G4 is built
//! out (docs/g4_renderer.md). Defaults off; becomes the default at the Phase-3 cutover.

export const G4: boolean =
  typeof location !== "undefined" && new URLSearchParams(location.search).has("g4");

/** Dev override for the ambient floor: `?g4amb=0.9` cranks it up to inspect the bake
 *  (0.12 is nearly black). Returns -1 when unset → caller uses its own default. */
export const G4_AMBIENT: number = (() => {
  if (typeof location === "undefined") return -1;
  const p = new URLSearchParams(location.search).get("g4amb");
  const v = p === null ? NaN : parseFloat(p);
  return Number.isFinite(v) ? v : -1;
})();
