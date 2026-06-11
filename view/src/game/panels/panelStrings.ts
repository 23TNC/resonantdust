/** Panel UI string lookups. Resolves panel chrome strings — titles,
 *  buttons, row labels, placeholders — scoped to the `panels` locale
 *  domain (`content/locales/panels/<lang>.json`).
 *
 *  Schema: each panel is one locale entry keyed by its
 *  `content/panels/defaults.json` panel key. Its `label` is the
 *  title-bar text; every other string is a flat variant. So
 *  `panelTitle("settingsMenu")` → "Settings" and
 *  `panelText("settingsMenu", "logOut")` → "Log Out".
 *
 *  **Two sources, in order:** the gate-served `sharedLocales()` catalog
 *  first (so a live language switch / content reload wins), then a
 *  build-time **bundled** English copy of the panels domain. The bundle
 *  matters because panels are app-global chrome built at boot — settings,
 *  debug HUD, the per-panel settings popup all exist on the login screen,
 *  *before* any gate content has loaded. Without the bundle their labels
 *  would freeze at the raw key fallback. The bare key is the final
 *  fallback so a missing translation renders the dev-side key rather than
 *  throwing. */

import { sharedLocales } from "../definitions/contentBoot";
import panelsEn from "../../content/locales/panels/en.json";

const DOMAIN = "panels";

/** Bundled English panels domain — the boot-time fallback. `_`-prefixed
 *  top-level keys (file comments) are ignored by the per-panel lookups. */
type PanelEntry = Record<string, unknown>;
const BUNDLE = panelsEn as unknown as Record<string, PanelEntry>;

/** Read a string field off a bundled panel entry, or `undefined`. */
function bundled(panelKey: string, field: string): string | undefined {
  const entry = BUNDLE[panelKey];
  const v = entry?.[field];
  return typeof v === "string" ? v : undefined;
}

/** Try the gate-served catalog; `undefined` if content isn't loaded yet
 *  (the lookup throws) or the key is missing. */
function fromGate(key: string): string | undefined {
  try {
    return sharedLocales().string(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Title-bar text for `panelKey` (its `defaults.json` key). Gate catalog →
 *  bundled English → the bare key. Key: `panels.<panelKey>.label`. */
export function panelTitle(panelKey: string): string {
  return (
    fromGate(`${DOMAIN}.${panelKey}.label`) ??
    bundled(panelKey, "label") ??
    panelKey
  );
}

/** A non-title string (`key`) declared on `panelKey`'s entry — button
 *  captions, row labels, placeholders. Gate catalog → bundled English →
 *  the bare key. Key: `panels.<panelKey>.<key>`. */
export function panelText(panelKey: string, key: string): string {
  return (
    fromGate(`${DOMAIN}.${panelKey}.${key}`) ??
    bundled(panelKey, key) ??
    key
  );
}
