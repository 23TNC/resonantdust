# Stacking refactor B — slot nomenclature (`root → slot.0.0`)

**Status:** DONE + live-verified (`HARNESS PASS (combined, 2 clients)` on
`RD_ENV=test bin/client run`, 2026-06-08). Stage A (the functional
generalization — canonical `codec::stacking` resolver, `hosts & joins` +
leaf-append, shifted default bit-fields) was DONE before. Stage B was a pure
**naming alignment**: recipe slot numbers now equal the `stack_id` they address
(`slot.0.0` = root, `slot.1` = hex/tile, `slot.2` = top, `slot.3` = bottom). No
behaviour change. All `bin/client test` + `bin/shared test` + `bin/shared
corpus` green.

Note discovered during B: `client.rs::recipe_references_root` keyed on the old
`root` token; it now detects a path that *starts with* `slot.0.<offset>` (else
every root-only recipe — prime/corpus_dim/fleeting/despair_*/strike_* — would be
dropped). `defs.rs`'s parallel root-detection + `branch_counts[3]` were left
as-is: they feed only the stale wasm/TS `recipeMatcher` path (scoped out), and
their self-contained unit tests still use `root` tokens.

See memory `project_stack_canonical_resolver` for the Stage A end state.

## The goal

Align recipe slot numbers with `stack_id` (the `stack_state` nibble; 0 = loose):

| meaning | stack_id | now (pre-B) | after B |
|---|---|---|---|
| root card (chain root, loose) | 0 | `root` (special path) | `slot.0.0` |
| hex / under-root — where the **tile** mounts | 1 | `slot.0.X` | `slot.1.X` |
| top | 2 | `slot.1.X` | `slot.2.X` |
| bottom | 3 | `slot.2.X` | `slot.3.X` |

The elegant part: the root card is `slot.0.0`, and a tile under it is its
**hex-stack member at `slot.1.0`** — exactly why tiles join stack 1 (`0b0010`).

## Files + changes

### 1. Recipes — `content/data/recipes/*.rd` (01.rd ~63 refs, 02.rd ~28, 03_chorus_story.rd ~5)

Renumber every slot reference. **Order matters** — rename high→low so a renamed
slot isn't renamed again:

1. `slot.2` → `slot.3`   (bottom)
2. `slot.1` → `slot.2`   (top)
3. `slot.0` → `slot.1`   (hex/tile)
4. `root`  → `slot.0.0`  (word-boundary: `\broot\b`, catches `&root`, `*root`, `*root.aspect.x`, `&root use`)

Nested paths shift BOTH refs automatically, e.g. cut_tree's
`slot.1.0.owner.slot.1.0` (axe on soul's top stack) → `slot.2.0.owner.slot.2.0`.
A per-file `sed` in the 4-step order above is safe (step 1 consumes original
`slot.2`s before step 2 creates new ones). Verify each file by eye after — the
recipe DSL has no other `slot`/`root` tokens.

Spot-checks after renumber:
- `corpus_b_top`: `slot.1.0`/`slot.1.1` → `slot.2.0`/`slot.2.1` (two corpus in the top stack).
- `cut_tree`: tile `slot.0.0`→`slot.1.0`; actor `slot.1.0`→`slot.2.0`; axe `slot.1.0.owner.slot.1.0`→`slot.2.0.owner.slot.2.0`.
- root-only `prime`/`corpus_dim`: `*root.…`/`&root …` → `*slot.0.0.…`/`&slot.0.0 …`.

### 2. `pixijs/src/shared/dsl/src/recipe.rs`

- **`iterators()` / `resolve_path`**: SKIP creating an iterator for branch 0.
  `slot.0.X` is always the single root (a card, not a sliding window) and is
  filled by the `root` param — not a binding. Without this, root-only recipes
  (which now reference `slot.0.0`) would spuriously gain a branch-0 iterator.
  (The `root_only_recipe_has_no_iterators` test must keep passing — keep root as
  the param, just skip branch 0 in enumeration.)
- **`build_frame`**:
  - Synthetic-tile sentinel moves branch `0 → 1` (the tile is the hex member at
    `slot.1.0`): `iter.parent.is_empty() && iter.branch == 1 && offset == 0`.
  - Place the `root` param at `"slot.0.0"` instead of `"root"` (both the
    `store.write` and the `paths.push`).
- **Tests in this file** use `root` and `slot.0.0`(tile) in their recipe strings
  + assert `frame.card_at("slot.1.0")` etc. — renumber them to match (e.g. the
  `cut_tree_nested_equipment_iterator` test's expected iterators become
  `it("",1), it("",2), it("slot.2.0.owner",2)`; `frame_places_binding…`'s
  `slot.1.0`→`slot.2.0`).

### 3. `client/src/client.rs` matcher (`match_recipes_inner` + helpers)

The recipe iterators now address branches 1/2/3 (= stack_id), so cards must group
by `stack_id`, and the root/tile move:

- **`by_branch`**: key by `stack_id` (= `stack_branch(flags) + 1`: 1 hex, 2 top,
  3 bottom) instead of raw branch (0/1/2). `base_branches` indexed accordingly
  (consider a `[Vec<u32>; 4]` with index = stack_id, [0] unused/root).
- **`synthetic_tile`**: still the tile under the root in the hex cell — but it now
  represents the `slot.1.0` (stack 1) member. The `has_synthetic` sentinel in
  `build_bindings` moves branch `0 → 1`.
- **`build_bindings`**: map iterator branch N → cards in stack_id N. The branch-1
  empty + has_synthetic → `[0]` tile sentinel (was branch 0).
- **`promote_root`**: a loose root promotes into stack 2 (top) / 3 (bottom) (was
  branch 1/2). **`anchors_fit`**: expected-branch checks shift by +1.
- The `root` param to `build_frame` is unchanged (still passed); only its target
  path changed (handled in recipe.rs).
- GOTCHA: codec `Micro::Stacked{branch}` still stores `branch = stack_id − 1`;
  read `stack_branch(flags)` and `+1` to get the stack_id the matcher groups on.

### 4. `pixijs/src/shared/rules/src/dsl_recipe.rs`

- `grep` for `"root"` path usage (`frame.card_at("root")`, hold/effect target
  back-translation). After B the root is at `slot.0.0` — update any literal
  `"root"` string to `"slot.0.0"`.

### 5. Don't forget

- The gate calls `dsl_recipe::run`/`build_frame` with the same `root` param —
  no signature change needed, but it must be rebuilt (`RD_ENV=test bin/gate
  build` + `publish`).
- TS `recipeMatcher.ts` (pixijs) is the stale mirror; the headless Rust client is
  authoritative now and the pixijs view is broken — skip TS unless reviving it.
- Unit tests: `bin/client test` (matcher tests, e.g. `matcher_helpers_mirror_*`)
  + the shared workspace tests (`recipe.rs`, `stack.rs`). Update any that bake
  slot paths.

## Verify

1. `bin/client check` + shared `cargo check --workspace --all-targets`.
2. `bin/client test` + shared `cargo test --workspace` (fix baked slot paths).
3. Rebuild: `RD_ENV=test bin/redeploy --run` (shard), `RD_ENV=test bin/gate
   publish` (gate, reloads renumbered recipes), wipe `cards regions players`.
4. `RD_ENV=test bin/client run` → `HARNESS PASS (combined, 2 clients)`.

Build/run notes: gate stalls run-to-run are fixed (self-healing pooled conns),
but `bin/gate down`+`up` only restarts the container — use `bin/gate publish` to
relaunch the binary + reload content. Only ever touch `test`/`claude` envs.
