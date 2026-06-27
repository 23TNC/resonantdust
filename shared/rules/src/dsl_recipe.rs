//! DSL recipe evaluation — run a proposal's recipe on the shared VM and
//! translate the result into the [`ActionPlan`] a consumer applies.
//!
//! Generic over [`CardStore`]: cards are read through the trait, so the gate
//! (over its gathered snapshot) and the client (over its world model) share this
//! code by construction. The shared crate provides the recipe runtime; this
//! module bridges a card store to it:
//!   - **rows → `Card`**: a stored row's `packed_definition` is decoded to a card
//!     **name** via the [`Bundle`] and re-id'd to the bound `Card` the vm reads.
//!   - **frame**: [`build_frame`] places the bound cards at their slot paths.
//!   - **match + plan**: the vm matches `@input` (a `0`-ret predicate) and runs
//!     the `@output` timeline.
//!   - **`vm::Plan` → `ActionPlan`**: each time-stamped effect maps to a stock
//!     write (bound card / synthetic tile) or a `Create`, with owner-walk target
//!     resolution against the store. Holds, lifecycle (dead) and pstyle are all
//!     `Stock` effects now — there is no separate hold list.

use resonantdust_codec::card_model;
use resonantdust_codec::packed::{pack_macro_zone_full, INVENTORY_LAYER, TAG_ID_MAX, TAG_ID_MIN};
use resonantdust_codec::plan::{ActionPlan, Effect, StockOp, TimedEffect};
use resonantdust_dsl::bridge::{stock_default_u64, stock_slot_bits, stock_slot_for_aspect, stock_to_vec, Card};
use resonantdust_dsl::loader::Bundle;
use resonantdust_dsl::recipe::{build_frame, Frame};
use resonantdust_dsl::vm::{match_recipe, plan_recipe, Effect as VmEffect};
use resonantdust_state::recipe_state::CardStore;

/// Evaluate `recipe_name`'s DSL recipe against the card `store` and bound cards,
/// returning the [`ActionPlan`] to apply. Errors if the recipe is unknown or its
/// `@input` predicate rejects the bindings. `now_ms` is the read time for
/// `store.card_at`.
pub fn run<S: CardStore>(
    bundle: &Bundle,
    store: &S,
    recipe_name: &str,
    root: u32,
    bindings: &[Vec<u32>],
    synthetic: Option<(u16, (u8, u8))>,
    now_ms: u64,
) -> Result<ActionPlan, String> {
    let recipe = bundle
        .recipe(recipe_name)
        .ok_or_else(|| format!("DSL recipe {recipe_name:?} not found"))?;

    // The synthetic tile as a typed Card (def re-id'd, its two zone stocks
    // overlaid positionally onto the def's schema by `card_view`).
    let synth_card = match synthetic {
        Some((packed, (s0, s1))) => {
            let name = bundle
                .name_for_packed(packed)
                .ok_or_else(|| format!("tile packed {packed:#06x} not in DSL bundle"))?;
            let def_id = bundle
                .card_def_id(name)
                .ok_or_else(|| format!("tile {name:?} not in DSL bundle"))?;
            Some(Card { def_id, stock: vec![s0 as i64, s1 as i64], stock_raw: 0 })
        }
        None => None,
    };

    // Bridge a bound card_id → typed Card (decode packed → name → bound Card).
    let lookup = |id: u32| -> Option<Card> {
        let c = store.card_at(id, now_ms)?;
        let name = bundle.name_for_packed(c.packed_definition)?;
        let def_id = bundle.card_def_id(name)?;
        Some(Card { def_id, stock: stock_to_vec(bundle, name, c.stock), stock_raw: c.stock })
    };

    let mut frame = build_frame(bundle, recipe, root, bindings, synth_card.as_ref(), &lookup);

    // Match @input (the `0`-ret predicate) then run @output.
    let input = recipe.hook("input").map(|h| h.body.as_slice()).unwrap_or(&[]);
    let mp = match_recipe(input, &mut frame.store, &bundle.catalog, &bundle.functions)?;
    if !mp.matched {
        return Err(format!("recipe {recipe_name:?} input not satisfied by bindings"));
    }
    let output = recipe.hook("output").map(|h| h.body.as_slice()).unwrap_or(&[]);
    let pp = plan_recipe(output, &mut frame.store, &bundle.catalog, &bundle.functions)?;

    translate(bundle, store, &frame, &pp.effects, pp.duration, &synth_card, now_ms)
}

