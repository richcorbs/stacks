//! Run with:
//!   cargo test --release --test bench_120hz -- --ignored --nocapture
//!
//! Measures emulator + render-state materialization cost per dirty frame on
//! this machine. It does not include GPU glyph rasterization / Metal present.

use stacks_terminal::terminal_model::TerminalModel;
use std::time::Instant;

#[test]
#[ignore = "manual 120 Hz budget measurement"]
fn dirty_frame_budget_120hz() {
    let mut model = TerminalModel::new(120, 40, 10_000_000).unwrap();
    // Populate scrollback with colourful, wide and narrow content.
    for i in 0..50_000 {
        let line = format!(
            "\x1b[38;2;{};{};{}m{i:05} 世界🙂 e\u{301} \x1b[0m abcdefghijklmnopqrstuvwxyz\r\n",
            (i * 7) % 255,
            (i * 13) % 255,
            (i * 29) % 255
        );
        model.feed(line.as_bytes());
        let _ = model.frame().unwrap();
    }

    let mut samples = Vec::with_capacity(1200);
    for i in 0..1200 {
        let line = format!(
            "\x1b[38;2;100;180;240mframe {i:04} 世界🙂\x1b[0m abcdefghijklmnopqrstuvwxyz\r\n"
        );
        let start = Instant::now();
        model.feed(line.as_bytes());
        let frame = model.frame().unwrap();
        assert_eq!(frame.rows, 40);
        samples.push(start.elapsed());
    }
    samples.sort();
    let total: std::time::Duration = samples.iter().sum();
    let mean = total / samples.len() as u32;
    let p50 = samples[samples.len() / 2];
    let p95 = samples[samples.len() * 95 / 100];
    let p99 = samples[samples.len() * 99 / 100];
    let max = samples.last().copied().unwrap();
    let budget = std::time::Duration::from_secs_f64(1.0 / 120.0);
    println!(
        "frames={} mean={:?} p50={:?} p95={:?} p99={:?} max={:?} 120Hz-budget={:?}",
        samples.len(),
        mean,
        p50,
        p95,
        p99,
        max,
        budget
    );
    assert!(
        p95 < budget,
        "p95 {:?} exceeds the 8.33 ms 120 Hz CPU budget",
        p95
    );
}
