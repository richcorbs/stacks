use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct AppStats {
    cpu: f32,
    mem_mb: u64,
    version: String,
}

#[tauri::command]
pub fn app_stats() -> Result<AppStats, String> {
    let pid = std::process::id().to_string();
    let output = Command::new("ps")
        .args(["-o", "%cpu=", "-o", "rss=", "-p", &pid])
        .output()
        .map_err(|err| err.to_string())?;

    let text = String::from_utf8_lossy(&output.stdout);
    let mut parts = text.split_whitespace();
    let cpu = parts.next().and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
    let rss_kb = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);

    Ok(AppStats {
        cpu,
        mem_mb: (rss_kb + 1023) / 1024,
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}
