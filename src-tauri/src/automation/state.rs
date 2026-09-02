use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
};
use tauri::State;

use super::protocol::{AutomationRequest, AutomationResponse};

struct PendingRequest {
    request: AutomationRequest,
    response_tx: mpsc::Sender<AutomationResponse>,
}

#[derive(Clone, Default)]
pub struct AutomationState {
    pending: Arc<Mutex<HashMap<String, PendingRequest>>>,
    owns_socket: Arc<AtomicBool>,
}

impl AutomationState {
    pub(crate) fn insert(
        &self,
        request: AutomationRequest,
        response_tx: mpsc::Sender<AutomationResponse>,
    ) {
        self.pending
            .lock()
            .expect("automation pending request lock poisoned")
            .insert(
                request.request_id.clone(),
                PendingRequest {
                    request,
                    response_tx,
                },
            );
    }

    pub(crate) fn remove(&self, request_id: &str) -> Option<mpsc::Sender<AutomationResponse>> {
        self.pending
            .lock()
            .expect("automation pending request lock poisoned")
            .remove(request_id)
            .map(|pending| pending.response_tx)
    }

    fn requests(&self) -> Vec<AutomationRequest> {
        self.pending
            .lock()
            .expect("automation pending request lock poisoned")
            .values()
            .map(|pending| pending.request.clone())
            .collect()
    }

    pub(crate) fn mark_socket_owned(&self) {
        self.owns_socket.store(true, Ordering::Release);
    }

    pub(crate) fn take_socket_ownership(&self) -> bool {
        self.owns_socket.swap(false, Ordering::AcqRel)
    }
}

#[tauri::command]
pub fn drain_automation_requests(state: State<'_, AutomationState>) -> Vec<AutomationRequest> {
    state.requests()
}

#[tauri::command]
pub fn complete_automation_request(
    request_id: String,
    response: AutomationResponse,
    state: State<'_, AutomationState>,
) -> bool {
    let Some(response_tx) = state.remove(&request_id) else {
        return false;
    };
    response_tx.send(response).is_ok()
}
