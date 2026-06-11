# content/

> **CURRENT DIRECTION (2026-06): game content is a stack-VM DSL.**
> The live, authored content now lives under [`data/`](data/) as `*.rd` programs
> — cards, recipes, aspects, functions, assets, manifests, biomes — specified in
> [`data/SYNTAX.txt`](data/SYNTAX.txt) (sigils + ops) and
> [`data/CONVENTIONS.txt`](data/CONVENTIONS.txt) (slot / aspect / chain model).
> It is interpreted by the **shared VM** in [`../shared/`](../shared/AGENTS.md) and
> **loaded at runtime** — changing content needs no recompile. Validate the whole
> corpus with `bin/shared corpus`.
>
> **Everything below this line documents the LEGACY system** — the JSON catalogs
> and the `resonantdust-content` crate (`include_str!`-embedded, with recipe
> logic mirrored in TypeScript). That path is being retired as the DSL/VM takes
> over. Read it to understand the old engine, but **author new content under
> `data/` against the DSL**, not under the JSON trees below.

---

Shared game content — JSON catalogs **and** the Rust crate (`resonantdust-content`)
that parses them, consumed by both the SpacetimeDB server (Rust) and the
pixijs client (TypeScript via wasm-pack). Anything that defines what cards
are, which recipes exist, what aspects/traits mean, or what starter packs a
player can pick lives here.

## Build pipeline

Two consumers, one source crate:

- **Server**: depends on `resonantdust-content` as a Cargo path-dep (see
  [`spacetime/server/spacetimedb/Cargo.toml`](../spacetime/server/spacetimedb/Cargo.toml)).
  [`spacetime/compose.yml`](../spacetime/compose.yml) bind-mounts
  `../content` (this directory) at `/workspace/server/spacetimedb/content`
  inside the build container so the path-dep resolves.
