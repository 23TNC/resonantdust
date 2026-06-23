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
//!   - **match + plan**: the vm matches `@input` and runs `@output`.
//!   - **`vm::Plan` → `ActionPlan`**: holds, effects, styles, duration mapped to
//!     the shape consumers apply. Owner-walk for `create` / unlock targets
//!     resolves against the store here.
//!
//! State validation (ownership / not-dead / holds / dedup) lives in
//! [`resonantdust_state::recipe_state::validate_bindings`]; this module is recipe
//! *semantics* only.

use std::collections::BTreeMap;

use resonantdust_codec::card_model;
use resonantdust_codec::packed::{pack_macro_zone_full, surface_of, INVENTORY_LAYER, TAG_ID_MAX, TAG_ID_MIN};
use resonantdust_codec::plan::{ActionPlan, Effect, HoldKinds, StockOp};
use resonantdust_dsl::bridge::{stock_default_u32, stock_slot_bits, stock_slot_for_aspect, stock_to_vec, Card};
use resonantdust_dsl::loader::Bundle;
use resonantdust_dsl::recipe::{build_frame, Frame};
use resonantdust_dsl::vm::{match_recipe, plan_recipe, Effect as VmEffect, Hold};
use resonantdust_state::recipe_state::CardStore;

/// Evaluate `recipe_name`'s DSL recipe against the card `store` and bound cards,
/// returning the [`ActionPlan`] to apply. Errors if the recipe is unknown or its
/// `@input` predicates don't hold against the bindings (the match step replaces
/// the legacy `validate_input`). `now_ms` is the read time for `store.card_at`.
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
            Some(Card { def_id, stock: vec![s0 as i64, s1 as i64] })
        }
        None => None,
    };

    // Bridge a bound card_id → typed Card (decode packed → name → bound Card).
    // Per-instance `stock` u32 is decoded per the def's stock schema so a card's
    // live stock aspects (build progress, etc.) read in matching — not just its
    // static `@define` defaults.
    let lookup = |id: u32| -> Option<Card> {
        let c = store.card_at(id, now_ms)?;
        let name = bundle.name_for_packed(c.packed_definition)?;
        let def_id = bundle.card_def_id(name)?;
        Some(Card { def_id, stock: stock_to_vec(bundle, name, c.stock) })
    };

    let mut frame = build_frame(bundle, recipe, root, bindings, synth_card.as_ref(), &lookup);

    // Match @input (the conjunction verdict) then run @output.
    let input = recipe.hook("input").map(|h| h.body.as_slice()).unwrap_or(&[]);
    let mp = match_recipe(input, &mut frame.store, &bundle.catalog, &bundle.functions)?;
    if !mp.matched {
        return Err(format!("recipe {recipe_name:?} input not satisfied by bindings"));
    }
    let output = recipe.hook("output").map(|h| h.body.as_slice()).unwrap_or(&[]);
    let pp = plan_recipe(output, &mut frame.store, &bundle.catalog, &bundle.functions)?;

    translate(bundle, store, &frame, &mp.holds, &pp.styles, &pp.effects, pp.duration, &synth_card, now_ms)
}

