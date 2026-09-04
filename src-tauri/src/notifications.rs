use tauri::{AppHandle, Window};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
pub async fn notify_attention(
    app: AppHandle,
    window: Window,
    workspace_active: bool,
    force: bool,
    title: String,
    body: String,
) -> Result<bool, String> {
    let window_focused = window.is_focused().map_err(|error| error.to_string())?;
    if !force && !should_notify(window_focused, workspace_active) {
        return Ok(false);
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .show_async()
            .await
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())?;

    Ok(true)
}

fn should_notify(window_focused: bool, workspace_active: bool) -> bool {
    !window_focused || !workspace_active
}

#[cfg(test)]
mod tests {
    use super::should_notify;

    #[test]
    fn suppresses_only_the_focused_active_workspace() {
        assert!(!should_notify(true, true));
        assert!(should_notify(false, true));
        assert!(should_notify(true, false));
        assert!(should_notify(false, false));
    }
}
