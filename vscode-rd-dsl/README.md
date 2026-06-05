# Resonant Dust DSL — VS Code syntax highlighting

Highlights the Resonant Dust stack DSL in `.rd` files (cards, recipes, assets,
biomes — all one language).
Token grammar is defined from [`SYNTAX.txt`](../pixijs/src/content/data/SYNTAX.txt);
the path model is documented in [`CONVENTIONS.txt`](../pixijs/src/content/data/CONVENTIONS.txt).

## What gets highlighted

### References — colored per leading delimiter

A reference is a chain of segments. Each segment is `<delimiter><name>`, and the
whole segment (delimiter + name) takes the color of its **leading delimiter**.
A segment ends at the next delimiter or at whitespace. The delimiters are
`$  ::  :  &  .  *` (`::` is matched before `:`).

So `$object::symbols:corpus` colors as `$object` + `::symbols` + `:corpus`, and
`&slot.0.0` as `&slot` + `.0` + `.0`.

| Delimiter | Meaning | Example segment | Scope |
| --- | --- | --- | --- |
| `$` | dereference a `<…>` compile symbol — **same color as `<card>`** | `$object` | `keyword.control.directive` |
| `::` | engine symbol | `::symbols` | `entity.name.section.engine` |
| `:` | label | `:corpus`, `:loop` | `entity.name.function.label` |
| `&` | slot address | `&card`, `&slot` | `entity.name.tag.slot` |
| `*` | slot value | `*var`, `*slot` | `support.type.value` |
| `^` | system call — engine-native function (`^biome`, `^seed`) | `^biome` | `support.function.engine-call` |
| `.` | field / aspect | `.height`, `.wood`, `.0` | `entity.other.attribute-name.aspect` |

**Slot coordinates.** The `.<stack>.<offset>` right after `slot` is an exception:
it's colored by **stack id** (the offset shares the stack's color). `slot.1.0` →
`&slot` + `.1.0` (top-stack color). Elsewhere a `.0` is just a field.

| Stack | Coordinate | Scope |
| --- | --- | --- |
| `0` hex | `slot`**`.0.0`** | `constant.numeric.stack.hex` |
| `1` top | `slot`**`.1.0`** | `constant.numeric.stack.top` |
| `2` bottom | `slot`**`.2.13`** | `constant.numeric.stack.bottom` |

### Everything else

| Construct | Example | Scope |
| --- | --- | --- |
| Compile-time symbols (`<…>`) | `<card>` | `keyword.control.directive` |
| Lifecycle hooks (`@`) | `@define>`, `@data:define>`, `@card.tile>` | `keyword.control.lifecycle` |
| Engine symbols (`::`) | `::corpus>` | `entity.name.section.engine` |
| Block headers | `recipe>`, `card.soul>`, `human>` | `entity.name.section` |
| Label definitions & references | `:loop>`, `:loop goto` | `entity.name.function.label` |
| Hex colors | `#a8e0e6` | `constant.other.color` |
| Control flow | `if`, `!if`, `goto`, `call`, `ret`, `drop` | `keyword.control.flow` |
| Conditions | `eq ne gt ge lt le and or not within` | `keyword.operator.comparison` |
| Arithmetic & math | `add sub mul div mod inc dec sin cos` | `keyword.operator.arithmetic` |
| Actions | `set array stock range count key recall destroy create borrow use claim share normalize scatter random vec2 vec3 …` (`vec`+digits) | `keyword.other.action` |
| Language constants | `rtl`, `ltr`, `pi` | `constant.language` |
| Numbers (operands) | `10`, `-1`, `1.5`, `-0.25` (ints & floats) | `constant.numeric` |
| Comments | `; ...` | `comment.line.semicolon` |

Sigil meanings: `<…>` are **compile-time symbols**; `@` is the **lifecycle-hook**
sigil (the engine enters here — `@define`, `@card.tile`); `::` are **engine
symbols** the engine stores and sorts (`::corpus>`); a single `:` block is a
**label** other cards/recipes jump to, which the engine does *not* enter. The
same sigils color reference segments inline (see above) — notably `$` shares the
`<…>` color because it dereferences a compile symbol. `normalize` lives with the
**actions** (it writes a slot).

## Recommended colors (optional)

Colors ultimately come from your theme (a grammar only assigns scopes). To pin
the rd-dsl scopes to specific colors regardless of theme — including making hex
literals stand out from keywords — drop this into your `settings.json` under
`editor.tokenColorCustomizations.textMateRules`:

```jsonc
{ "scope": "keyword.control.directive.rd-dsl",          "settings": { "foreground": "#D7BA7D", "fontStyle": "bold" } }, // <…> and $ (compile symbol / deref)
{ "scope": "entity.name.section.engine.rd-dsl",         "settings": { "foreground": "#4EC9B0", "fontStyle": "bold" } }, // :: engine symbols
{ "scope": "entity.name.function.label.rd-dsl",         "settings": { "foreground": "#DCDCAA" } }, // : labels
{ "scope": "entity.name.tag.slot.rd-dsl",               "settings": { "foreground": "#569CD6" } }, // & slot address
{ "scope": "support.type.value.rd-dsl",                 "settings": { "foreground": "#4EC9B0" } }, // * slot value
{ "scope": "entity.other.attribute-name.aspect.rd-dsl", "settings": { "foreground": "#9CDCFE" } }, // . field / aspect
{ "scope": "support.function.engine-call.rd-dsl",       "settings": { "foreground": "#DCDCAA", "fontStyle": "bold" } }, // ^ system call
{ "scope": "constant.numeric.stack.hex.rd-dsl",         "settings": { "foreground": "#4EC9B0" } }, // slot .0.# (hex)
{ "scope": "constant.numeric.stack.top.rd-dsl",         "settings": { "foreground": "#CE9178" } }, // slot .1.# (top)
{ "scope": "constant.numeric.stack.bottom.rd-dsl",      "settings": { "foreground": "#C586C0" } }, // slot .2.# (bottom)
{ "scope": "constant.other.color.rd-dsl",               "settings": { "foreground": "#CE9178" } }, // #hex colors
{ "scope": "keyword.control.flow.rd-dsl",               "settings": { "foreground": "#4FC1FF" } }, // if/goto/call/ret/drop
{ "scope": "keyword.operator.comparison.rd-dsl",        "settings": { "foreground": "#C586C0" } }, // conditions
{ "scope": "keyword.operator.arithmetic.rd-dsl",        "settings": { "foreground": "#9CDCFE" } }, // arithmetic & math
{ "scope": "keyword.other.action.rd-dsl",               "settings": { "foreground": "#F44747" } }, // actions (red)
{ "scope": "constant.language.rd-dsl",                  "settings": { "foreground": "#569CD6" } }, // rtl/ltr/pi
{ "scope": "constant.numeric.rd-dsl",                   "settings": { "foreground": "#B5CEA8" } }  // numbers
```

## Install (local development)

Symlink (or copy) this folder into your VS Code extensions dir, then reload:

```sh
ln -s "$(pwd)/vscode-rd-dsl" ~/.vscode/extensions/rd-dsl
# or for VS Code Server / WSL remote:
ln -s "$(pwd)/vscode-rd-dsl" ~/.vscode-server/extensions/rd-dsl
```

Reload the window (`Developer: Reload Window`) and open any `.rd` file.

## Package as a .vsix (optional)

```sh
npx @vscode/vsce package
code --install-extension rd-dsl-0.1.0.vsix
```
