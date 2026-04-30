# AGENTS — Zones + Linking Rules

## Core Rule

    card.link_id -> target.card_id

`link_id` is a generic reference:
- stack child (visual)
- dungeon entrance/exit
- other semantic links

## linked_flag

`linked_flag` lives in the packed `position` field of the **parent** card (bit 7).

It means:

    render link_id as a visual stack child

If false:
- link exists
- link is semantic only
- linked card is NOT rendered as a stack child

## Position / Zone Rules

Packed fields (from `Data.ts`):

    zone_q  zone_r  z         ← unpacked from zone (ZoneId)
    local_q local_r           ← unpacked from position (PackedPosition)
    world_flag linked_flag    ← flags in position byte

### World Cards

    world_flag == 1

- drawn by world panels
- `zone_q` / `zone_r` are world zone coordinates
- `local_q` / `local_r` are local tile coordinates within the zone

### Inventory / UI Cards

    world_flag == 0 && (zone_q != -1 || zone_r != -1)

- drawn by inventory / UI panels
- `zone_q` / `zone_r` act as x/y float positions (center-origin, pixel space)
- `local_q` / `local_r` available for extra placement precision if needed

### Hidden / Stack-Only Cards

    world_flag == 0 && zone_q == -1 && zone_r == -1

- never drawn directly by inventory or world panels
- rendered only through a displayed parent card when:

    parent.linked_flag == true && parent.link_id != 0

Hidden sentinel (from `Inventory._findRoots`):

    zone_q = -1, zone_r = -1, local_q = 0, local_r = 0

## Root Query

Root-drawn cards are:

    (world_flag == 1)
    OR
    (world_flag == 0 && (zone_q != -1 || zone_r != -1))

These cards may render one linked child chain if `linked_flag == true`.

## Panel Queries

Inventory (`Inventory._findRoots`):

    soul_id == viewed_id
    && z == inventory_z (default 1)
    && !dragging && !returning && !world_flag
    && !(zone_q == -1 && zone_r == -1 && local_q == 0 && local_r == 0)
    && card_type in configured set
    && not a link_id target of another qualifying card (chain shown once at root)

World:

    world_flag == 1

Hidden / stack-only:

    world_flag == 0 && zone_q == -1 && zone_r == -1

## Rendering

Correct (`CardStack._resolveChain`):

    resolveChain(rootId):
      chain = []
      current = rootId
      while current != 0:
        card = client_cards[current]
        if card.dragging || card.returning: break   // unless ignoreDragState
        chain.push(current)
        if !card.linked_flag || card.link_id == 0: break
        current = card.link_id
      return chain

Do not draw hidden cards directly from panel/root queries.

## Card Flags

Packed in `ServerCard.flags` (separate from position byte):

    CARD_FLAG_POSITION_LOCKED = 1 << 0   // card cannot be moved by player
    CARD_FLAG_POSITION_HOLD   = 1 << 1   // position temporarily held (mid-server-action)

Use `parseCardFlags(card.flags)` → `{ position_locked, position_hold }`.

## UI Drag State

Client-only fields on `ClientCard` (not server-authoritative):

    dragging:  true while card is being dragged by the player
    returning: true while card is tweening back to its origin after an invalid drop

`Inventory` excludes cards where `dragging || returning`.
`CardStack._resolveChain` stops at cards where `dragging || returning` (unless `ignoreDragState` is set — used by `DragManager`'s own stacks).

## DO

- Use `zone_q` / `zone_r` for world zone placement when `world_flag == 1`
- Use `zone_q` / `zone_r` as inventory/UI x/y when `world_flag == 0`
- Use `link_id` for relationships
- Use `linked_flag` to decide whether a link is rendered as a stack child
- Use the hidden sentinel for cards that should not root-draw
- Mutate client-only flags (`dragging`, `returning`) and call `invalidateLayout()` — the layout tree propagation handles all sync automatically

## DO NOT

- Do not recurse `link_id` without checking `linked_flag`
- Do not draw hidden cards directly
- Do not treat all links as stacks
- Do not assume `zone_q == -1 && zone_r == -1` means invalid data; it is an intentional hidden/stack-only signature when `world_flag == 0`
- Do not wire manual sync callbacks between layout components — dirty flag propagation through the layout tree is the sync mechanism

## Invariants

- `link_id` is semantic unless the parent has `linked_flag == true`
- `world_flag == 1` cards are world-drawn
- `world_flag == 0` cards with non-hidden coordinates are inventory/UI-drawn
- `world_flag == 0 && zone_q == -1 && zone_r == -1` cards are hidden from root drawing
- hidden stack children only render through a parent with `linked_flag == true`

## Summary

    zone      = placement (zone_q/zone_r/z)
    link_id   = generic reference
    linked_flag = visual stack gate (bit 7 of position)
    world_flag  = world vs inventory/UI draw mode (bit 6 of position)
