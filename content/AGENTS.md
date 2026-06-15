# content/

Game content as a **stack-VM DSL**. The authored content is `*.rd` programs —
cards, recipes, aspects, biomes, plus their visuals — interpreted by
the **shared VM** in [`../shared/`](../shared/AGENTS.md) and **loaded at runtime**
(changing content needs no recompile). The old JSON catalogs, the
`resonantdust-content` crate, and `gen-ids.py` / `id.json` are **gone** — this is
DSL-only.

The language is specified in [`data/SYNTAX.txt`](data/SYNTAX.txt) (sigils + ops)
and [`data/CONVENTIONS.txt`](data/CONVENTIONS.txt) (the slot / aspect / chain
model). Validate the whole corpus with `bin/shared corpus`.

## Layout

| Path | What |
| --- | --- |
| `data/` | The `:data` facets — server-authoritative definitions. `cards/` (souls, tiles, faculties, requisites, status…), `recipes/`, `aspect/`, `biomes/`. |
| `visuals/` | The `:visuals` facets — client-only rendering. `cards/` (per-card primitives / lights / portraits), `manifest/` (per-asset texture manifests), `asset/`, `functions/`. |
| `locales/` | Locale strings, by domain: `cards/`, `aspects/`, `recipes/`, `panels/`. **Embedded into the content wasm** at build (`bin/content wasm`) — the client reads strings via wasm exports, not these JSON at runtime. |
| `manifest.json` | Top-level asset manifest. |
| `data/SYNTAX.txt`, `data/CONVENTIONS.txt` | The DSL spec. |

## The `:data` / `:visuals` split

A card definition is split across two trees by facet: server-authoritative data
in `data/`, client-only rendering in `visuals/`. The loader's `index_defs` merges
the two by `::name` (**data first**, visuals extend the render side); the gate
loads **data-then-visuals**. One grammar, one VM — the split is purely which files
a facet lives in. Aspect *visibility* is visuals-driven (a card's `:visuals` can
override the registry default).

## def ids

There is **no `id.json` and no `gen-ids.py`.** The loader derives each def's
`def_id` from the **sorted content names** (deterministic, content-addressed) —
add or rename a def and ids re-derive. Wire-format stability matters once content
is versioned in R2; the authority gate mints a new lineage id per
`modify_content` (see the def-id GC item in [../docs/ROADMAP.md](../docs/ROADMAP.md)).

## Build & serve

- `bin/shared corpus` — load + validate + resolve every `.rd` (the load-bearing
  cross-file lint). Run after any content edit.
- `bin/content check | build | test` — the `content/` Rust crate (catalog +
  shared helpers); `bin/content wasm` re-embeds `locales/**` into the content
  wasm.
- **Runtime:** the gate reads the corpus from **R2** (`CONTENT_BASE_URL` or the
  `R2_*` S3 creds + `manifest.json`), polls for changes, hot-reloads, and
  broadcasts `content_changed` to clients. The authority gate also authors back
  to R2.

## Authoring

New cards / recipes / aspects are authored as `.rd` against the DSL and loaded at
runtime — they don't touch Rust. Extending the *language* (a new op / sigil) does
(rebuild the `dsl` crate). Keep `:data` and `:visuals` for the same card in their
respective trees under the same `::name`.
