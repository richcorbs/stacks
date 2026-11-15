//! Print the LIST read model from the real Stacks database.
//!
//! Used by the card #322 spike for data-path checks and measurements:
//! `cargo run -p stacks-cards --example list_snapshot -- [--json]`.

use std::time::Instant;

use stacks_core::{CardStore, WorkGroup, group_cards, work_group};

fn main() {
    let json = std::env::args().any(|argument| argument == "--json");
    let store = CardStore::default_store();
    let started = Instant::now();
    let snapshot = store.load_snapshot().expect("load Stacks card database");
    let load_ms = started.elapsed().as_secs_f64() * 1000.0;
    if json {
        println!("{}", serde_json::to_string_pretty(&snapshot).unwrap());
        return;
    }
    println!("database: {}", store.path().display());
    println!(
        "load: {load_ms:.1} ms, projects: {}, cards: {}",
        snapshot.projects.len(),
        snapshot.cards.len()
    );
    for group in WorkGroup::ALL {
        let entries = group_cards(&snapshot.cards, group, &snapshot.projects);
        println!("{:<18} {:>5}", group.label(), entries.len());
        for card in entries.iter().take(4) {
            let owner = card
                .project(&snapshot.projects)
                .map(|project| project.name.as_str())
                .unwrap_or("Unknown project");
            println!(
                "  #{:<6} {:<14} {:<16} {}",
                card.external_id,
                card.status.as_str(),
                owner,
                card.title
            );
        }
    }
    let attention = snapshot
        .cards
        .iter()
        .filter(|card| work_group(card, &snapshot.projects) == WorkGroup::Attention)
        .count();
    println!("grouped summary: attention={attention}");
}
