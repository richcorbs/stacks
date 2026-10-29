# SQLite slow-query diagnostics (development only)

Start a debug build with the exact opt-in value:

```sh
STACKS_SQLITE_DIAGNOSTICS=1 npm run tauri dev
```

Unset the variable (or use any value other than `1`) to disable it. Restart the
app after changing it. Release/dogfood builds ignore this variable entirely.
There is no persisted setting or automatic activation.

On newly opened workflow database read/write connections, rusqlite `trace_v2`
PROFILE events report completed statements taking **25 ms or longer** to stderr:

```text
[stacks sqlite] slow_query query=board.cards elapsed_ms=32.000 threshold_ms=25.000
```

SQLite supplies the elapsed duration (currently millisecond resolution). This
is statement execution time, not total board hydration, connection setup, Rust
mapping time, or UI rendering time; PROFILE can include time until a cursor is
finished/reset. Diagnostic output itself may perturb performance.

The seven compact board hydration queries have static suffix tags in
`src-tauri/src/kanban/repository.rs`. Only allowlisted identifiers are emitted;
other slow statements use `query=unclassified`. These include other database
consumers sharing the workflow connections. To investigate an unclassified
query, add a static tag and allowlist entry in code, never raw SQL logging.

Diagnostics do **not** output SQL, expanded SQL, parameters, returned rows, paths,
card identifiers, titles, tokens, or SQL-derived hashes. They inspect only
unexpanded SQL to recognize the static allowlist tag, and only after crossing
the threshold. The allowlist also prevents arbitrary comment text from reaching
output. No logs are persisted by this feature.

When disabled, no SQLite trace callback is installed, no per-statement work is
added, and existing tracing is left untouched. Connection flags, busy timeout,
foreign keys, WAL, query-only readers, transactions, and mutation tracking are
unchanged. Initial schema setup is not profiled. Existing query-count tests
continue using STMT events; suffix comments preserve their SELECT recognition.
SQLite supports one trace callback per connection, so explicitly installing a
new callback replaces profiling on that connection (as it does for any other
trace consumer).

Tests cover opt-in/release gating, threshold boundaries and timing formatting,
real PROFILE events with bound and literal secrets, unknown/malicious tags,
disabled-mode preservation of STMT tracing and pragmas, all seven board tags,
and unchanged hydration results/query counts. Timing boundary tests use supplied
durations rather than unreliable wall-clock sleeps.