/// `vm::Plan` effects → [`ActionPlan`]. Each timed effect becomes a stock write
/// (bound card → `SetCardStock`; synthetic tile → `ModifyTileStock`) or a
/// `Create`. Created-card stock sets fold into the `Create` (no extra effect);
/// a created card whose owner is another created card gets a transient TAG.
fn translate<S: CardStore>(
    bundle: &Bundle,
    store: &S,
    frame: &Frame,
    effects: &[resonantdust_dsl::vm::TimedEffect],
    duration: i64,
    synth: &Option<Card>,
    now_ms: u64,
) -> Result<ActionPlan, String> {
    let mut ap = ActionPlan { duration: duration.max(0) as u32, effects: Vec::new() };

    // Cards created in THIS plan, folded so same-card stock sets don't become
    // extra effects. Handles are `created.N` = the Nth `^create` in tape order.
    let mut synths: Vec<Synthetic> = Vec::new();

    for te in effects {
        let at = te.at;
        match &te.effect {
            VmEffect::Stock { slot, aspect, delta, abs } => {
                if let Some((idx, rem)) = parse_created(slot) {
                    // Fold into the created card's synthetic payload — no effect.
                    if !rem.is_empty() {
                        return Err(format!("stock op {slot:?}: malformed handle target"));
                    }
                    let s = synths
                        .get_mut(idx)
                        .ok_or_else(|| format!("stock op: unknown handle created.{idx}"))?;
                    s.stock = fold_stock(bundle, &s.def_key, s.stock, aspect, *delta, *abs)?;
                } else if let Some(card_id) = frame.card_at(slot) {
                    // GLOBAL aspect (holds claim/borrow/pos_hold/touch/dead/reap) →
                    // op-log: append the ±delta and let the shard materialize the
                    // stock global region (bits 42-63), commutative + forward-
                    // propagated. The content-agnostic shard reads `aspect_id` →
                    // fixed bits with no content. This supersedes the old dead→flag
                    // Destroy and the holds-as-SetCardStock paths.
                    if let Some(asp) = resonantdust_codec::aspects::StockAspect::from_name(aspect) {
                        use resonantdust_codec::oplog::AspectOp;
                        let (op, modifier) = if *abs {
                            (AspectOp::Set, *delta)
                        } else if *delta < 0 {
                            (AspectOp::Dec, -*delta)
                        } else {
                            (AspectOp::Inc, *delta)
                        };
                        ap.effects.push(TimedEffect {
                            at,
                            effect: Effect::LogOp { card_id, aspect_id: asp.id(), op: op.code(), modifier },
                        });
                    } else {
                        // Per-def aspect (gameplay wood/pine, pstyle) → write the
                        // card's per-card `stock` u64 (current value with this
                        // slot's bits replaced), absolute SetCardStock stamped @at.
                        let c = store
                            .card_at(card_id, now_ms)
                            .ok_or_else(|| format!("stock op: bound card {card_id} not found"))?;
                        let name = bundle
                            .name_for_packed(c.packed_definition)
                            .ok_or_else(|| format!("stock op: card {card_id} packed not in bundle"))?;
                        let new_stock = fold_stock(bundle, name, c.stock, aspect, *delta, *abs)?;
                        ap.effects.push(TimedEffect {
                            at,
                            effect: Effect::SetCardStock { card_id, stock: new_stock },
                        });
                    }
                } else {
                    // Unplaced → the synthetic tile (the zone-savable u4 path).
                    let tile = synth
                        .as_ref()
                        .ok_or_else(|| "tile stock op but no synthetic tile".to_string())?;
                    let tile_name = bundle
                        .card_name(tile.def_id)
                        .ok_or_else(|| "tile def has no name".to_string())?;
                    let idx = stock_slot_for_aspect(bundle, tile_name, aspect).ok_or_else(|| {
                        format!("tile {tile_name:?} declares no stock slot for aspect {aspect:?}")
                    })?;
                    let (op, mag) = if *abs {
                        (StockOp::Set, *delta)
                    } else if *delta < 0 {
                        (StockOp::Sub, -*delta)
                    } else {
                        (StockOp::Add, *delta)
                    };
                    ap.effects.push(TimedEffect {
                        at,
                        effect: Effect::ModifyTileStock { slot: idx as u8, op, delta: mag.clamp(0, 255) as u8 },
                    });
                }
            }
            VmEffect::Create { def, owner, zone_owner, surface, q, r } => {
                let dk = def_key(def);
                let owner_ref = resolve_owner(frame, store, owner, now_ms)?;
                let zone_ref = resolve_owner(frame, store, zone_owner, now_ms)?;
                let stock = stock_default_u64(bundle, &dk);
                synths.push(Synthetic {
                    def_key: dk,
                    owner_ref,
                    zone_ref,
                    surface: *surface as u8,
                    q: *q,
                    r: *r,
                    stock,
                    alive: true,
                    tag: 0,
                    at,
                });
            }
        }
    }

    // Assign a transient tag to every surviving synthetic another surviving
    // synthetic nests in (as its owner OR its zone owner). A child always appears
    // AFTER its parent in tape order (a handle can't be referenced before its
    // `^create`), so tape order is a valid causal order — owner refs point
    // backwards only, no cycles.
    let mut next_tag = TAG_ID_MIN;
    for i in 0..synths.len() {
        if !synths[i].alive {
            continue;
        }
        for m in [synths[i].owner_ref.synth(), synths[i].zone_ref.synth()].into_iter().flatten() {
            if !synths.get(m).map(|s| s.alive).unwrap_or(false) {
                return Err(format!("created.{i} nests in created.{m}, which was destroyed or absent"));
            }
            if synths[m].tag == 0 {
                if next_tag > TAG_ID_MAX {
                    return Err(format!("recipe needs more than {TAG_ID_MAX} created-card tags"));
                }
                synths[m].tag = next_tag;
                next_tag += 1;
            }
        }
    }

    // Emit one `Create` per surviving synthetic, in tape (= causal) order, so the
    // shard fills `tag -> id` for a parent before it writes a child. An owner /
    // zone-owner that is a created card resolves to that card's tag.
    for i in 0..synths.len() {
        let s = &synths[i];
        if !s.alive {
            continue;
        }
        let owner_id = s.owner_ref.id(&synths);
        let zone_owner_id = s.zone_ref.id(&synths);
        // Inventory (surface == INVENTORY_LAYER) lands on the first free cell
        // (micro_location None); a world surface keeps the requested cell coords.
        let macro_zone = if s.surface == INVENTORY_LAYER {
            pack_macro_zone_full(zone_owner_id, s.surface, 0, 0)
        } else {
            pack_macro_zone_full(zone_owner_id, s.surface, s.q as i16, s.r as i16)
        };
        ap.effects.push(TimedEffect {
            at: s.at,
            effect: Effect::Create {
                def_key: s.def_key.clone(),
                surface: s.surface,
                macro_zone,
                owner_id,
                stock: s.stock,
                tag: s.tag,
                micro_location: None,
            },
        });
    }

    Ok(ap)
}

