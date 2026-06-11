; content/data/blueprints/01.rd
; Type <blueprint> — soul-discoverable build plans. Port of the legacy
; blueprints/data/*.json (+ blueprints/id.json). Blueprint ids are now the
; Bundle's (sorted-by-name, 1-based) — the legacy id.json space is retired.
;
;   card>   the blueprint *card* spawned into the soul's wrench panel when the
;           blueprint is requested (the visual the UI draws).
;   output> the card it builds in-world when the blueprint is used.
;
; Both reference real <card> defs; resolution validates them at load.

<blueprint>
  ::nd_furnace>
    @define>
      $card::blueprint_nd_furnace &card set
      $card::building_nd_furnace &output set
