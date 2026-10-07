# Kanban Git refresh measurement (card #212)

2026-10-07, local macOS worktree. Synthetic board of 1/8/32 cards sharing a test repository (worst case redundant reads); `git init`, branch discovery + `status --porcelain=v1 --untracked-files=all` per card. Large case adds 5,000 untracked empty files. Python `ThreadPoolExecutor` around the same Git commands; wall-clock milliseconds, single run; not an in-app benchmark. GitHub and health checks excluded. No private paths or file contents logged.

| Repo | Cards | Before: processes / cycle ms / card p50 / max | After (4-card limit): processes / cycle ms / card p50 / max |
| --- | ---: | --- | --- |
| small | 1 | 2 / 31 / 20 / 20 | 2 / 25 / 22 / 22 |
| small | 8 | 16 / 39 / 30 / 34 | 16 / 54 / 25 / 27 |
| small | 32 | 64 / 129 / 55 / 72 | 64 / 198 / 25 / 28 |
| 5k untracked | 1 | 2 / 24 / 23 / 23 | 2 / 24 / 24 / 24 |
| 5k untracked | 8 | 16 / 42 / 35 / 36 | 16 / 61 / 28 / 30 |
| 5k untracked | 32 | 64 / 141 / 67 / 84 | 64 / 328 / 33 / 82 |

Before choosing a change: acceptance target was **no false clean status, explicit refresh unaffected, <=4 simultaneous per-card Git reads, <=500 ms cycle for a 32-card/5k-untracked board**, with no silent cache staleness. The measured subprocess count was not significant enough to justify caching: total process count is unchanged, though the concurrency cap trades cycle latency for lower simultaneous load. Results vary with OS cache and hardware; validate against real boards before considering TTL caching. GitHub PR batching is independent.

Opt-in in-app diagnostic: set `localStorage.setItem('stacks.debugKanbanGit', '1')` and inspect `[kanban-git-cycle]` in developer console. Reports counts, elapsed cycle/card latency, >200 ms cards, failures, visibility and explicit refresh, never paths or file contents. `estimatedProcesses` assumes two Git invocations per successful branch/status read (detached HEAD may use three); it is an estimate, not an OS-level process counter. Disable by removing the key.