/// A card created in this plan, folded so same-card stock sets don't become extra
/// effects. `owner_ref`/`zone_ref` are the ownership + placement targets (a real
/// bound card or a sibling created card); `tag` (0 = none) is set when another
/// synthetic nests in this one. `at` is the `sys.time` of its `^create`.
struct Synthetic {
    def_key: String,
    owner_ref: OwnerRef,
    zone_ref: OwnerRef,
    surface: u8,
    q: i64,
    r: i64,
    stock: u64,
    alive: bool,
    tag: u32,
    at: i64,
}

/// Whose card an owner/zone path resolves to: a real bound card_id, or a sibling
/// created card (index into the synthetics, addressed `created.M`).
#[derive(Clone, Copy)]
enum OwnerRef {
    Real(u32),
    Synth(usize),
}

impl OwnerRef {
    fn synth(self) -> Option<usize> {
        match self {
            OwnerRef::Synth(m) => Some(m),
            OwnerRef::Real(_) => None,
        }
    }
    /// The concrete owner value the `Create` effect carries: a real id, or the
    /// referenced synthetic's transient tag (assigned before this is called).
    fn id(self, synths: &[Synthetic]) -> u32 {
        match self {
            OwnerRef::Real(id) => id,
            OwnerRef::Synth(m) => synths[m].tag,
        }
    }
}

