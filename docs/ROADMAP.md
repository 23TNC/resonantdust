# Roadmap / open work

The single consolidated list of outstanding work — replaces the TODOs that were
scattered across code comments, issue refs, and per-feature design docs. Grouped
by subsystem; each item says where it stands and what's left. Keep this current
when a thread lands or a new one opens.

## Worldgen / zone streaming

The black-gap bug, current-value regions, the promise protocol, viewport
prefetch, and the stationary render-kick all landed and are live-verified (claude
env). Small follow-ups remain:

- **Render-kick for cards.** The kick that repaints a stationary viewport when a
  future-stamped row promotes (`client/core` `Zones::min_future_time` →
  `next_zone_promote` → `render_kick`) covers **zones only**. A card/object that
  promotes from a future-stamped row with no accompanying zone change won't
  repaint. At load, cards ride zone promotion so it's covered; a solo card
  promotion is the gap. Extend with `Cards::min_future_time`, same pattern.
- **Pool-level request dedup.** The gate dedups duplicate `request_zone` /
  `ensure_region` per **connection** (`gateway/src/promise.rs` `is_duplicate` +
  cooldown). A reconnect or a second client can still hand the gate a duplicate;
  the reducers are idempotent so it's wasted work, not a bug. Pool-level dedup
  would close it — probably not worth it yet.
- **Prefetch tuning.** `client/wasm` `ANCHOR_MARGIN_TILES = 2` (active disk =
  viewport + 2 tiles, no cold ring) is a deliberate starting point. If pop-in
  shows at high pan speed: bump the margin first, then velocity-aware /
  directional prefetch (request the leading edge deeper than the trailing).
- **Anchor tiers mostly unused.** `AnchorRadii` still carries hot/warm/cold tiers
  ([anchor zone system](#anchor-zone-tiers)), but the viewport now sets only
  `active` (+2-tile margin). The tier machinery is dormant; either drive it
  (fog-of-war / soul-scope anchors) or trim it.
- **`clear_available_bit` unwired.** `shard/regions.rs` has the symmetric
  `&= bit` for zone removal, but no zone-removal path calls it. Wire it when zones
  become removable; to stop regen, also clear the region's `zone_presence` bit.

## Movement

`move_soul` future-stamps a precomputed path; server validates per-step. Pending:

- **S3 — client interpolation.** Tween the soul between tiles as its future rows
  promote (today it snaps).
- **S4 — gate path validation.** The shard validates adjacency/traversability;
  the gate-side re-derivation of `arrival_ms` from `speed` + tile `cost`s is the
  authority. Confirm the gate fully owns/validates the path.

## Stacking

Root-pointer chains + the canonical resolver (`codec::stacking`) landed and are
live-verified. Pending:

- **Bit-field stacking wire-in + render.** `stack_hosts`/`stack_joins` trait
  aspects (bit i = stack i) resolve, but the wire-in + render path isn't
  finished. `codec::resolve_stack_drop` is still **unwired**.
- **Concurrency harness J2+.** The `jim` multi-client stack harness has J1 done;
  J2+ (concurrent splice / hold contention) pending.
- Design: [docs/stacking_refactor_B.md](stacking_refactor_B.md).

## Card stock (u32 per-card)

`stock` is a per-card u32 (bottom u4 zone-savable). Stage 1 (recipe **read** via
`stock_to_vec`) done. Remaining (issue #35):

- **Write-effect** — a recipe writing a card's stock.
- **Spawn-default** — seed stock from the def's `@define` on create (the gate
  injects it today for `create_card`; generalize).
- **GC demote-guard** — don't demote/reap a card whose stock is load-bearing.

## Magnetic recipes

Trusted server-side "magnetic player" (client-core `Session`) owns + drives
magnetic cards. P1 + P3-core landed and compile. Remaining: gate **runtime**
(actually run the magnetic pass on the gate), redirect, lock, verify.

## Content authoring / R2

DSL + locales are served from R2 via the gate; all 4 phases (load / re-poll /
client hot-reload / S3 authoring write-back) landed. Loose ends:

- **P3 browser-verify** — confirm a live `content_changed` hot-reload end-to-end
  in the browser.
- **Compose `R2_*` env wiring** — the deploy compose needs the R2 S3 creds wired
  (authority gate authoring path).
- **Editor server LOD regen** — the Card Editor write-back versions a card def
  but doesn't regenerate server-side LOD/light bakes on remaster.

## def-id GC

Content versioning mints a NEW def id per `modify_content`
(`<lineage>.<next>`), orphaning the old one. Need a sweep that reclaims a def id
once no live row references it. **Not built** — `gateway/src/content.rs`
`TODO(def-id GC)`.

## Portraits

`portrait_id` was cut in the flags/stock split. Soul portraits won't render until
it's relocated (out of the flags host into per-instance data).
`shard/souls.rs` `TODO(portrait-relocate)`.

## Client off the SDK

The client transport is fully off the SpacetimeDB SDK connection; the npm dep is
retained only for binding **types**. P3 tail: decouple the types, delete
`bindings/`, drop the `spacetimedb` npm dep.

## Anchor zone tiers

The aspect-driven anchor tier system (active ⊃ hot ⊃ warm ⊃ cold; sticky subs;
per-soul watermark memory) has Phase A landed. Phases B–E pending. Note the
viewport prefetch simplification above made the tiers dormant for the world
viewport — revisit when soul-scope / fog-of-war anchors need them.

## Deploy

This session's fixes (current-value regions, promise protocol, prefetch, render
kick, dedup) are verified in the **claude** env only. They reach players only
once deployed to **alpha** (lightsail): build local → push prebuilt binary + wasm
→ republish the shard + restart the gate. See
[project_alpha_gate_deploy / project_lightsail_deploy in memory].
