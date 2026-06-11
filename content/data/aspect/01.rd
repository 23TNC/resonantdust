; content/data/aspect/01.rd
; The aspect catalog — replaces cards/aspects.json. Each aspect is a flat record.
; A `satisfies` LUT (this aspect IS-A those aspects) inverts the old parent tree,
; so an aspect can satisfy several at once (pine could be wood AND conifer). A
; recipe predicate `aspect.Q` folds over a card: sum every stocked aspect A where
; A==Q or Q in satisfies(A). The gate computes the transitive closure + sum and
; writes the rolled-up `aspect.Q` into the operating-set frame; the VM just reads
; the key. Exact match is implicit — no aspect lists itself.
;
; `visibility`: default display level — 0 hidden (old traits) / 1 aspect slot
; (old aspects) / 2 function slot (old features). A card's :visuals can override
; per aspect (`<n> &visibility.<name> set`), like a color. icon/color are display;
; a record that omits them inherits from the first aspect it satisfies (so `pine`
; shows wood's 🪵). Labels/descriptions live in locales/aspects/<lang>.json.

<aspect>

  ; --- aspects: resources, materials, soul stats (primary recipe inputs) ---
  ::wood>
    @define>
      1 &visibility set
      🪵 &icon set
      #6B4423 &color set
  ::pine>
    @define>
      1 &visibility set
      1 &satisfies array
      $aspect::wood &satisfies.0 set
      $asset::pine &art set        ; render sprite — ring_objects pulls this

  ::stone>
    @define>
      1 &visibility set
      🪨 &icon set
      #808080 &color set
      $asset::stone &art set

  ::metal>
    @define>
      1 &visibility set
      ⬛ &icon set
      #A0A0A0 &color set

  ::food>
    @define>
      1 &visibility set
      🌾 &icon set
      #CCAA22 &color set
  ::berry>
    @define>
      1 &visibility set
      1 &satisfies array
      $aspect::food &satisfies.0 set
      $asset::berry &art set

  ::flora>
    @define>
      1 &visibility set
      🌿 &icon set
      #4A8B3E &color set
      $asset::flora &art set
  ::brush>
    @define>
      1 &visibility set
      1 &satisfies array
      $aspect::flora &satisfies.0 set

  ::fire>
    @define>
      1 &visibility set
      🔥 &icon set
      #CC3311 &color set
  ::fuel>
    @define>
      1 &visibility set
      1 &satisfies array
      $aspect::fire &satisfies.0 set

  ::water>
    @define>
      1 &visibility set
      💧 &icon set
      #1E6B9E &color set

  ::corpse>
    @define>
      1 &visibility set
      💀 &icon set
      #3a3a3a &color set

  ::corpus>
    @define>
      1 &visibility set
      🜔 &icon set
      #E67E7E &color set
  ::corpus_lit>
    @define>
      1 &visibility set
      1 &satisfies array
      $aspect::corpus &satisfies.0 set
  ::corpus_dim>
    @define>
      1 &visibility set
      1 &satisfies array
      $aspect::corpus &satisfies.0 set
  ::corpus_upgrade>
    @define>
      1 &visibility set
      1 &satisfies array
      $aspect::corpus &satisfies.0 set

  ::anima>
    @define>
      1 &visibility set
      🜍 &icon set
      #4040a0 &color set

  ::sollertia>
    @define>
      1 &visibility set
      🜻 &icon set
      #97e3a7 &color set

  ::aether>
    @define>
      1 &visibility set
      🜕 &icon set
      #ffb333 &color set

  ::soul>
    @define>
      1 &visibility set
      ♙ &icon set
      #4455AA &color set

  ; --- features: behavioural / functional tags (recipe-matchable too) ---
  ::crafting>
    @define>
      2 &visibility set
      🔨 &icon set
      #B07A3A &color set
  ::builder>
    @define>
      2 &visibility set
      1 &satisfies array
      $aspect::crafting &satisfies.0 set

  ::fleeting>
    @define>
      2 &visibility set
      ⌛ &icon set
      #556677 &color set

  ::level>
    @define>
      2 &visibility set
      🎚 &icon set
      #C0A060 &color set

  ::faction>
    @define>
      2 &visibility set
      🚩 &icon set
      #888888 &color set
  ::chorus>
    @define>
      2 &visibility set
      1 &satisfies array
      $aspect::faction &satisfies.0 set
  ::chord>
    @define>
      2 &visibility set
      1 &satisfies array
      $aspect::faction &satisfies.0 set
  ::resonance>
    @define>
      2 &visibility set
      1 &satisfies array
      $aspect::faction &satisfies.0 set

  ::move_speed>
    @define>
      2 &visibility set
      🏃 &icon set
      #9DCEE0 &color set

  ::inventory>
    @define>
      2 &visibility set
      🎒 &icon set
      #B07A3A &color set

  ; --- traits: descriptive sim properties, not displayed (no icon/color) ---
  ; `type` is the card's kind (tile/faculty/soul/…) — a symbol-valued classifier,
  ; not a magnitude: read by `eq` like def_id, never summed, no satisfies edges.
  ; Its presence here just lets `&aspect.type set` pass the aspect-member lint.
  ::type>
    @define>
      0 &visibility set
  ; `def_id` optionally PINS a card's per-type def id (the low 12 bits of its
  ; packed_definition) instead of letting the loader auto-increment — e.g. the
  ; player_soul sets it to 4095 (0xFFF) so its packed def is 0xFFFF. Loader-read
  ; only (like `type`); never summed. Declared here to pass the aspect-member lint.
  ::def_id>
    @define>
      0 &visibility set
  ; `progress` is a per-card stock counter (build/charge progress, 0..N). Backed
  ; by a card's `stock` u32 (declared `<bits> &aspect.progress stock`), read +
  ; written by recipes (`*root.aspect.progress`, `&root.aspect.progress inc`). A
  ; magnitude, but sim-only — not displayed.
  ::progress>
    @define>
      0 &visibility set
  ; Stacking bit-fields (bit i = stack i: 0 loose, 1 hex/under, 2 top, 3 bottom).
  ; stack_hosts = stacks this card sources as root; stack_joins = stacks it can
  ; occupy. Absent => client default (regular card: hosts 0b1110, joins 0b1100).
  ::stack_hosts>
    @define>
      0 &visibility set
  ::stack_joins>
    @define>
      0 &visibility set
  ::cost>
    @define>
      0 &visibility set
  ::height>
    @define>
      0 &visibility set
  ::elevation_min>
    @define>
      0 &visibility set
  ::elevation_max>
    @define>
      0 &visibility set
  ::temperature_min>
    @define>
      0 &visibility set
  ::temperature_max>
    @define>
      0 &visibility set
  ::humidity_min>
    @define>
      0 &visibility set
  ::humidity_max>
    @define>
      0 &visibility set
  ::aether_min>
    @define>
      0 &visibility set
  ::aether_max>
    @define>
      0 &visibility set
  ::rarity>
    @define>
      0 &visibility set
  ::coverage>
    @define>
      0 &visibility set
  ::cluster_group>
    @define>
      0 &visibility set
  ::cluster_strength>
    @define>
      0 &visibility set
  ; Anchor reach: per-tier tile radii a card projects to drive the client's zone
  ; subscription/memory tiers (active > hot > warm > cold). A card with these
  ; (typically a soul) makes the zones within each radius active/hot/warm/cold;
  ; cards subscribe within anchor_hot, zones within anchor_cold. Client-only —
  ; the shard/gate never read these. Distances are in tiles.
  ::anchor_active>
    @define>
      0 &visibility set
  ::anchor_hot>
    @define>
      0 &visibility set
  ::anchor_warm>
    @define>
      0 &visibility set
  ::anchor_cold>
    @define>
      0 &visibility set