/// Resolve an owner/zone path to an [`OwnerRef`]: a `created.N` handle → that
/// synthetic; otherwise walk the path (`.owner`/`.parent`) to a bound card_id.
fn resolve_owner<S: CardStore>(
    frame: &Frame,
    store: &S,
    path: &str,
    now_ms: u64,
) -> Result<OwnerRef, String> {
    if let Some((idx, rem)) = parse_created(path) {
        if !rem.is_empty() {
            return Err(format!("owner handle {path:?} must be a bare created.N"));
        }
        return Ok(OwnerRef::Synth(idx));
    }
    let (id, container) = resolve_target(frame, store, path, now_ms)?;
    if let Some(c) = container {
        return Err(format!("owner path {path:?} must resolve to a card, not a {c:?} container"));
    }
    Ok(OwnerRef::Real(id))
}

/// Split a `created.N[.rest]` handle path into its synthetic index and remainder
/// (`""` for the bare handle). `None` for any non-handle path.
fn parse_created(path: &str) -> Option<(usize, &str)> {
    let rest = path.strip_prefix("created.")?;
    let (idx, remainder) = match rest.find('.') {
        Some(p) => (&rest[..p], &rest[p + 1..]),
        None => (rest, ""),
    };
    Some((idx.parse::<usize>().ok()?, remainder))
}

/// Replace one stock slot's bits in `stock` with the recipe's value: the same
/// read-modify-write the bound-card `SetCardStock` path uses, over either a card
/// row's stock or a synthetic's working stock. `abs` sets the slot; otherwise it
/// adds `delta` to the current value. Errors if `card` declares no slot for
/// `aspect`.
fn fold_stock(
    bundle: &Bundle,
    card: &str,
    stock: u64,
    aspect: &str,
    delta: i64,
    abs: bool,
) -> Result<u64, String> {
    let (shift, width) = stock_slot_bits(bundle, card, aspect)
        .ok_or_else(|| format!("card {card:?} declares no stock slot for aspect {aspect:?}"))?;
    let cap: u64 = if width >= 64 { u64::MAX } else { (1u64 << width) - 1 };
    let cur = resonantdust_codec::bits::get_field64(stock, shift, width) as i64;
    let new_val = if abs {
        delta.clamp(0, cap as i64) as u64
    } else {
        (cur + delta).clamp(0, cap as i64) as u64
    };
    Ok(resonantdust_codec::bits::set_field64(stock, shift, width, new_val))
}

/// `card::corpus_dim` → the bare key (`corpus_dim`).
fn def_key(def: &str) -> String {
    def.rsplit("::").next().unwrap_or(def).to_string()
}

