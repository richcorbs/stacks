# Card 302: batch live Agent presentation

## Implementation

`src/pi/sessionController.ts` now retains text deltas and the latest cumulative partial result per live tool, publishing them together on a controller-owned 16 ms timer. Text remains bounded at the existing one-million-character limit; live tools retain their existing limit.

- All accepted non-presentation events flush first, including message completion, tool start/end/results, protocol responses, extension UI requests, process exit, and settlement. Request resolution, activity events, attention, and workflow handling remain immediate.
- Text flags and content publish together instead of twice per delta. Identical scalar fields, shallow-equal arrays, unchanged context fields, and unchanged tool partials do not notify subscribers.
- Timers do not depend on React mounting, subscribers, view visibility, or animation frames. Background timer throttling can delay intermediate presentation, but cannot delay a completion flush. Fully suspended hosts cannot run any JS until resumed.
- Restart discards pending presentation and clears old live flags/tools. Deletion/disposal cancels the timer. An epoch guard rejects already-queued callbacks after cancellation; existing process generation guards still reject stale events before any flush.
- `PiGuiView.tsx`, `PiMarkdown.tsx`, Markdown sanitization, historical-message memoization, and process ownership are unchanged.

## Reproduction

Baseline: `a371248e1c7bb2912d48c6b774a4a007863e02b0`.
Host: Apple M4, macOS 15.7.7, Node 22.19.0, installed Playwright Chromium.

```sh
# Deterministic correctness tests (no wall-clock assertions)
npx vitest run src/pi/sessionController.test.ts src/pi/sessionController.replay.test.tsx

# Actual Markdown parse/sanitize/render with a deterministic host clock
PI_STREAM_BENCH=1 npx vitest run src/pi/sessionController.replay.test.tsx

# Chromium comparison: loads the baseline controller directly from Git,
# then the current controller, in the same live React/Markdown fixture.
node tests/pi-stream-replay.mjs a371248e1c7bb2912d48c6b774a4a007863e02b0
```

Both replays deliver 320 Markdown text chunks (~20 KB final text) and 320 cumulative tool partial results per agent. The deterministic replay advances 2 ms per pair (500 text events/s); Chromium requests 2 ms delays, subject to actual timer clamping/render contention. There are one- and four-agent cases. Exact final text and final tool partials are checked; deterministic tests also cover durable completed transcript content and final tool results.

The Chromium fixture uses real React external-store subscriptions and the existing `PiMarkdown` pipeline, but mocks process transport. It isolates live presentation rather than mounting the entire application. Memoized agent views exclude parent input-only renders. A controlled input is typed into throughout each run; input latency is Playwright key-to-verified-input-value round trip, including browser automation overhead, **not** a native input-to-paint measurement. Main-thread task time is CDP `TaskDuration`, a CPU-work proxy. The separate SSR replay measures actual Node process CPU time.

## Measurements

Single sequential comparison, no build/test jobs running concurrently (directional measurements, not statistical guarantees):

| Chromium metric | 1 agent baseline | 1 agent batched | 4 agents baseline | 4 agents batched |
| --- | ---: | ---: | ---: | ---: |
| Snapshot notifications | 961 | 84 | 3,844 | 324 |
| Live view renders | 321 | 84 | 1,284 | 324 |
| Main-thread task time (ms) | 3,606 | 1,370 | 13,550 | 3,977 |
| Replay wall time (ms) | 3,874 | 2,925 | 13,825 | 5,327 |
| Input round trip p50 (ms) | 17 | 3 | 58 | 23 |
| Input round trip p95 (ms) | 34 | 19 | 138 | 65 |
| Input samples | 92 | 95 | 154 | 105 |

This run reduced notifications by **91–92%**, live renders by **74–75%**, main-thread task time by **62–71%**, and input-round-trip p95 by **44–53%**. Final output checks passed in every case.

Deterministic SSR replay, including assistant completion (baseline measured before implementation; batched run after implementation):

| Metric | 1 agent baseline | 1 agent batched | 4 agents baseline | 4 agents batched |
| --- | ---: | ---: | ---: | ---: |
| Snapshot notifications | 962 | 42 | 3,848 | 168 |
| Markdown renders | 320 | 40 | 1,280 | 160 |
| Markdown render time (ms) | 6,641 | 601 | 15,525 | 1,979 |
| Node process CPU (ms) | 8,144 | 1,192 | 22,924 | 2,743 |

The deterministic replay reduces notifications by **95.6%**, Markdown parses/renders by **87.5%**, and measured process CPU by **85–88%**. SSR renders synchronously on each changed-text notification; it is a work-count/CPU benchmark, not a claim about React's browser scheduling. Timing varies with JIT, GC, and host load. Native WKWebView/dogfood profiling remains useful before extrapolating these figures to the full application.

## Validation

- Deterministic coverage: burst coalescing, no-op flags/tool snapshots, exact Unicode text, text cap, completion without timer delivery, hidden/no-subscriber delivery, text/tool/result ordering, non-text transitions, immediate protocol errors, process exit, restart/stale generations, and disposal with an already-queued callback.
- Existing lifecycle/attention/workflow tests pass; the confirmed-completion test now includes pending presentation at settlement.
- `npm run test`: 164 files passed, 1,281 tests passed, 2 opt-in benchmark cases skipped.
- `npm run build`: passed.
- `source "$HOME/.cargo/env"; cd src-tauri && cargo check`: passed.
- Both opt-in SSR benchmark cases and all Chromium replay output checks passed.
