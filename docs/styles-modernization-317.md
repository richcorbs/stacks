# Card 317 — stylesheet modernization

- Worktree: `/Users/rich/Code/stacks-card-317`
- Branch: `stacks/card-317-modernize-styles-css-layered-cascade-real-type-s`
- Measured baseline: `ec76ec67cb9405adfcb0bfcafc6c26f4d1e03809`

## Measurements

Authored `src/styles.css` only; vendor imports are excluded. Reproduce final measurements with `node scripts/styles-metrics.mjs`.

| Metric | Baseline | Final |
| --- | ---: | ---: |
| Lines | 1,576 | 1,619 |
| `!important` declarations | 35 | 25 |
| Inline UI-delta font calculations, including shorthands | 111 | 0 |
| Bare pixel `font-size` | 10 | 0 |
| Bare pixel font sizes including shorthands | 12 | 0 |
| `:not(` occurrences | 118 | 75 |
| Longest adjacent negation chain | 6 | 6 (structural metadata exclusions only) |
| Repeated individual selectors in the same layer/conditional context | 26 | 0 |
| Explicit layer order | None | `reset, tokens, vendor, components, states` |
| Existing CSS-assertion suites using shared parser | 0/17 | 17/17 |

The baseline hex measurement was also reproduced: 661 literals, 419 distinct values; no layers or type/spacing/radius scale existed. Color-count reduction was not a target.

The supplied 71 negations was not reproducible: the baseline contains 118. Its flat-regex metric reports 22 repeated selector blocks, but includes media-query occurrences and misses individual selectors shared by grouped rules. The context-aware metric counts 26 actual repeated individual selectors. Final responsive rules still legitimately repeat selectors in *different* conditions; those are not duplicates.

The six metadata exclusions distinguish git-state spans and project/status/hierarchy badges from generic header metadata. They are structural, not action variants, and retain their existing specificity/winners. The three dialog-child exclusions and focused/placeholder exclusions are also structural. Exhaustive action-class negation chains are gone.

## Decisions

- `useAppStyle` publishes the UI delta on `html` with a layout effect and cleanup. This reaches body-portaled Kanban drag previews and `AppUpdater`, which is a sibling of `.app`. Type tokens resolve at `:root`. The inherited default is still 16px at delta zero, now scaling otherwise-unsized UI too.
- Fourteen `--fs-*` sizes preserve the existing defaults (8–18, 20, 24, 25). The ten bare declarations and two bare shorthands now scale. Pi/diff size variables and their existing minimum-size floors remain independent. The markdown table's former UI-delta dependency was changed to the Pi size minus 1px (still 12px by default), keeping transcript content on its own control.
- Xterm CSS is imported into `vendor`, between tokens and components, instead of being loaded unlayered by a lazy terminal module. Browser baseline comparison caught the vendor's previously later-loaded viewport `overflow-y: scroll` winner; it is preserved explicitly. Do not remove that override without checking terminal scrolling/reflow.
- Broad idle element/header/modal/settings/footer action defaults use zero-specificity `:where()`. Interaction-state specificity is retained where required to preserve existing hover/focus winners.
- Every color mapping, including blue, declares only its single accent input. One `[data-project-color]` rule derives the complete palette. Components still emit the same project-color attributes. No speculative color consolidation was attempted.
- `data-card-action` is extended to header/dialog/settings/release actions. Destructive actions emit `danger` rather than `primary`, even when they retain a `primaryAction` class for existing keyboard/confirmation behavior. `embedded-primary` preserves the legacy neutral treatment of nested Pi/repair prompts without opting their controls into card-owner styling. Navigation and editor/terminal controls remain excluded from owner theming.
- Duplicate individual selectors were removed from shared blocks and consolidated at their last occurrence, retaining declaration order and conditional context. The earlier invalid-project warning colors were dead/shadowed; only their already-effective neutral values remain.
- All 17 pre-existing CSS-assertion suites now use `src/test/cssParser.mjs` (PostCSS, declared directly as a dev dependency). Lookup defaults to unconditional rules and accepts explicit conditional ancestry. New tests exercise layer wrappers, strings/data URLs containing braces, comments, media/supports rules, exclusion of keyframe steps, real responsive overrides, palette completeness, type tokens and duplicate selectors.

## Retained `!important` declarations (25)

Each group also has an adjacent stylesheet comment:

- Card-view display toggles (3): mounted content hosts must follow active/background tab visibility, regardless of their component display mode.
- Embedded terminal framing (9): card borders/focus/maximized/inactive framing wins over standalone terminal states below it.
- Embedded chat framing (2): removes standalone pane border/shadow in every focus state.
- Maximized split flex basis (1): must override inline manually sized flex styles.
- Xterm helper surfaces (2 authored declarations after splitting the viewport selector): retain the terminal canvas background, including vendor overrides.
- WebKit search/autofill pseudo-controls (3): suppress browser-injected controls.
- Pi file-drop feedback (1): must win over terminal/pane focus shadows.
- Global drag/resize cursor and selection guards (4): interaction mode owns descendant cursor/selection behavior.

## Validation

Each of the five incremental steps passed `npm run test`, `npm run build`, and `cargo check` in `src-tauri` before completion. The parser and layer steps initially exposed assertion updates; those were fixed before proceeding. The final expanded browser comparison exposed and fixed the xterm viewport precedence regression noted above.

Final checks:

- `npm run test`: **168 files passed; 1,404 tests passed, 2 skipped**.
- `npm run build`: passed.
- `cargo check`: passed.
- `npm run test:styles-cascade -- --compare-baseline`: passed in **Chromium and WebKit**. Compares all standard computed properties in the fixture against the baseline at default size for unowned, teal and rose surfaces in idle/hover/focus states; includes vendor xterm CSS. The blue visual change is intentionally excluded from baseline equality. The comparison pins the recorded baseline commit rather than `HEAD`, so it continues to work after committing; each interaction case resets hover and focus first.
- The same browser test exercises blue/teal/rose/unowned surfaces at UI deltas 0, +3, −2; all ten formerly fixed-size declarations and both shorthands; portaled UI; independent terminal/Pi/diff sizes; neutral chrome; danger-over-primary and danger-ghost treatment; disabled opacity; mounted tab display. These are deterministic fixture checks, not a claim that every native screen was inspected.
- Signed `npm run release:build`, `./install.sh`, and `open ~/Applications/Stacks.app`: succeeded, including a final rebuild after the viewport fix. Notarization was skipped because Apple credentials are not configured.
- `git diff --check`: passed.

### Remaining human validation

A native screen-by-screen sweep is **not completed**. macOS denied Apple Events access to System Events (`-1743`), and desktop capture showed no app content. Please check the installed dogfood app across shell/sidebar (where present), workspace tabs, board/list, card detail, settings, release, diff and Pi composer, at default and adjusted UI size. Include blue plus two other colors and an unowned surface, and verify terminal/Pi/diff sizing independently. Browser computed-style comparisons do not replace this final native visual gate.
