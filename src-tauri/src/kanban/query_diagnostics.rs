//! Development-only SQLite profiling. Never emit SQL, expanded SQL, or values.
use rusqlite::{
    trace::{TraceEvent, TraceEventCodes},
    Connection,
};
use std::time::Duration;

const SLOW_QUERY_THRESHOLD: Duration = Duration::from_millis(25);

fn enabled(debug_build: bool, value: Option<&str>) -> bool {
    debug_build && value == Some("1")
}

pub(super) fn configure(connection: &mut Connection) -> rusqlite::Result<()> {
    // Do not even read the environment in release builds. No SQLite callback is
    // registered when disabled; in particular, existing test tracing is untouched.
    let value = if cfg!(debug_assertions) {
        std::env::var("STACKS_SQLITE_DIAGNOSTICS").ok()
    } else {
        None
    };
    install(
        connection,
        enabled(cfg!(debug_assertions), value.as_deref()),
        SLOW_QUERY_THRESHOLD,
        |line| {
            eprintln!("{line}");
        },
    )
}

// Tags are suffix comments so statement-event query counters still see SELECT.
// Only literal identifiers from this allowlist can reach the output. Unknown
// statements are grouped, not hashed (hashes could fingerprint user data).
fn query_id(sql: &str) -> &'static str {
    const IDS: &[&str] = &[
        "board.cards",
        "board.environment_indicators",
        "board.creation_operations",
        "board.cleanup_operations",
        "board.pull_requests",
        "board.parents",
        "board.children",
    ];
    let tag = sql
        .trim_end()
        .strip_suffix(" */")
        .and_then(|s| s.rsplit_once("/* stacks-query:").map(|(_, tag)| tag));
    IDS.iter()
        .copied()
        .find(|id| Some(*id) == tag)
        .unwrap_or("unclassified")
}

fn format_profile(sql: &str, elapsed: Duration, threshold: Duration) -> Option<String> {
    (elapsed >= threshold).then(|| {
        format!(
            "[stacks sqlite] slow_query query={} elapsed_ms={:.3} threshold_ms={:.3}",
            query_id(sql),
            elapsed.as_secs_f64() * 1000.0,
            threshold.as_secs_f64() * 1000.0,
        )
    })
}

pub(super) fn install(
    connection: &mut Connection,
    enabled: bool,
    threshold: Duration,
    mut output: impl FnMut(String) + Send + 'static,
) -> rusqlite::Result<()> {
    if !enabled {
        return Ok(());
    }
    connection.trace_v2(
        TraceEventCodes::SQLITE_TRACE_PROFILE,
        Some(move |event: TraceEvent<'_>| {
            if let TraceEvent::Profile(statement, elapsed) = event {
                // Avoid retrieving SQL or allocating anything for fast statements.
                if elapsed >= threshold {
                    if let Some(line) = format_profile(&statement.sql(), elapsed, threshold) {
                        output(line);
                    }
                }
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn opt_in_requires_debug_build_and_exact_value() {
        for value in [None, Some(""), Some("0"), Some("true"), Some("1")] {
            assert!(!enabled(false, value));
            assert_eq!(enabled(true, value), value == Some("1"));
        }
    }

    #[test]
    fn threshold_timing_and_privacy() {
        assert!(format_profile(
            "SELECT 'secret'",
            Duration::from_millis(24),
            SLOW_QUERY_THRESHOLD
        )
        .is_none());
        let line = format_profile(
            "SELECT 'secret' /* stacks-query:board.cards */",
            Duration::from_micros(25_123),
            SLOW_QUERY_THRESHOLD,
        )
        .unwrap();
        assert_eq!(
            line,
            "[stacks sqlite] slow_query query=board.cards elapsed_ms=25.123 threshold_ms=25.000"
        );
        for sql in [
            "SELECT 'private title', '/private/path', 'token'",
            "SELECT ?1 /* stacks-query:private title */",
            "SELECT 1 /* stacks-query:board.cards private title */",
        ] {
            let line =
                format_profile(sql, Duration::from_millis(25), SLOW_QUERY_THRESHOLD).unwrap();
            assert_eq!(line, "[stacks sqlite] slow_query query=unclassified elapsed_ms=25.000 threshold_ms=25.000");
        }
    }

    #[test]
    fn real_profile_events_do_not_expose_parameters_or_literals() {
        let mut connection = Connection::open_in_memory().unwrap();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let captured = lines.clone();
        install(&mut connection, true, Duration::ZERO, move |line| {
            captured.lock().unwrap().push(line)
        })
        .unwrap();
        let result: String = connection
            .query_row(
                "SELECT ?1 || 'literal-secret' /* stacks-query:board.cards */",
                ["bound-secret"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(result, "bound-secretliteral-secret");
        let lines = lines.lock().unwrap();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("[stacks sqlite] slow_query query=board.cards elapsed_ms="));
        assert!(!lines[0].contains("secret"));
        assert!(!lines[0].contains("SELECT"));
    }

    #[test]
    fn disabled_install_preserves_statement_tracing_and_connection_settings() {
        let mut connection = Connection::open_in_memory().unwrap();
        super::super::repository::configure_connection(&connection).unwrap();
        let count = Arc::new(Mutex::new(0));
        let captured = count.clone();
        connection
            .trace_v2(
                TraceEventCodes::SQLITE_TRACE_STMT,
                Some(move |event: TraceEvent<'_>| {
                    if let TraceEvent::Stmt(_, _) = event {
                        *captured.lock().unwrap() += 1;
                    }
                }),
            )
            .unwrap();
        install(&mut connection, false, Duration::ZERO, |_| {
            panic!("disabled profiling emitted output")
        })
        .unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("PRAGMA busy_timeout", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            5000
        );
        assert_eq!(*count.lock().unwrap(), 2);
    }
}
