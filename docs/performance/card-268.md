# Card #268: async Git information reads

## Change

`git_info` is now an async Tauri command. Its entire branch / optional detached-HEAD / status sequence runs in one `tauri::async_runtime::spawn_blocking` job, matching the other Git commands in this module. No subprocess I/O runs in the synchronous IPC handler or on an async executor thread. The invoke arguments and serialized results are unchanged.

The board still uses `runGitBatch` with four workers, serializes refresh cycles, and rejects obsolete identities. No new polling, caching, retries, or additional Git commands were added. Moving off the synchronous handler can allow four actual Git reads to overlap where the handler previously serialized them; it does not reduce total subprocess count. This is a per-board batch limit, not a global limit across other callers such as direct-project work and diff/summary reads. Hung Git processes can still occupy blocking workers; this change intentionally does not add process timeouts or cancellation.

Status stderr remains redacted. Branch/detached-HEAD spawn errors and blocking-task failures now also return generic errors rather than potentially exposing executable paths or task details. Nonzero branch/revision exit still returns `null`; nonzero status exit still returns an explicit error status, never clean counts.

## Reproducible synthetic measurement

Local macOS run, eight distinct disposable Git worktrees per case. Each read executes the same two Git commands as a branch-attached `git_info`. The large case has 5,000 untracked files **per worktree**. The slow case injects 100 ms before each command to model slow filesystem/process I/O. Preparation is excluded. Single samples, not statistical performance claims; concurrent frontend validation was running, so scheduler noise is included.

```sh
python3 scripts/benchmark-git-info.py
python3 scripts/benchmark-git-info.py --untracked 5000
python3 scripts/benchmark-git-info.py --delay-ms 100
```

| Case | Mode | Cycle ms | Command p50 / max ms | Card p50 ms | Dispatcher heartbeat max ms | Processes | Peak command slots |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | Synchronous | 172.5 | 10.3 / 13.6 | 21.6 | 25.5 | 16 | 1 |
| Small | Blocking workers | 132.1 | 26.3 / 46.4 | 54.4 | 19.5 | 16 | 4 |
| 5k untracked | Synchronous | 204.6 | 12.7 / 15.5 | 25.3 | 26.9 | 16 | 1 |
| 5k untracked | Blocking workers | 89.9 | 19.4 / 25.8 | 38.0 | 13.4 | 16 | 4 |
| Injected slow | Synchronous | 2051.5 | 129.4 / 143.0 | 257.9 | 280.8 | 16 | 1 |
| Injected slow | Blocking workers | 484.8 | 118.7 / 121.5 | 237.4 | 9.5 | 16 | 4 |

This Python harness models serialized dispatch versus four blocking workers; it does **not** run the Tauri command or measure native click-to-paint latency. The heartbeat runs between synchronous reads or every ~5 ms while workers run. Native IPC queueing may cause longer stalls than this conservative model. Peak slots count occupied read/command slots (including injected delay), not OS-sampled simultaneous Git processes. Each slot runs at most one Git process. Total processes remain 16 in both modes (detached HEAD would add one per read).

Interpretation: slow I/O no longer has to occupy the dispatcher; concurrency can increase individual command contention on fast repositories, while staying bounded. Do not interpret the synthetic cycle speedup as a promised native UI improvement.

## Native UI measurement: pending interactive validation

No controlled before/after native click-to-paint samples were collected in this coding session. The running installed app is not a controlled build of this worktree. Do not substitute the synthetic heartbeat numbers for this acceptance check.

For a controlled comparison, use the parent revision and this branch in the **same debug app profile**, with the same board, at least eight visible active worktrees, and no other agent/build load. Avoid resetting or replacing the installed app's real data. Repeat for small repos, large/untracked repos, and a deliberately slow Git filesystem/configuration.

1. Enable `localStorage.setItem('stacks.debugKanbanGit', '1')` in Web Inspector. Capture `[kanban-git-cycle]` card and cycle durations during the existing 30-second refresh (also test explicit refresh). `estimatedProcesses` is only an estimate; detached HEAD and failures change it.
2. Record Web Inspector Timelines (JavaScript/events + rendering/layout). Repeatedly click the same lightweight sidebar/card selection during refresh. Measure click event arrival through the first rendering update showing the selection; collect at least 30 samples per revision and report median/p95/max, including clicks overlapping refresh. Also compare idle clicks. Event-handler-to-animation-frame alone misses time spent waiting for the event to be dispatched and is not a reliable substitute.
3. Sample Git process counts concurrently. Expect the same total commands per cycle, with up to four board Git reads overlapping after this change (other Git features can add their own processes). Check no refresh overlap or process growth across several cycles.
4. Confirm selection updates while a read is slow, failed worktrees show an error rather than clean counts, and switching/replacing a worktree while its request is pending never displays its obsolete result. Remove the diagnostics key afterward.

## Automated coverage

- Rust: real worker reads preserve named branch, detached HEAD and missing-repository results; executable errors are redacted.
- Rust: a gated fake Git executable proves the command future returns `Pending` before Git completes, a separate async task can run while Git is blocked, and failed status stderr stays private.
- Frontend: default four-read limit under delayed reads; rejected commands remain redacted errors; late Git results after environment replacement are discarded. Existing tests preserve ordering, failure handling and PR/record/environment identity checks.

Validation: `npm run test`, `npm run build`, `cargo test git::tests:: --lib`, and `cargo check`. Whole-repository `cargo fmt --check` has unrelated existing formatting differences; only `src-tauri/src/git.rs` was formatted.
