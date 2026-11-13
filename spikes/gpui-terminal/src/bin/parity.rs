use std::{env, path::PathBuf};

use anyhow::{Context as _, Result};
use stacks_gpui_terminal_spike::parity;

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    let corpus_path = PathBuf::from(
        args.next()
            .context("usage: parity <corpus.json> <out.json>")?,
    );
    let out_path = PathBuf::from(
        args.next()
            .context("usage: parity <corpus.json> <out.json>")?,
    );
    let corpus = parity::load(&corpus_path)?;
    let run = parity::run_corpus(&corpus)?;
    parity::write_run(&run, &out_path)?;
    println!(
        "wrote {} cases / {} snapshots to {}",
        run.cases.len(),
        run.cases.iter().map(|case| case.steps.len()).sum::<usize>(),
        out_path.display()
    );
    Ok(())
}
