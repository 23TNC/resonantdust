# Task: generate new card definitions

Add one or more card definitions to the content crate. The user will
name the cards in their prompt; you decide the supporting JSON.

## Files touched

| File | Role |
| --- | --- |
| [content/cards/data/requisites/](../content/cards/data/requisites/) | Requisite (resource / equipment) defs. Pick the right `.json` for the card's kind (e.g. `resources.json` for materials, `equipment.json` for tools); create a new `.json` if no existing file fits. |
| [content/cards/data/tiles/](../content/cards/data/tiles/) | Tile defs (placed in the world). Use only when the card is a tile. |
| [content/cards/aspects.json](../content/cards/aspects.json) | Aspect catalog. **Read first** — every aspect referenced from a card must exist here. Add new aspects only when no existing one fits. |
| [content/locales/cards/en.json](../content/locales/cards/en.json) | Player-facing labels + descriptions. Every new card needs an entry under the matching category (`requisite`, `tile`, etc.) — without one, the card renders as its dev-side key. |
| `pixijs/public/textures/cards/requisites/128_requisite_pack/` | Sprite source. Confirm the `128_requisite_N` you reference actually exists; the file list rarely changes during a card-gen pass. |

## Card def shape

Look at [resources.json](../content/cards/data/requisites/resources.json) for
the live shape. Keys are short kebab-case identifiers. Required:
- `style`: `[ fill, fg, bg ]` color triple. Match the dominant aspect's
  color from `aspects.json` so the card reads as that material at a glance.
- `sprite`: basename of the PNG in `128_requisite_pack/` (without `.png`).
- `aspects` (optional): `{ "<aspectName>": <count>, … }`. Aspect names
  must already exist in `aspects.json`. Sub-aspects (e.g. `pine`,
  `berry`) satisfy their parent (`wood`, `food`) in recipe matching.

Compact / inline JSON per-leaf — single-line `"style": [...]` and
`"aspects": {...}`; only the top-level scaffolding stays expanded.

## Locale shape

```json
"<category>": {
  "<cardKey>": {
    "label": "Display Name",
    "description": { "simple": "One-sentence flavor / function." }
  }
}
```

`category` matches the top-level key in the card def file (`requisite`,
`tile`, etc.). `cardKey` matches the card def key exactly. The locale
checker calls missing entries "stubbed"; orphan entries (locale key with
no matching card) emit a warning too — fix both.

## Process

1. Re-read [aspects.json](../content/cards/aspects.json) — confirm the
   aspect(s) the card needs already exist. If one's missing, add it
   with `icon` (emoji), `color` (hex), `description`. Sub-aspects go
   inside their parent's object.
2. Pick the def file (or create one). Append the new entry.
3. Add the locale entry under the matching category in
   [en.json](../content/locales/cards/en.json).
4. Run `bin/content check` from repo root. Verify the `Cards:` line's
   `active` count went up by the number of cards you added, and the
   `Locales: cards:` line reports `0 stubbed`.
5. If any aspect was new, also confirm no `orphan` warnings on the
   aspect side (the locale check will surface them).

## Example: "food" requisite

```json
"food": {
  "style": [ "#CCAA22", "#ecd6aa", "#0b1426" ],
  "sprite": "128_requisite_3",
  "aspects": { "food": 1 }
}
```

Locale:

```json
"food": {
  "label": "Food",
  "description": { "simple": "Edible produce — sustenance for the journey." }
}
```

Style fill `#CCAA22` matches `food`'s aspect color from
`aspects.json`. Sprite `128_requisite_3` is one of the
auto-discovered files in the pack folder.

## Validation

```sh
bin/content check
```

Should exit clean with the new `Cards: N active` count and `0 stubbed`
locales. If it errors, the message points at the offending file/line.
