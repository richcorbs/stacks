# Card 170 performance record

Measured with the production `npm run build` output on the card worktree. Sizes below are minified JavaScript bytes; gzip values use `gzip -c`.

## Before

| Chunk | Raw | Gzip |
| --- | ---: | ---: |
| entry (`index-CXdAQS0T.js`) | 314,256 | 88,571 |
| fallback vendor, including React and Markdown (`vendor-BV0JLmcC.js`) | 577,948 | 178,799 |
| xterm (`xterm-DfFNoYK_.js`) | 342,340 | 89,053 |
| lazy Pi view (`PiGuiView-eVbpeIuK.js`) | 29,980 | 9,600 |
| Rolldown runtime | 717 | 457 |

The generated `index.html` preloaded fallback vendor and xterm. Static graph: `index -> vendor + xterm`; the lazy Pi chunk also imported vendor. Thus a route with neither shell nor Pi loaded xterm and the Markdown parser ecosystem through vendor. Initial JS totaled **1,235,261 raw / 356,880 gzip bytes**.

A retained 300-message Pi transcript synchronously projected all 300 messages, creating and parsing every visible Markdown tree before the pane could be used.

## After

| Chunk | Raw | Gzip |
| --- | ---: | ---: |
| entry (`index-BWvag-0R.js`) | 313,391 | 88,242 |
| React/runtime (`react-DHpOp6RU.js`) | 190,942 | 59,863 |
| fallback vendor (`vendor-DwAd-ct9.js`) | 50,686 | 16,854 |
| Markdown/parser closure (`markdown-CwQkUHp9.js`) | 333,695 | 101,568 |
| xterm (`xterm-DfFNoYK_.js`) | 342,340 | 89,053 |
| xterm session factory | 1,720 | 988 |
| lazy Pi view (`PiGuiView-DuU1kmO8.js`) | 30,933 | 9,890 |
| Rolldown runtime | 717 | 457 |

Generated static/dynamic graph:

```text
index (initial) -> React + vendor + Rolldown runtime
index --dynamic--> PiGuiView -> Markdown -> React
index --dynamic--> terminalSessionFactory -> xterm + vendor + Rolldown runtime
```

Neither optional runtime nor xterm CSS is present in generated `index.html`. Initial JS is **555,736 raw / 165,416 gzip bytes**, a reduction of **679,525 raw (55.0%)** and **191,464 gzip bytes (53.7%)**. Opening Pi loads its view and the single coarse Markdown closure; creating a shell loads its small factory, xterm group, and xterm CSS.

A retained 300-message conversation now initially constructs/parses 50 settled messages instead of 300 (**83.3% fewer initial historical message trees/DOM projections**). Each activation adds at most 50. Stable source-object keys and memoized settled messages keep already-visible Markdown trees mounted and prevent streaming deltas or prepends from rendering them again. Unit coverage verifies prepend identity and controlled-height scroll anchoring.

## Profiling status

Bundle graph and deterministic render-work reductions were measured in this worktree. Interactive Tauri/WebKit timeline captures for cold launch and a representative persisted 300-message session still require a human-operated profiling run; no timing claim is recorded here without that capture.
