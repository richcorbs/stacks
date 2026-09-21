fn main() {
    if let Err(error) = stacks_tauri_lib::dev_seed::run_cli() {
        eprintln!("Seed failed: {error}");
        std::process::exit(1);
    }
}