/// `vm::Plan` parts → [`ActionPlan`]. Holds split into per-card and the
/// synthetic tile's (`tile_holds`); effects map 1:1 with owner-walk target
/// resolution; styles + duration carry through.
#[allow(clippy::too_many_arguments)]
fn translate<S: CardStore>(
    bundle: &Bundle,
    store: &S,
    frame: &Frame,
    holds: &[(String, Hold)],
    styles: &[(String, String)],
    effects: &[VmEffect],
    duration: i64,
    synth: &Option<Card>,
    now_ms: u64,
) -> Result<ActionPlan, String> {
    let mut ap = ActionPlan {
        styles: BTreeMap::new(),
        duration: duration.max(0) as u32,
        effects: Vec::new(),
        holds: BTreeMap::new(),
        tile_holds: None,
    };

    // Holds: a path with a placed card → per-card; an unplaced path is the
    // synthetic tile (addressed positionally by apply) → tile_holds.
    for (path, hold) in holds {
        let k = kinds(hold);
        match frame.card_at(path) {
            Some(cid) => merge(ap.holds.entry(cid).or_insert(ZERO), &k),
            None => {
                let mut t = ap.tile_holds.take().unwrap_or(ZERO);
                merge(&mut t, &k);
                ap.tile_holds = Some(t);
            }
        }
    }

    for (path, style) in styles {
        if let Some(cid) = frame.card_at(path) {
            ap.styles.insert(cid, style_code(style));
        }
    }

    // Cards created in THIS plan are folded: each `create … as h` becomes a
    // synthetic payload that same-card `&h.aspect.x set` / `&h destroy` mutate in
    // place, so a created card is one `Effect::Create` row, never a follow-up
    // `SetCardStock`. A created card referencing another (nesting via
    // `&parent.inventory create`) is the only cross-create link; the parent gets a
    // transient TAG the shard resolves to the minted id. Handles are `created.N`
    // = the Nth `create` in tape order (matches the VM's `Cell::Ref("created.N")`),
    // so `synths[N]` indexes by tape position; a destroyed one stays as a dead
    // slot to keep the indices aligned.
    let mut synths: Vec<Synthetic> = Vec::new();

    for eff in effects {
        match eff {
            VmEffect::Destroy { slot } => {
                if let Some((idx, rem)) = parse_created(slot) {
                    if !rem.is_empty() {
                        return Err(format!("destroy {slot:?}: cannot destroy a sub-path of a handle"));
                    }
                    synths
                        .get_mut(idx)
                        .ok_or_else(|| format!("destroy: unknown handle created.{idx}"))?
                        .alive = false;
                } else {
                    let cid = frame
                        .card_at(slot)
                        .ok_or_else(|| format!("destroy: {slot:?} is not a bound card"))?;
                    ap.effects.push(Effect::Destroy { card_id: cid });
                }
            }
            VmEffect::Create { def, target } => {
                let dk = def_key(def);
                // Where the created card lands: a sibling created card's inventory
                // (`created.M.inventory`), a real bound card's `.inventory`, or a
                // bound card's `.location` (its exact world cell — the blueprint
                // spot the chord soul takes).
                let placement = if let Some((m, rem)) = parse_created(target) {
                    if rem != "inventory" {
                        return Err(format!("create into {target:?}: handle target must end in .inventory"));
                    }
                    Placement::Inventory(OwnerRef::Synth(m))
                } else {
                    let (card, container) = resolve_target(frame, store, target, now_ms)?;
                    match container.as_deref() {
                        Some("inventory") => Placement::Inventory(OwnerRef::Real(card)),
                        Some("location") => {
                            // `card` is the bound card itself — spawn at its zone+cell,
                            // re-owned by ITS owner (a world soul owns its world cards).
                            let c = store
                                .card_at(card, now_ms)
                                .ok_or_else(|| format!("create at {target:?}: card {card} not found"))?;
                            Placement::At {
                                surface: surface_of(c.macro_zone),
                                macro_zone: c.macro_zone,
                                micro_location: c.micro_location,
                                owner_id: c.owner_id,
                            }
                        }
                        _ => return Err(format!(
                            "create target must end in .inventory or .location; got {target:?}"
                        )),
                    }
                };
                let stock = stock_default_u32(bundle, &dk);
                synths.push(Synthetic { def_key: dk, placement, stock, alive: true, tag: 0 });
            }
            VmEffect::Move { source, target } => {
                let card_id = frame
                    .card_at(source)
                    .ok_or_else(|| format!("move: source {source:?} is not a bound card"))?;
                let (dest, container) = resolve_target(frame, store, target, now_ms)?;
                let (surface, macro_zone, owner_id) = match container.as_deref() {
                    Some("inventory") => (
                        INVENTORY_LAYER,
                        pack_macro_zone_full(dest, INVENTORY_LAYER, 0, 0),
                        dest,
                    ),
                    Some("location") => {
                        let c = store
                            .card_at(dest, now_ms)
                            .ok_or_else(|| format!("move to {target:?}: card {dest} not found"))?;
                        (surface_of(c.macro_zone), c.macro_zone, c.owner_id)
                    }
                    _ => return Err(format!(
                        "move target must end in .inventory or .location; got {target:?}"
                    )),
                };
                ap.effects.push(Effect::Move { card_id, surface, macro_zone, owner_id });
            }
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
                } else {
                    match frame.card_at(slot) {
                        // A bound CARD → write its per-card `stock` u32: compute the
                        // new value here (current stock with this slot's bits
                        // replaced) and emit an absolute SetCardStock. The card holds
                        // it; only the bottom u4 can later save to a zone.
                        Some(card_id) => {
                            let c = store
                                .card_at(card_id, now_ms)
                                .ok_or_else(|| format!("stock op: bound card {card_id} not found"))?;
                            let name = bundle.name_for_packed(c.packed_definition).ok_or_else(|| {
                                format!("stock op: card {card_id} packed not in bundle")
                            })?;
                            let new_stock = fold_stock(bundle, name, c.stock, aspect, *delta, *abs)?;
                            ap.effects.push(Effect::SetCardStock { card_id, stock: new_stock });
                        }
                        // Unplaced → the synthetic tile (the zone-savable u4 path),
                        // addressed positionally by apply via the proposal cell.
                        None => {
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
                            ap.effects.push(Effect::ModifyTileStock {
                                slot: idx as u8,
                                op,
                                delta: mag.clamp(0, 255) as u8,
                            });
                        }
                    }
                }
            }
        }
    }

    // Assign a transient tag to every surviving synthetic that another surviving
    // synthetic nests in (lazily — an unreferenced created card carries tag 0 and
    // never enters the table). A child always appears AFTER its parent in tape
    // order (a handle can't be referenced before its `as`), so tape order is a
    // valid causal order and there are no cycles to resolve here — owner refs only
    // point backwards. (When a created card can reference another's shard-minted
    // position, that backward-only guarantee breaks and a topological sort +
    // cycle check belong at this point.)
    let mut next_tag = TAG_ID_MIN;
    for i in 0..synths.len() {
        if !synths[i].alive {
            continue;
        }
        if let Placement::Inventory(OwnerRef::Synth(m)) = synths[i].placement {
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
    // shard fills `tag -> id` for a parent before it writes a child. A nested
    // child's `owner_id` is the parent's tag (the shard rebuilds the inventory
    // `macro_zone` from the resolved owner); a real-owner child carries the real
    // id and final zone.
    for i in 0..synths.len() {
        let s = &synths[i];
        if !s.alive {
            continue;
        }
        let (surface, macro_zone, owner_id, micro_location) = match &s.placement {
            Placement::Inventory(OwnerRef::Real(id)) => {
                (INVENTORY_LAYER, pack_macro_zone_full(*id, INVENTORY_LAYER, 0, 0), *id, None)
            }
            Placement::Inventory(OwnerRef::Synth(m)) => {
                let tag = synths[*m].tag; // assigned above (nonzero — it's referenced)
                (INVENTORY_LAYER, pack_macro_zone_full(tag, INVENTORY_LAYER, 0, 0), tag, None)
            }
            Placement::At { surface, macro_zone, micro_location, owner_id } => {
                (*surface, *macro_zone, *owner_id, Some(*micro_location))
            }
        };
        ap.effects.push(Effect::Create {
            def_key: s.def_key.clone(),
            surface,
            macro_zone,
            owner_id,
            stock: s.stock,
            tag: s.tag,
            micro_location,
        });
    }

    Ok(ap)
}

/// A card created in this plan, folded so same-card modifies don't become extra
/// effects. `placement` is where it lands; `tag` (0 = none) is set when another
/// synthetic nests in this one.
struct Synthetic {
    def_key: String,
    placement: Placement,
    stock: u32,
    alive: bool,
    tag: u32,
}

/// Where a created card lands: into an owner's inventory (first free cell), or at
/// an exact world cell (the `create … .location` path — a bound card's spot).
enum Placement {
    Inventory(OwnerRef),
    At { surface: u8, macro_zone: u64, micro_location: u32, owner_id: u32 },
}

/// Whose inventory a created card nests in: a real bound card, or a sibling
/// created card (index into the synthetics, addressed `created.M` in the recipe).
enum OwnerRef {
    Real(u32),
    Synth(usize),
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
    stock: u32,
    aspect: &str,
    delta: i64,
    abs: bool,
) -> Result<u32, String> {
    let (shift, width) = stock_slot_bits(bundle, card, aspect)
        .ok_or_else(|| format!("card {card:?} declares no stock slot for aspect {aspect:?}"))?;
    let cap: u32 = if width >= 32 { u32::MAX } else { (1 << width) - 1 };
    let mask: u32 = cap << shift;
    let cur = (stock & mask) >> shift;
    let new_val = if abs {
        delta.clamp(0, cap as i64) as u32
    } else {
        (cur as i64 + delta).clamp(0, cap as i64) as u32
    };
    Ok((stock & !mask) | (new_val << shift))
}

/// All-false [`HoldKinds`] — the merge base.
const ZERO: HoldKinds = HoldKinds { slot_hold: false, position_hold: false, slot_share: false };

/// DSL [`Hold`] → [`HoldKinds`] (`slot_hold` true → exclusive; false →
/// `slot_share`; `position_hold` from the verb's pin).
fn kinds(h: &Hold) -> HoldKinds {
    match h {
        Hold::Use => HoldKinds { slot_hold: true, slot_share: false, position_hold: false },
        Hold::Claim => HoldKinds { slot_hold: true, slot_share: false, position_hold: true },
        Hold::Share => HoldKinds { slot_hold: false, slot_share: true, position_hold: true },
        Hold::Borrow => HoldKinds { slot_hold: false, slot_share: true, position_hold: false },
    }
}

fn merge(into: &mut HoldKinds, k: &HoldKinds) {
    into.slot_hold |= k.slot_hold;
    into.slot_share |= k.slot_share;
    into.position_hold |= k.position_hold;
}

/// Map the DSL style constant to the progress-style code (none=0, ltr=1, rtl=2).
fn style_code(style: &str) -> u8 {
    match style {
        "ltr" => 1,
        "rtl" => 2,
        _ => 0,
    }
}

/// `card::corpus_dim` → the bare key (`corpus_dim`).
fn def_key(def: &str) -> String {
    def.rsplit("::").next().unwrap_or(def).to_string()
}

/// Resolve a slot-path target to a concrete card_id, walking `.owner` / `.parent`
/// past the longest placed-card prefix via the store. Returns the resolved card
/// and any trailing container word (`inventory`).
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

    // Minimal corpus: a `type`/`progress` aspect, an owner `human`, a `log` with
    // an 8-bit `progress` stock (default 1), a childless `pip`, and a `make`
    // recipe that creates a log into the human's inventory, bumps its progress to
    // 4, then nests a pip inside the log.
    fn bundle() -> Bundle {
        let aspects = "<aspect>\n  ::type>\n    @define>\n      traits &section set\n  \
            ::progress>\n    @define>\n      traits &section set\n";
        let cards = "<card>\n\
            \x20 ::human>\n    :data>\n      @define>\n        requisite &aspect.type set\n\
            \x20 ::log>\n    :data>\n      @define>\n        requisite &aspect.type set\n        \
                8 &aspect.progress stock\n        1 &aspect.progress set\n\
            \x20 ::pip>\n    :data>\n      @define>\n        requisite &aspect.type set\n";
        let recipe = "<recipe>\n  ::make>\n    @input>\n      &slot.0.0 use\n    @output>\n      \
            $card::log &slot.0.0.inventory create &h as\n      4 &h.aspect.progress set\n      \
            $card::pip &h.inventory create\n";
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
        assert_eq!(
            ap.effects,
            vec![
                // log: real owner, default progress(1) overwritten by abs set(4),
                // tagged 1 because pip nests in it.
                Effect::Create {
                    def_key: "log".into(),
                    surface: INVENTORY_LAYER,
                    macro_zone: pack_macro_zone_full(root, INVENTORY_LAYER, 0, 0),
                    owner_id: root,
                    stock: 4,
                    tag: 1,
                    micro_location: None,
                },
                // pip: owner is log's tag (shard resolves), no own tag, no stock.
                Effect::Create {
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
            !ap.effects.iter().any(|e| matches!(e, Effect::SetCardStock { .. })),
            "created-card stock must fold into Create, not emit SetCardStock"
        );
    }

    #[test]
    fn destroy_of_created_handle_collapses() {
        let b = {
            let aspects = "<aspect>\n  ::type>\n    @define>\n      traits &section set\n";
            let cards = "<card>\n\
                \x20 ::human>\n    :data>\n      @define>\n        requisite &aspect.type set\n\
                \x20 ::log>\n    :data>\n      @define>\n        requisite &aspect.type set\n";
            let recipe = "<recipe>\n  ::poof>\n    @input>\n      &slot.0.0 use\n    @output>\n      \
                $card::log &slot.0.0.inventory create &h as\n      &h destroy\n";
            load(&[
                ("a.rd".into(), aspects.into()),
                ("c.rd".into(), cards.into()),
                ("r.rd".into(), recipe.into()),
            ])
            .expect("load")
        };
        let root = 5000u32;
        let ap = run(&b, &root_store(&b, root), "poof", root, &[], None, 0).expect("run");
        // create-then-destroy of the same handle leaves nothing on the wire.
        assert!(ap.effects.is_empty(), "expected no effects, got {:?}", ap.effects);
    }
}
