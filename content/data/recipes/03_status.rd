; content/data/recipes/03_status.rd
; Magnetic lifecycle recipes for the status cards (despair/strike/gloom in
; cards/status.rd). A magnetic card pulls an in-range card onto itself to fire
; `magnetic.recipe` (SUCCESS) within `magnetic.duration`, else `magnetic.failure`
; (the deadline path; `gloom` is the harness's short-window failure probe).
;
; PLACEHOLDER: the originals lived in the deleted recipes/01.rd /
; 03_chorus_story.rd. These are minimal new-model stubs so the corpus loads —
; success/failure both just RESOLVE the magnet (mark it dead so it's reaped). The
; real outcomes (spawn results, soul-stat effects) get written when the magnetic
; gameplay is ported to the new model.

<recipe>
  ::despair_success>
    @input>
      0 ret
    @output>
      &root.data.dead inc
  ::despair_failure>
    @input>
      0 ret
    @output>
      &root.data.dead inc

  ::strike_success>
    @input>
      0 ret
    @output>
      &root.data.dead inc
  ::strike_failure>
    @input>
      0 ret
    @output>
      &root.data.dead inc

  ::gloom_success>
    @input>
      0 ret
    @output>
      &root.data.dead inc
  ::gloom_failure>
    @input>
      0 ret
    @output>
      &root.data.dead inc
