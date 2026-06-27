; content/data/cards/faculties.card
; Type `faculty` (generic rect). The corpus/aether/sollertia/anima faculties
; carry a symbols-pack icon ($asset::symbols, variant = the faculty name); the
; _dim/_lit/_upgrade variants are face-only (no &pack → rect_card's sprite hides
; itself, leaving body + title).
<card>
  ::corpus>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        faculty &data.type set
        1 &data.corpus_lit set

  ::corpus_dim>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        faculty &data.type set
        1 &data.corpus_dim set

  ::corpus_upgrade>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        faculty &data.type set
        1 &data.corpus_upgrade set

  ::aether>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        faculty &data.type set

  ::aether_dim>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        faculty &data.type set

  ::aether_lit>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        faculty &data.type set

  ::sollertia>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        faculty &data.type set

  ::sollertia_dim>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        faculty &data.type set

  ::sollertia_lit>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        faculty &data.type set

  ::anima>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        faculty &data.type set

  ::anima_dim>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        faculty &data.type set

  ::anima_lit>
    :data>
      @define>
        &data $data_func::aspect_flags call drop
        faculty &data.type set