/// Resolve a slot-path target to a concrete card_id, walking `.owner` / `.parent`
/// past the longest placed-card prefix via the store. Returns the resolved card
/// and any trailing container word (`inventory`/`location`).
fn resolve_target<S: CardStore>(
    frame: &Frame,
    store: &S,
    path: &str,
    now_ms: u64,
) -> Result<(u32, Option<String>), String> {
    if let Some(id) = frame.card_at(path) {
        return Ok((id, None));
    }
    let (_, mut cid, remainder) = frame
        .longest_prefix(path)
        .ok_or_else(|| format!("unresolved target path {path:?}"))?;
    let mut container = None;
    for seg in remainder.split('.').filter(|s| !s.is_empty()) {
        match seg {
            "owner" => {
                cid = store
                    .card_at(cid, now_ms)
                    .map(|c| c.owner_id)
                    .filter(|&o| o != 0)
                    .ok_or_else(|| format!("owner step: card {cid} has no owner"))?;
            }
            "parent" => {
                let c = store
                    .card_at(cid, now_ms)
                    .ok_or_else(|| format!("parent step: card {cid} not in store"))?;
                if !card_model::micro_is_card(c.flags) {
                    return Err(format!("parent step: card {cid} is not stacked"));
                }
                cid = c.micro_location;
            }
            "inventory" | "location" => container = Some(seg.to_string()),
            other => return Err(format!("unsupported target step {other:?} in {path:?}")),
        }
    }
    Ok((cid, container))
}

#[cfg(test)]
mod tests {
    use super::*;
    use resonantdust_dsl::loader::load;
    use resonantdust_state::recipe_state::CardView;
    use std::collections::HashMap;

    struct Mock(HashMap<u32, CardView>);
    impl CardStore for Mock {
        fn card_at(&self, id: u32, _t: u64) -> Option<CardView> {
            self.0.get(&id).cloned()
        }
    }

    // Minimal corpus: `type`/`progress`/`dead` aspects, an owner `human`, a `log`
    // with an 8-bit `progress` stock (default 1), a childless `pip`, and a `make`
    // recipe that creates a log into the human's inventory, bumps its progress to
    // 4, then nests a pip inside the log (surface 1 = inventory).
    fn bundle() -> Bundle {
        let aspects = "<aspect>\n  ::type>\n    @define>\n      traits &section set\n  \
            ::progress>\n    @define>\n      traits &section set\n  \
            ::dead>\n    @define>\n      traits &section set\n";
        let cards = "<card>\n\
            \x20 ::human>\n    :data>\n      @define>\n        requisite &data.type set\n\
            \x20 ::log>\n    :data>\n      @define>\n        requisite &data.type set\n        \
                8 &data.progress stock\n        1 &data.progress set\n\
            \x20 ::pip>\n    :data>\n      @define>\n        requisite &data.type set\n";
        let recipe = "<recipe>\n  ::make>\n    @input>\n      0 ret\n    @output>\n      \
            &slot.0.0 1 0 0 ^macro_zone call &hz set\n      \
            *hz $card::log &slot.0.0 ^create call &log set\n      \
            4 &log.data.progress set\n      \
            &log 1 0 0 ^macro_zone call &lz set\n      \
            *lz $card::pip &log ^create call drop\n";
        load(&[
            ("a.rd".into(), aspects.into()),
            ("c.rd".into(), cards.into()),
            ("r.rd".into(), recipe.into()),
        ])
        .expect("load")
    }

    fn root_store(b: &Bundle, root: u32) -> Mock {
        let human = b.packed_def("human").expect("human def");
        Mock(HashMap::from([(
            root,
            CardView {
                card_id: root,
                owner_id: 0,
                micro_location: 0,
                macro_zone: 0,
                packed_definition: human,
                flags: 0,
                stock: 0,
            },
        )]))
    }

    #[test]
    fn fold_and_tag_nested_create() {
        let b = bundle();
        let root = 5000u32;
        let ap = run(&b, &root_store(&b, root), "make", root, &[], None, 0).expect("run");
        let creates: Vec<&Effect> = ap.effects.iter().map(|t| &t.effect).collect();
        assert_eq!(
            creates,
            vec![
                // log: real owner (root), default progress(1) overwritten by abs
                // set(4), tagged 1 because pip nests in it.
                &Effect::Create {
                    def_key: "log".into(),
                    surface: INVENTORY_LAYER,
                    macro_zone: pack_macro_zone_full(root, INVENTORY_LAYER, 0, 0),
                    owner_id: root,
                    stock: 4,
                    tag: 1,
                    micro_location: None,
                },
                // pip: owner + zone are log's tag (shard resolves), no own tag.
                &Effect::Create {
                    def_key: "pip".into(),
                    surface: INVENTORY_LAYER,
                    macro_zone: pack_macro_zone_full(1, INVENTORY_LAYER, 0, 0),
                    owner_id: 1,
                    stock: 0,
                    tag: 0,
                    micro_location: None,
                },
            ]
        );
        // No SetCardStock — the created card's stock folded into its Create.
        assert!(
            !ap.effects.iter().any(|t| matches!(t.effect, Effect::SetCardStock { .. })),
            "created-card stock must fold into Create, not emit SetCardStock"
        );
    }

