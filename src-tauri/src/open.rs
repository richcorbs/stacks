use std::process::Command;

#[tauri::command]
pub fn open_path_in_editor(path: String, editor: Option<String>) -> Result<(), String> {
    let editor = editor
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Zed");

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", editor, &path])
            .status()
            .map_err(|err| err.to_string())?
            .success()
            .then_some(())
            .ok_or_else(|| "open editor failed".to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Command::new(editor)
            .arg(&path)
            .status()
            .map_err(|err| err.to_string())?
            .success()
            .then_some(())
            .ok_or_else(|| "open editor failed".to_string())
    }
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http:// and https:// URLs can be opened".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .status()
            .map_err(|err| err.to_string())?
            .success()
            .then_some(())
            .ok_or_else(|| "open failed".to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Command::new("xdg-open")
            .arg(&url)
            .status()
            .map_err(|err| err.to_string())?
            .success()
            .then_some(())
            .ok_or_else(|| "xdg-open failed".to_string())
    }
}
