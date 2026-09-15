use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Clone, Default)]
pub struct AutomationState {
    owns_socket: Arc<AtomicBool>,
}
impl AutomationState {
    pub(crate) fn mark_socket_owned(&self) {
        self.owns_socket.store(true, Ordering::Release);
    }
    pub(crate) fn take_socket_ownership(&self) -> bool {
        self.owns_socket.swap(false, Ordering::AcqRel)
    }
}