    // The new-model timeline translation: a hold (`data.claim inc`) at sys.time 0
    // becomes a SetCardStock @at=0; a `data.dead inc` becomes a Destroy (the dead
    // FLAG the reaper acts on, since the shard is content-agnostic); a spawn at
    // sys.time 10 is a Create @at=10. Verifies dead→Destroy, holds→stock, and
    // per-effect `at` stamping.
    #[test]
    fn global_aspects_route_to_logop_timed() {
        let aspects = "<aspect>\n  ::type>\n    @define>\n      traits &section set\n  \
            ::claim>\n    @define>\n      traits &section set\n  \
            ::dead>\n    @define>\n      traits &section set\n";
        let cards = "<card>\n\
            \x20 ::host>\n    :data>\n      @define>\n        requisite &data.type set\n        \
                3 &data.claim stock\n        3 &data.dead stock\n\
            \x20 ::widget>\n    :data>\n      @define>\n        requisite &data.type set\n";
        let recipe = "<recipe>\n  ::act>\n    @input>\n      0 ret\n    @output>\n      \
            0 &sys.time set\n      \
            &slot.0.0.data.claim inc\n      \
            10 &sys.time set\n      \
            &slot.0.0.data.dead inc\n      \
            &slot.0.0 1 0 0 ^macro_zone call &z set\n      \
            *z $card::widget &slot.0.0 ^create call drop\n";
        let b = load(&[
            ("a.rd".into(), aspects.into()),
            ("c.rd".into(), cards.into()),
            ("r.rd".into(), recipe.into()),
        ])
        .expect("load");

        let root = 7000u32;
        let host = b.packed_def("host").expect("host def");
        let store = Mock(HashMap::from([(
            root,
            CardView {
                card_id: root,
                owner_id: 0,
                micro_location: 0,
                macro_zone: 0,
                packed_definition: host,
                flags: 0,
                stock: 0,
            },
        )]));
        let ap = run(&b, &store, "act", root, &[], None, 0).expect("run");

        // Global aspects route to the op-log: claim acquire → LogOp(Claim,Inc) @0;
        // dead → LogOp(Dead,Inc) @10; the spawn is a Create @10.
        use resonantdust_codec::aspects::StockAspect;
        use resonantdust_codec::oplog::AspectOp;
        let claim = ap.effects.iter().find(|t| matches!(&t.effect, Effect::LogOp { aspect_id, .. } if *aspect_id == StockAspect::Claim.id()));
        assert!(matches!(claim, Some(TimedEffect { at: 0, effect: Effect::LogOp { card_id, op, modifier, .. } })
                if *card_id == root && *op == AspectOp::Inc.code() && *modifier == 1),
            "claim → LogOp(Claim,Inc) @0 on root, got {:?}", claim);
        assert!(ap.effects.iter().any(|t| matches!(&t.effect, Effect::LogOp { card_id, aspect_id, .. }
                if *card_id == root && *aspect_id == StockAspect::Dead.id()) && t.at == 10),
            "dead → LogOp(Dead) @10 on root, effects: {:?}", ap.effects);
        assert!(ap.effects.iter().any(|t| matches!(&t.effect, Effect::Create { def_key, .. } if def_key == "widget") && t.at == 10),
            "spawn → Create @10, effects: {:?}", ap.effects);
    }
}
