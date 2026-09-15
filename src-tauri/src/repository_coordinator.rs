use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, OnceLock, Weak},
};

/// Coordinates operations by the canonical Git common directory. Independent
/// clones are independent scopes; linked worktrees and checkout aliases share
/// one scope.
pub struct RepositoryCoordinator {
    registry: Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
}

impl Default for RepositoryCoordinator {
    fn default() -> Self {
        Self {
            registry: Mutex::new(HashMap::new()),
        }
    }
}

impl RepositoryCoordinator {
    pub fn coordinate<T>(
        &self,
        identity: &Path,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let operation_lock = {
            // Registry poisoning cannot represent partially completed repository
            // work, so recovering its metadata is safe.
            let mut registry = self
                .registry
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            registry.retain(|_, lock| lock.strong_count() > 0);
            match registry.get(identity).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(Mutex::new(()));
                    registry.insert(identity.to_path_buf(), Arc::downgrade(&lock));
                    lock
                }
            }
        };

        let guard = match operation_lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                drop(poisoned.into_inner());
                operation_lock.clear_poison();
                return Err(
                    "Repository coordination was interrupted; retry the operation".to_string(),
                );
            }
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation));
        drop(guard);
        match result {
            Ok(result) => result,
            Err(_) => {
                // Convert an abandoned coordinated operation into a recoverable
                // error without leaving this repository permanently poisoned.
                operation_lock.clear_poison();
                Err("Repository coordination was interrupted; retry the operation".to_string())
            }
        }
    }

    #[cfg(test)]
    fn lock_for_test(&self, identity: &Path) -> Arc<Mutex<()>> {
        let mut registry = self
            .registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let lock = Arc::new(Mutex::new(()));
        registry.insert(identity.to_path_buf(), Arc::downgrade(&lock));
        lock
    }

    #[cfg(test)]
    fn registry_len(&self) -> usize {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    #[cfg(test)]
    fn prune(&self) {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|_, lock| lock.strong_count() > 0);
    }
}

pub fn global() -> &'static RepositoryCoordinator {
    static COORDINATOR: OnceLock<RepositoryCoordinator> = OnceLock::new();
    COORDINATOR.get_or_init(RepositoryCoordinator::default)
}

pub fn repository_identity(path: impl AsRef<Path>) -> Result<PathBuf, String> {
    let checkout = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(checkout)
        .args(["rev-parse", "--git-common-dir"])
        .output()
        .map_err(|error| {
            format!(
                "Could not identify repository for {}: {error}",
                checkout.display()
            )
        })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("Could not identify repository for {}", checkout.display())
        } else {
            detail
        });
    }
    let common = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let common = if common.is_absolute() {
        common
    } else {
        checkout.join(common)
    };
    common.canonicalize().map_err(|error| {
        format!(
            "Could not identify repository for {}: {error}",
            checkout.display()
        )
    })
}

// A future operation that genuinely spans repositories must deduplicate
// canonical identities and acquire their locks in stable lexical order.

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Barrier,
        },
        thread,
        time::Duration,
    };

    #[test]
    fn same_repository_operations_never_overlap() {
        let coordinator = Arc::new(RepositoryCoordinator::default());
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let coordinator = Arc::clone(&coordinator);
            let active = Arc::clone(&active);
            let maximum = Arc::clone(&maximum);
            let start = Arc::clone(&start);
            workers.push(thread::spawn(move || {
                start.wait();
                coordinator
                    .coordinate(Path::new("repo"), || {
                        let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(count, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(40));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .unwrap();
            }));
        }
        start.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn different_repositories_can_overlap() {
        let coordinator = Arc::new(RepositoryCoordinator::default());
        let inside = Arc::new(Barrier::new(2));
        let overlapped = Arc::new(AtomicBool::new(false));
        let mut workers = Vec::new();
        for key in ["repo-a", "repo-b"] {
            let coordinator = Arc::clone(&coordinator);
            let inside = Arc::clone(&inside);
            let overlapped = Arc::clone(&overlapped);
            workers.push(thread::spawn(move || {
                coordinator
                    .coordinate(Path::new(key), || {
                        inside.wait();
                        overlapped.store(true, Ordering::SeqCst);
                        Ok(())
                    })
                    .unwrap()
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert!(overlapped.load(Ordering::SeqCst));
    }

    #[test]
    fn abandoned_entries_are_pruned() {
        let coordinator = RepositoryCoordinator::default();
        coordinator.coordinate(Path::new("old"), || Ok(())).unwrap();
        assert_eq!(coordinator.registry_len(), 1);
        coordinator.coordinate(Path::new("new"), || Ok(())).unwrap();
        assert_eq!(coordinator.registry_len(), 1);
        coordinator.prune();
        assert_eq!(coordinator.registry_len(), 0);
    }

    #[test]
    fn poison_is_recoverable_and_scoped_to_one_repository() {
        let coordinator = Arc::new(RepositoryCoordinator::default());
        let poisoned_lock = coordinator.lock_for_test(Path::new("poisoned"));
        let worker_lock = Arc::clone(&poisoned_lock);
        let _ = thread::spawn(move || {
            let _guard = worker_lock.lock().unwrap();
            panic!("test poison");
        })
        .join();
        assert!(coordinator
            .coordinate(Path::new("poisoned"), || Ok(()))
            .is_err());
        assert!(coordinator
            .coordinate(Path::new("poisoned"), || Ok(()))
            .is_ok());
        assert!(coordinator
            .coordinate(Path::new("other"), || Ok(()))
            .is_ok());
    }

    #[test]
    fn worktrees_and_symlink_aliases_share_an_identity() {
        let root =
            std::env::temp_dir().join(format!("stacks-repository-scope-{}", uuid::Uuid::new_v4()));
        let main = root.join("main");
        let linked = root.join("linked");
        let alias = root.join("alias");
        std::fs::create_dir_all(&main).unwrap();
        Command::new("git")
            .args(["init", "-b", "main"])
            .arg(&main)
            .status()
            .unwrap();
        Command::new("git")
            .args([
                "-C",
                main.to_str().unwrap(),
                "config",
                "user.email",
                "test@example.com",
            ])
            .status()
            .unwrap();
        Command::new("git")
            .args(["-C", main.to_str().unwrap(), "config", "user.name", "Test"])
            .status()
            .unwrap();
        std::fs::write(main.join("file"), "initial").unwrap();
        Command::new("git")
            .args(["-C", main.to_str().unwrap(), "add", "."])
            .status()
            .unwrap();
        Command::new("git")
            .args(["-C", main.to_str().unwrap(), "commit", "-m", "initial"])
            .status()
            .unwrap();
        Command::new("git")
            .args([
                "-C",
                main.to_str().unwrap(),
                "worktree",
                "add",
                "-b",
                "linked",
                linked.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&main, &alias).unwrap();
        assert_eq!(
            repository_identity(&main).unwrap(),
            repository_identity(&linked).unwrap()
        );
        #[cfg(unix)]
        assert_eq!(
            repository_identity(&main).unwrap(),
            repository_identity(&alias).unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
