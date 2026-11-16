#[tauri::command]
pub fn open_path_in_editor(path: String, editor: Option<String>) -> Result<(), String> {
    stacks_core::open::open_path_in_editor(path, editor)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    stacks_core::open::open_url(url)
}
