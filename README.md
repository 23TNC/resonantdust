# README --- Card / Player / World Model (Updated)

## Core Schema

### Card
    card_id     u32
    definition  u16
    soul_id     u32
    link_id     u32   (target card_id, 0 = none)
    flags       u64
    zone        u32   (i12 zone_q | i12 zone_r | u8 z)
    position    u8    (u3 local_q | u3 local_r | u1 world_flag | u1 stacked_flag)

## Link Model

    card.link_id -> target.card_id

`link_id` is a generic reference:
- stack child
- dungeon entrance/exit
- other semantic links

## stacked_flag

`stacked_flag` lives on the parent card.

It means:

    render link_id as a visual stack child

If false:
- link exists
- NOT rendered as stack

## Zone Strategy

### Root Cards
    world_flag == 1
    OR
    world_flag == 0 && (zone_q != -1 || zone_r != -1)

- drawn by panels
- define placement
- may render one linked child if stacked_flag = true

### Inventory Placement

When `world_flag == 0`, `zone_q` and `zone_r` are used as inventory/UI x/y positions.

    world_flag == 0 && (zone_q != -1 || zone_r != -1)

### Stack-Only / Hidden Cards
    world_flag == 0 && zone_q == -1 && zone_r == -1

- never drawn directly by inventory or world panels
- only drawn through a displayed parent card when stacked_flag = true

A fully explicit hidden signature is:

    zone_q = -1
    zone_r = -1
    z = 0
    local_q = 7
    local_r = 7
    world_flag = 0

This can be used for cards that should not draw directly unless linked from another rendered card.

## Rendering

    draw(card):
      render(card)

      if card.stacked_flag && card.link_id != 0:
        draw(cards[card.link_id])

## Panels

Root query:

    world_flag == 1
    OR
    world_flag == 0 && (zone_q != -1 || zone_r != -1)

Inventory:

    world_flag == 0 && (zone_q != -1 || zone_r != -1)

World:

    world_flag == 1

Hidden / stack-only:

    world_flag == 0 && zone_q == -1 && zone_r == -1

## Summary

    Zone = placement for world cards, or x/y placement for inventory/UI cards when world_flag = 0
    link_id = generic reference
    stacked_flag = visual stack gate
    world_flag = selects world placement vs inventory/UI placement
    zone_q = -1 && zone_r = -1 && world_flag = 0 = stack-only / hidden from root drawing