- **Client**: consumes the same crate built as a wasm bundle. `bin/content wasm`
  emits `content/pkg/*.{js,wasm,d.ts}` (the bundle name follows
  `Cargo.toml`'s `[lib].name`). The pixijs symlink at
  `pixijs/src/content` makes that package importable. The JS-facing API
  is gated behind the `js` cargo feature; the server build doesn't
  pull it in.

A change to any file here ships to both halves. They MUST agree on schema.

### Auto-discovery

JSON data files are picked up at compile time by [`build.rs`](build.rs)
— it recursively walks four trees and emits `(rel_path, contents)`
slices that the registries iterate:

| Tree | Generated slice (`crate::embedded_data::*`) |
| --- | --- |
| `cards/data/**/*.json` | `CARDS_FILES` |
| `recipes/data/**/*.json` | `RECIPES_FILES` |
| `starter_packs/data/**/*.json` | `STARTER_PACKS_FILES` |
| `blueprints/data/**/*.json` | `BLUEPRINTS_FILES` (soul-scope blueprint catalog) |
| `player_blueprints/data/**/*.json` | `PLAYER_BLUEPRINTS_FILES` (player-scope blueprint catalog — same entry shape, separate registry + id namespace so the two scopes can be enumerated independently) |
| `locales/**/*.json` | `LOCALES_FILES` |

**Adding, renaming, nesting, or removing a JSON file under any of those
trees needs no source edit.** Cargo notices via the build script's
`rerun-if-changed` hooks and the slice regenerates. The previous
hard-coded `CARDS_FILES` / `RECIPES_FILES` const tuples are gone.

The single-file catalogs (`cards/types.json`, `cards/aspects.json`,
`cards/traits.json`, `cards/flags.json`, `cards/id.json`,
`recipes/types.json`, `recipes/id.json`, `starter_packs/id.json`) are
still embedded directly via `include_str!` from inside the modules
that load them — they're not part of the auto-discovered slices.

Files in `cards/disciplines/`, `zones/`, and `bootstrap/` are **not**
auto-loaded by the content crate. `zones/biomes.json` and
`bootstrap/bootstrap.json` are read by the server module directly;
`cards/disciplines/` currently contains stale data in the pre-rewrite
format and is unreferenced — treat it as legacy until cleaned up.

## Layout

```
content/
  Cargo.toml       # resonantdust-content crate manifest
  build.rs         # auto-discovers cards/data, recipes/data,
                   #   starter_packs/data, locales
  compose.yml      # dockerized check/build/test/wasm services
  src/
    lib.rs               # module roots + embedded_data slices
    packed.rs            # bit-packing helpers (packed_definition,
                         #   packed_recipe, macro_zone, micro_zone, …)
                         #   incl. pack_nibbles/unpack_nibbles for the
                         #   PlayerProfile [count:u4|max:u4] bytes
    definition_core.rs   # card / aspect / trait registries
    recipe_core.rs       # recipe registry + stack-match scorer
    flags_core.rs        # cards/flags.json registry (single-bit
                         #   flags AND multi-bit fields)
    locales_core.rs      # locales/**/*.json registry, dotted-path
                         #   lookups with English fallback
    starter_pack_core.rs # starter-pack registry
    blueprint_core.rs    # blueprint registry — scoped via the
                         #   BlueprintScope enum (Soul, Player); one
                         #   OnceLock per scope, lookups take the
                         #   scope as an arg (`blueprint(scope, id)`,
                         #   `find_blueprint(scope, key)`,
                         #   `blueprints_all(scope)`)
    wasm_api.rs          # JS-facing wasm-bindgen exports
                         #   (cfg(feature = "js"))
  cards/
    types.json         # card_type registry, with per-type visibility
                       #   + shape (the legacy card_category dimension
                       #    has been retired — packed_definition is
                       #    now [card_type:u4 | def_id:u12])
    aspects.json       # aspect catalog (i32-valued)
    traits.json        # trait catalog (f32-valued)
    flags.json         # bit-position registry for cards.flags
                       #   (also actions / magnetic_actions sections,
                       #    historical — those tables no longer exist)
    id.json            # stable definition_id (generated)
    data/              # card definition tree, grouped by topic
      requisites/      # equipment.json, resources.json
      souls/           # human.json
      status/          # mental.json, stats.json
      tiles/           # forest.json, resources.json
    disciplines/       # LEGACY — old-format data, not auto-loaded
  recipes/
    types.json         # recipe_type / recipe_category registry
    id.json            # stable id per (type, category, key) (generated)
    data/              # recipe definition files (flat or nested)
  starter_packs/
    id.json            # stable id per (soul, pack_id) (generated)
    data/              # starter-pack definitions
  blueprints/
    id.json            # stable u16 id per soul-scope blueprint key
                       #   (generated)
    data/              # soul-scope blueprint definitions
  player_blueprints/
    id.json            # stable u16 id per player-scope blueprint key
                       #   (generated; separate namespace from soul)
    data/              # player-scope blueprint definitions
  locales/
    cards/<lang>.json     # display labels + descriptions per card
    recipes/<lang>.json   # display labels + success messages per recipe
  zones/
    biomes.json        # biome registry — read by server, not by
                       #   the content crate
  bootstrap/
    bootstrap.json     # dev-only seed data (currently just a card
                       #   key list) — read by server, not by the
                       #   content crate
  gen-ids.py           # stable-id generator for cards, recipes,
                       #   starter_packs
```

## Files

| File | Status | Purpose |
| --- | --- | --- |
| [`cards/types.json`](cards/types.json) | live | `card_type` id registry. Each type carries `id`, `visibility` (`"public"`/`"private"`), `shape` (`"rect"`/`"hex"`), and an explanatory `_comment`. The `id < 4` cutoff in `_rules.public_max_id` is enforced by SpacetimeDB subscription filters (`packed_definition < 0x4000` → public types only). Shape drives [`is_hex_type`] and the rect-vs-hex chain machinery on the server. (The `categories` block is tombstoned — `packed_definition` collapsed `[type:u4 | category:u4 | def_id:u8]` into `[type:u4 | def_id:u12]`.) |
| [`cards/aspects.json`](cards/aspects.json) | live | Aspect catalog — the tags placed on cards (`labor`, `combat`, `fleeting`, …) grouped by domain. Server assigns 1-indexed `AspectId`s in JSON insertion order across groups (id 0 reserved as `ASPECT_NONE`). Aspect values on a card are `i32`. |
| [`cards/traits.json`](cards/traits.json) | live | Trait catalog — same shape as aspects (top-level groups, `name: description` pairs) but for non-aggregating descriptive labels. Trait values on a card are `f32`. Today's traits: `tile.cost` (movement cost per terrain) and `soul.speed` (per-turn movement allowance). Read by `movement::tile_cost` on the server. |
| [`cards/flags.json`](cards/flags.json) | live | Bit-position registry for the `cards.flags` u32 column (also has `actions` / `magnetic_actions` sections retained as historical context — those tables were retired in the magnetic rewrite). Two entry shapes: `"bit": n` for single-bit flags, `"bits": [low, …, high]` for contiguous multi-bit fields (e.g. `progress_style` at bits 8..=10, `position_hold_count` at 17..=19). Append-only — removed flags leave `_reserved_<bit>` tombstones. The `magnetic` flag at bit 12 maps to `FLAG_LIFECYCLE_PENDING` on the server (JSON name kept for stable-id discipline pending lifecycle rewrite phase 6). Both the server and the recipe parser (for `{"flag": "..."}` predicates) read this file via [`flags_core`](src/flags_core.rs). |
| [`cards/id.json`](cards/id.json) | live, generated | Stable `definition_id` for every card, nested `{ <card_type>: { <category>: { <key>: <u8> } } }`. Assigned once and never reassigned. Generated by `gen-ids.py`. |
| [`cards/data/**/*.json`](cards/data/) | live | Card definitions. Auto-discovered. See [`cards/AGENTS.md`](cards/AGENTS.md). |
| [`cards/disciplines/`](cards/disciplines/) | legacy | Old pre-rewrite-format file (`[ { card_type, category, cards: { key: [name, style, aspects] } } ]`). **Not auto-loaded.** Delete or migrate before adding new cards under it. |
| [`recipes/types.json`](recipes/types.json) | live | `recipe_type` / `recipe_category` id registry, used by `pack_recipe`. Types: `stack`, `on_create`, `magnetic`. Categories: `up`, `down`, `self`. (Tombstoned: the `magnetic` category under `on_create` was retired by the magnetic rewrite.) The lifecycle rewrite (in progress) will fold `magnetic` recipes back into `stack`. `valid_for` lists which (type, category) pairs the loader recognises. |
| [`recipes/id.json`](recipes/id.json) | live, generated | Stable integer ID per recipe, nested `{ <type>: { <category>: { <key>: <int> } } }`. Scoped per (type, category) — each bucket counts from 1 independently. `Action.recipe` on the wire is `pack_recipe(type_id, category_id, recipe_id)`. Generated by `gen-ids.py`. |
| [`recipes/data/**/*.json`](recipes/data/) | live | Recipe definitions. Auto-discovered. See [`recipes/AGENTS.md`](recipes/AGENTS.md). |
| [`starter_packs/id.json`](starter_packs/id.json) | live, generated | Stable id per `(soul, pack_id)` pair, format `{ <soul>: { <pack_id>: <int> } }`. 1-indexed; `STARTER_PACK_NONE = 0`. Generated by `gen-ids.py`. |
| [`starter_packs/data/**/*.json`](starter_packs/data/) | live | Starter-pack definitions — bundles of cards spawned at character creation. Each entry maps `(soul, pack_id) → { card_key: count }`. Card keys resolve via [`find_packed_by_key`](src/definition_core.rs); soul keys are validated as known card keys at registry-build time. |
| [`blueprints/id.json`](blueprints/id.json) | live, generated | Stable u16 id per soul-scope blueprint key, `{ <key>: <int> }`. 1-indexed; `BLUEPRINT_NONE = 0`. Generated by `gen-ids.py`. |
| [`blueprints/data/**/*.json`](blueprints/data/) | live | Soul-scope blueprint definitions — each entry maps a blueprint key to the catalog card it draws as (`blueprint`) and the card it builds (`card`). Discovered bit lives on `SoulPrivate.blueprints_0`; placement cap derived from the soul def's `aspects.builder` value. Resolved through the `BlueprintScope::Soul` arm of [`blueprint_core`](src/blueprint_core.rs). |
| [`player_blueprints/id.json`](player_blueprints/id.json) | live, generated | Stable u16 id per player-scope blueprint key. Same shape as `blueprints/id.json`, separate namespace — soul-scope id 1 and player-scope id 1 are unrelated. Generated by `gen-ids.py`. |
| [`player_blueprints/data/**/*.json`](player_blueprints/data/) | live | Player-scope blueprint definitions — same entry shape as soul-scope, but discovery bit lives on `PlayerProfile.blueprints_0` and cap comes from `PlayerProfile.blueprint_info.max`. Spawned cards carry `card_type = player_blueprint (3)` and `FLAG_OWNED_BY_PLAYER`. Resolved through the `BlueprintScope::Player` arm of [`blueprint_core`](src/blueprint_core.rs). |
| [`locales/cards/<lang>.json`](locales/cards/) | live | Display labels + descriptions for cards, keyed by `<card_type>.<category>.<key>` matching `cards/id.json`'s nesting. Each leaf object has a required `label` and optional `description.simple` / `description.detailed`. English (`en`) is the fallback language. |
| [`locales/recipes/<lang>.json`](locales/recipes/) | live | Same shape, keyed by `<recipe_type>.<category>.<key>`. Leaves carry `label` plus optional `success.simple` (the event-log line on successful completion). |
| [`zones/biomes.json`](zones/biomes.json) | live | Biome registry for procedural map generation. Each biome has a center in climate space (`temperature`, `humidity` ∈ `[0, 1]`) and a weighted tile distribution (keys resolved through `cards/id.json` under `tile/default/<key>`). The map generator samples a climate vector per cell, weights biomes by inverse-square distance from the cell's climate point, blends their tile distributions, and weighted-picks a `definition_id`. **Read by the server, not by the content crate.** Biomes are category-agnostic — the zone's category byte selects the visual variant. |
| [`bootstrap/bootstrap.json`](bootstrap/bootstrap.json) | live, stub | Seed data loaded by the dev-only `bootstrap` reducer in [`spacetime/server/spacetimedb/src/debug.rs`](../spacetime/server/spacetimedb/src/debug.rs). Currently a stub — only a top-level `card: [<key>, …]` array remains; each entry resolves through `cards/id.json` and lands in the first player's inventory. The prior `player` / `zones` sections were removed. |
| [`gen-ids.py`](gen-ids.py) | tooling | Generates `cards/id.json`, `recipes/id.json`, `starter_packs/id.json`, `blueprints/id.json`, `player_blueprints/id.json`, and `textures/id.json` by recursively walking the corresponding `data/` trees. The two blueprint passes share a helper (`_gen_blueprint_scope_ids`) so soul-scope and player-scope catalogs allocate ids in the same shape — independent namespaces, both 1-indexed. Default mode reassigns IDs every run; `--skip-known` preserves existing ids and appends only new entries (the append-only, tombstone-removed-entries discipline you want once wire-format ids matter). Run before `bin/content build` whenever you add or remove cards / recipes / packs / blueprints — the registries refuse to load entries missing from these files. |

## `bin/content` — the build wrapper

[`bin/content`](../bin/content) is the canonical entry point for building
this crate. It runs `gen-ids.py` first, then dispatches to a dockerized
service from [`compose.yml`](compose.yml):

| Command | Action |
| --- | --- |
| `bin/content check` | `cargo check --all-targets` |
| `bin/content build` | `cargo build --release` |
| `bin/content test`  | `cargo test` |
| `bin/content wasm`  | builds the wasm bundle and runs `wasm-bindgen` into `content/pkg/` |
| `bin/content config`| prints the resolved compose-file / gen-ids paths |

Override paths with `CONTENT_COMPOSE` / `CONTENT_GEN_IDS` env vars if
you need to point the wrapper at a different checkout.

The Docker container uses the `clockworklabs/spacetime:latest` image,
so the toolchain matches what the SpacetimeDB module is built against.
The host `cargo` is not invoked.

## Conventions across all files

- **Valid JSON, no comments.** JSON-with-comments is not valid JSON. Use
  `_comment` keys (or `_rules`, `_notes`, etc.) for inline documentation
  — every loader skips any key beginning with `_`.
- **Type and category names are singular** (`"discipline"`, not
  `"disciplines"`). The keys at the top of `cards/data/*.json` /
  `recipes/data/*.json` MUST match the names in `cards/types.json`
  / `recipes/types.json` exactly (case-sensitive). Unknown
  `(type, category)` pairs are **silently skipped** at registry
  build — content files can outpace the Rust enum and a typo won't
  break the build, but it also won't decode at runtime. Sanity-check
  by grepping `cards/id.json` after running `gen-ids.py`.
- **Reserved keys**: anything beginning with `_` is parser-skipped.
  `_reserved_*` slots in `cards/types.json` / `recipes/types.json` /
  `cards/flags.json` reserve numeric ids for future entries or
  tombstone removed ones; they don't register as real entries and
  type/category/key names like `"_reserved_1"` will never resolve.
- **1-based external ids, 0 reserved as sentinel.** `AspectId`,
  `TraitId`, `definition_id`, `StarterPackId`, and the recipe id field
  inside `pack_recipe` are all 1-indexed; 0 in any of those contexts
  means "no entry".
- **Adding cards / recipes / starter packs / blueprints requires running `gen-ids.py`.**
  The registries reject entries that aren't in `cards/id.json` /
  `recipes/id.json` / `starter_packs/id.json` / `blueprints/id.json` /
  `player_blueprints/id.json` with a clear "run gen-ids.py" error
  message. `bin/content check` runs it automatically before checking
  — running it directly is only needed if you want to inspect the
  resulting id assignments without compiling.
- **Reserved card keys.** Card keys cannot be `"any"` (recipe-side
  wildcard sentinel) and cannot start with `@` (recipe-side card-type
  prefix). The current data trips neither.

## Display labels and the locale lookup chain

Display labels are **not** stored in card or recipe JSON. They live in
`locales/<domain>/<lang>.json` and are resolved at runtime via
[`locales_core`](src/locales_core.rs):

```rust
locales_core::label("cards", lang, "requisite.default.log")  // → Some("Log")
locales_core::label("recipes", lang, "stack.up.cut_tree")    // → Some("cut tree")
locales_core::variant("cards", lang, path, "description.simple")
locales_core::variant("recipes", lang, path, "success.simple")
```

The lookup applies a two-step fallback:

1. `(domain, lang, path)` → return on hit.
2. `(domain, "en", path)` → return on hit.
3. Miss → `None`. Callers should fall back to the bare key (the
   `CardDefinition.key` / recipe id) as the dev-side display.

The wasm API exposes `cardLabel(packed, lang)` for the client; under the
hood it builds the path via [`card_locale_path`](src/definition_core.rs)
and dispatches to `locales_core::label`. JS-side callers reading recipe
labels build the recipe path themselves (`<type>.<category>.<key>`) and
call into the locale registry directly.

Strict-in-CI is the recipe author's job: `bin/content check` is the
place to fail on missing entries, not the lookup hot path.

## Failure modes

- **Server / client (Rust)**: every registry uses
  `OnceLock<Result<Registry, String>>`. A malformed file fails the
  build once; every subsequent lookup returns the cached error rather
  than re-running the build. The module doesn't crash, but
  recipes/cards/packs just won't resolve — check the server logs /
  first-call error message.
- **Client (wasm)**: errors are surfaced as thrown JS strings from
  `wasm_api.rs` exports; missing rows become `null` / `undefined` so
  the caller can fall back gracefully.
- **Cross-side schema drift**: the crate is the canonical source, so
  there's no manual schema syncing — but recipe priority evaluation
  runs on both sides (server is authoritative, client is a
  pre-filter), and changes to entity grammar or weight constants
  must land in both `entity_specificity` (in `recipe_core.rs`) and
  the client's TypeScript mirror in lockstep. See
  [`recipes/AGENTS.md`](recipes/AGENTS.md) ("Priority").

## Where parsing lives

- [`src/definition_core.rs`](src/definition_core.rs) — `build_aspects`,
  `build_traits`, `build_cards`, `parse_card`. Exposes
  `decode_definition`, `find_packed_by_key`, `find_packed`,
  `is_hex_type`, `card_locale_path`, `card_type_ids`, and the
  `ASPECT_NONE` / `TRAIT_NONE` sentinels.
- [`src/recipe_core.rs`](src/recipe_core.rs) — `build_recipes`,
  `parse_recipe`, `parse_entity`, `parse_duration`,
  `match_stack_recipe` / `match_stack_recipe_detail`,
  `has_predicates_feasible`, `entity_specificity`. Pulls
  `card_type_ids` from `definition_core` and flag bits from
  `flags_core`.
- [`src/flags_core.rs`](src/flags_core.rs) — single-bit (`card_flag_bit`)
  and multi-bit (`card_flag_field` → `FlagField { shift, width }`)
  lookups.
- [`src/locales_core.rs`](src/locales_core.rs) — `label`, `variant`,
  `entry`, `languages`.
- [`src/starter_pack_core.rs`](src/starter_pack_core.rs) — `starter_pack`,
  `find_starter_pack`, `starter_packs_for_soul`.
- [`src/packed.rs`](src/packed.rs) — every wire-format pack/unpack
  helper (definition, recipe, zone_definition, macro_zone, micro_zone
  in both legacy and stack layouts, tile rows).
- Client wrapper: [`pixijs/src/game/definitions/DefinitionManager.ts`](../pixijs/src/game/definitions/DefinitionManager.ts)
  is the TypeScript facade over the wasm exports.
