use std::{fs, path::PathBuf};

pub fn app_data_dir() -> Result<PathBuf, String> {
    let mut dir = dirs::data_dir().ok_or_else(|| "Could not locate user data directory".to_string())?;
    dir.push("stacks-tauri");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn app_data_file(name: &str) -> Result<PathBuf, String> {
    let mut path = app_data_dir()?;
    path.push(name);
    Ok(path)
}
