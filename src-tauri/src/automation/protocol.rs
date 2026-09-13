use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRequest {
    pub request_id: String,
    pub action: String,
    pub name: String,
    pub startup_command: Option<String>,
    pub run_once: Option<String>,
    pub card_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationResponse {
    pub ok: bool,
    pub message: String,
    pub workspace_id: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientRequest {
    pub action: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub startup_command: Option<String>,
    #[serde(default)]
    pub run_once: Option<String>,
    #[serde(default)]
    pub card_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
}

impl AutomationResponse {
    pub(crate) fn success(message: impl Into<String>) -> Self {
        Self {
            ok: true,
            message: message.into(),
            workspace_id: None,
            exit_code: None,
        }
    }

    pub(crate) fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: message.into(),
            workspace_id: None,
            exit_code: None,
        }
    }
}
