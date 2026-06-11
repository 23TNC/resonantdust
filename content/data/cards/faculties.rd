; content/data/cards/faculties.card
; Type `faculty` (generic rect). The corpus/aether/sollertia/anima faculties
; carry a symbols-pack icon ($asset::symbols, variant = the faculty name); the
; _dim/_lit/_upgrade variants are face-only (no &pack → rect_card's sprite hides
; itself, leaving body + title).
<card>
  ::corpus>
    :data>
      @define>
        faculty &aspect.type set
        1 &aspect.corpus_lit set

  ::corpus_dim>
    :data>
      @define>
        faculty &aspect.type set
        1 &aspect.corpus_dim set

  ::corpus_upgrade>
    :data>
      @define>
        faculty &aspect.type set
        1 &aspect.corpus_upgrade set

  ::aether>
    :data>
      @define>
        faculty &aspect.type set

  ::aether_dim>
    :data>
      @define>
        faculty &aspect.type set

  ::aether_lit>
    :data>
      @define>
        faculty &aspect.type set

  ::sollertia>
    :data>
      @define>
        faculty &aspect.type set

  ::sollertia_dim>
    :data>
      @define>
        faculty &aspect.type set

  ::sollertia_lit>
    :data>
      @define>
        faculty &aspect.type set

  ::anima>
    :data>
      @define>
        faculty &aspect.type set

  ::anima_dim>
    :data>
      @define>
        faculty &aspect.type set

  ::anima_lit>
    :data>
      @define>
        faculty &aspect.type set
