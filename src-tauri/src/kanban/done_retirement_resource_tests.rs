//! Real Git + SQLite tests exercise the same durable phase executor as the command.
use super::*;

struct Fixture {
    _root: tempfile::TempDir,
    db: Connection,
    candidate: DoneCleanupCandidate,
    primary: String,
    source: String,
    live: PathBuf,
    staged: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let primary = base.join("primary");
        let source = base.join("source");
        fs::create_dir(&primary).unwrap();
        let primary = primary.to_str().unwrap().to_string();
        let source = source.to_str().unwrap().to_string();
        git(&primary, &["init", "-b", "main"]).unwrap();
        git(&primary, &["config", "user.name", "Test"]).unwrap();
        git(&primary, &["config", "user.email", "test@example.invalid"]).unwrap();
        git(&primary, &["commit", "--allow-empty", "-m", "base"]).unwrap();
        git(&primary, &["worktree", "add", "-b", "card-316", &source]).unwrap();
        // Both an unmerged commit and uncommitted/untracked content are intentional.
        git(
            &source,
            &["commit", "--allow-empty", "-m", "unmerged card work"],
        )
        .unwrap();
        fs::write(Path::new(&source).join("uncommitted"), "discard authorized").unwrap();
        let mut db = Connection::open_in_memory().unwrap();
        initialize_connection(&mut db).unwrap();
        db.execute(
            "INSERT INTO projects(id,name,path,kanban_source) VALUES ('p','Project',?1,'local')",
            [&primary],
        )
        .unwrap();
        db.execute("INSERT INTO kanban_cards(id,external_provider,external_id,title,project_id,status,created_at,updated_at) VALUES ('local:316','local:p','316','Retire','p','done',1,1)", []).unwrap();
        let entered = unix_timestamp() - RETENTION_SECONDS - 100;
        db.execute(
            "UPDATE kanban_cards SET done_entered_at=?1 WHERE id='local:316'",
            [entered],
        )
        .unwrap();
        db.execute("INSERT INTO card_environments(id,card_id,project_id,worktree_path,branch,repository_id,target_checkout_path,target_branch,source_revision,created_at,updated_at) VALUES ('env','local:316','p',?1,'card-316',?2,?3,'main',?4,1,1)", params![source,repository_identity(&primary).unwrap(),primary,git_output(&source,&["rev-parse","HEAD"]).unwrap()]).unwrap();
        let candidate = DoneCleanupCandidate {
            id: "local:316".into(),
            done_entered_at: entered,
        };
        Self {
            _root: root,
            db,
            candidate,
            primary,
            source,
            live: base.join("files"),
            staged: base.join("staged"),
        }
    }
    fn authorize(&mut self) {
        authorize(&self.db, &self.candidate).unwrap();
        capture_intent(&self.db, &self.candidate).unwrap();
    }
    fn step(&mut self, runtime: impl FnOnce(&str) -> Result<(), String>) -> Result<bool, String> {
        let c = &self.candidate;
        let live = &self.live;
        let staged = &self.staged;
        execute_board_mutation(&mut self.db, |db| {
            retirement_step(db, c, runtime, |db, id| {
                stage_and_delete_at(db, id, live, staged)
            })
        })
        .map(|(done, _)| done)
    }
    fn phase(&self) -> String {
        self.db
            .query_row("SELECT phase FROM card_retirements", [], |r| r.get(0))
            .unwrap()
    }
    fn advance_runtime(&mut self) {
        assert!(!self.step(|_| Ok(())).unwrap());
        assert_eq!(self.phase(), "worktrees");
    }
    fn branch_exists(&self) -> bool {
        local_ref_tip(&self.primary, "card-316").unwrap().is_some()
    }
}

#[test]
fn bulk_authorization_retires_dirty_unmerged_resources_and_then_local_files() {
    let mut f = Fixture::new();
    fs::create_dir(&f.live).unwrap();
    fs::write(f.live.join("history"), "local history").unwrap();
    f.db.execute("INSERT INTO card_pull_requests(card_id,repository,number,title,url,state,updated_at) VALUES ('local:316','owner/repo',316,'Open PR','https://example.invalid/pr/316','open',1)",[]).unwrap();
    f.db.execute(
        "UPDATE kanban_cards SET runtime_cleanup_status='failed',delivery_error='previous failure'",
        [],
    )
    .unwrap();
    let remote = f._root.path().join("remote.git");
    let remote = remote.to_str().unwrap().to_string();
    assert!(Command::new("git")
        .args(["init", "--bare", &remote])
        .output()
        .unwrap()
        .status
        .success());
    git(&f.primary, &["remote", "add", "origin", &remote]).unwrap();
    git(&f.primary, &["push", "origin", "card-316"]).unwrap();
    let remote_tip = git_output(&remote, &["rev-parse", "refs/heads/card-316"]).unwrap();
    f.authorize();
    let mut stopped = false;
    assert!(!f
        .step(|id| {
            assert_eq!(id, "local:316");
            stopped = true;
            Ok(())
        })
        .unwrap());
    assert!(stopped);
    assert!(!f.step(|_| panic!("runtime phase must not repeat")).unwrap());
    assert!(!Path::new(&f.source).exists());
    assert!(f.branch_exists());
    assert!(!f.step(|_| panic!()).unwrap());
    assert!(!f.branch_exists());
    assert!(f.step(|_| panic!()).unwrap());
    assert!(f.staged.join("history").exists());
    assert_eq!(
        f.db.query_row("SELECT COUNT(*) FROM kanban_cards", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    finish_purge(&f.db, "local:316", &f.staged, |p| {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    })
    .unwrap();
    assert!(!f.staged.exists());
    assert!(Path::new(&f.primary).join(".git").exists());
    assert_eq!(
        git_output(&remote, &["rev-parse", "refs/heads/card-316"]).unwrap(),
        remote_tip
    );
}

#[test]
fn process_shutdown_failure_preserves_worktree_and_is_retryable() {
    let mut f = Fixture::new();
    f.authorize();
    assert!(f
        .step(|_| Err("Pi process refused shutdown".into()))
        .unwrap_err()
        .contains("Pi process"));
    assert_eq!(f.phase(), "runtime");
    assert!(Path::new(&f.source).exists());
    assert!(f.branch_exists());
    f.advance_runtime();
    assert!(!f.step(|_| panic!()).unwrap());
}

#[test]
fn crash_after_git_effect_before_phase_commit_replays_from_durable_evidence() {
    let mut f = Fixture::new();
    f.authorize();
    f.advance_runtime();
    f.db.execute_batch("CREATE TRIGGER crash_phase BEFORE UPDATE OF phase ON card_retirements BEGIN SELECT RAISE(ABORT,'simulated crash before commit'); END;").unwrap();
    assert!(f
        .step(|_| panic!())
        .unwrap_err()
        .contains("simulated crash"));
    assert_eq!(f.phase(), "worktrees");
    assert!(!Path::new(&f.source).exists());
    f.db.execute_batch("DROP TRIGGER crash_phase").unwrap();
    // No ordinary environment preflight requiring the removed source directory.
    assert!(!f.step(|_| panic!()).unwrap());
    assert_eq!(f.phase(), "branches");
    f.db.execute_batch("CREATE TRIGGER crash_phase BEFORE UPDATE OF phase ON card_retirements BEGIN SELECT RAISE(ABORT,'simulated crash'); END;").unwrap();
    assert!(f.step(|_| panic!()).is_err());
    assert!(!f.branch_exists());
    f.db.execute_batch("DROP TRIGGER crash_phase").unwrap();
    assert!(!f.step(|_| panic!()).unwrap());
    assert!(f.step(|_| panic!()).unwrap());
}

#[test]
fn genuine_git_failure_keeps_journal_and_can_retry() {
    let mut f = Fixture::new();
    f.authorize();
    f.advance_runtime();
    git(&f.primary, &["worktree", "lock", &f.source]).unwrap();
    assert!(f.step(|_| panic!()).unwrap_err().contains("Git"));
    assert!(Path::new(&f.source).exists());
    assert_eq!(f.phase(), "worktrees");
    git(&f.primary, &["worktree", "unlock", &f.source]).unwrap();
    assert!(!f.step(|_| panic!()).unwrap());
}

#[test]
fn reactivation_between_phases_prevents_further_destruction_even_after_reentry() {
    for reenter in [false, true] {
        let mut f = Fixture::new();
        f.authorize();
        f.advance_runtime();
        f.db.execute("UPDATE kanban_cards SET status='ready'", [])
            .unwrap();
        if reenter {
            f.db.execute("UPDATE kanban_cards SET status='done'", [])
                .unwrap();
        }
        assert!(f
            .step(|_| panic!())
            .unwrap_err()
            .contains("timestamp changed"));
        assert!(Path::new(&f.source).exists());
        assert!(f.branch_exists());
    }
}

#[test]
fn changed_tip_or_ownership_ledger_is_not_discard_authorization() {
    let mut f = Fixture::new();
    f.authorize();
    f.advance_runtime();
    git(
        &f.source,
        &["commit", "--allow-empty", "-m", "after confirmation"],
    )
    .unwrap();
    assert!(f.step(|_| panic!()).unwrap_err().contains("changed"));
    assert!(Path::new(&f.source).exists());
    let mut f = Fixture::new();
    f.authorize();
    f.advance_runtime();
    f.db.execute("UPDATE card_environments SET revision=revision+1", [])
        .unwrap();
    assert!(f
        .step(|_| panic!())
        .unwrap_err()
        .contains("ledgers changed"));
    assert!(Path::new(&f.source).exists());
}

#[test]
fn ownership_checks_reject_primary_unrelated_unregistered_and_shared_resources() {
    let f = Fixture::new();
    let r = capture_resources(&f.db, &f.candidate.id).unwrap().remove(0);
    let mut bad = r.clone();
    bad.path = f.primary.clone();
    bad.branch = "main".into();
    assert!(validate_resource(&f.db, &f.candidate.id, &bad, false).is_err());
    let foreign = f._root.path().join("foreign");
    fs::create_dir(&foreign).unwrap();
    git(foreign.to_str().unwrap(), &["init", "-b", "card-316"]).unwrap();
    bad = r.clone();
    bad.path = foreign.to_str().unwrap().into();
    assert!(validate_resource(&f.db, &f.candidate.id, &bad, false).is_err());
    // A same-repository clone is not a registered worktree either.
    let copied = f._root.path().join("unregistered");
    let output = Command::new("git")
        .args(["clone", "--local", &f.primary, copied.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(output.status.success());
    bad = r.clone();
    bad.path = copied.to_str().unwrap().into();
    assert!(validate_resource(&f.db, &f.candidate.id, &bad, false).is_err());
    f.db.execute("INSERT INTO kanban_cards(id,external_provider,external_id,title,project_id,status,created_at,updated_at) VALUES ('other','local:p','other','Other','p','ready',1,1)",[]).unwrap();
    f.db.execute("INSERT INTO card_environments(id,card_id,project_id,worktree_path,branch,repository_id,created_at,updated_at) VALUES ('shared','other','p',?1,'card-316',?2,1,1)",params![f.source,r.repository]).unwrap();
    assert!(validate_resource(&f.db, &f.candidate.id, &r, false)
        .unwrap_err()
        .contains("shared"));
    assert!(foreign.exists());
    assert!(copied.exists());
    assert!(Path::new(&f.source).exists());
}

#[test]
fn new_confirmation_for_a_later_done_period_preserves_partial_removal_evidence() {
    let mut f = Fixture::new();
    // Environment source_revision may predate later card commits. The journal's
    // captured current tip, not that old revision, must survive a full Git purge.
    let initial = git_output(&f.primary, &["rev-parse", "HEAD"]).unwrap();
    f.db.execute("UPDATE card_environments SET source_revision=?1", [initial])
        .unwrap();
    f.authorize();
    f.advance_runtime();
    assert!(!f.step(|_| panic!()).unwrap()); // previous period removed worktree
    assert!(!f.step(|_| panic!()).unwrap()); // and its local branch
    f.db.execute("UPDATE kanban_cards SET status='ready'", [])
        .unwrap();
    f.db.execute("UPDATE kanban_cards SET status='done'", [])
        .unwrap();
    assert!(authorize(&f.db, &f.candidate).is_err()); // old preview cannot reauthorize
    let entered = unix_timestamp() - RETENTION_SECONDS - 10;
    f.db.execute("UPDATE kanban_cards SET done_entered_at=?1", [entered])
        .unwrap();
    f.candidate.done_entered_at = entered;
    f.authorize(); // new explicit preview; prior ownership proof survives
    f.advance_runtime();
    assert!(!f.step(|_| panic!()).unwrap());
    assert!(!f.step(|_| panic!()).unwrap());
    assert!(f.step(|_| panic!()).unwrap());
}

#[test]
fn nested_checkout_after_confirmation_is_preserved() {
    let mut f = Fixture::new();
    f.authorize();
    f.advance_runtime();
    let nested = Path::new(&f.source).join("unrelated");
    fs::create_dir(&nested).unwrap();
    git(nested.to_str().unwrap(), &["init"]).unwrap();
    assert!(f
        .step(|_| panic!())
        .unwrap_err()
        .contains("Nested Git checkout"));
    assert!(nested.join(".git").exists());
}

#[test]
fn a_reappeared_worktree_prevents_deleting_its_checked_out_branch() {
    let mut f = Fixture::new();
    f.authorize();
    f.advance_runtime();
    assert!(!f.step(|_| panic!()).unwrap());
    git(&f.primary, &["worktree", "add", &f.source, "card-316"]).unwrap();
    assert!(f.step(|_| panic!()).unwrap_err().contains("reappeared"));
    assert!(f.branch_exists());
    assert!(Path::new(&f.source).exists());
}

#[test]
fn setup_artifacts_require_exact_nonshared_nonsymlinked_operation_ownership() {
    let f = Fixture::new();
    let root = f._root.path().canonicalize().unwrap().join("setup-results");
    fs::create_dir(&root).unwrap();
    let operation = format!("environment-creation:{}", uuid::Uuid::new_v4());
    let result = root.join(format!("{operation}.cwd"));
    f.db.execute("INSERT INTO environment_creation_operations(id,card_id,project_id,repository_id,expected_workflow_revision,target_checkout_path,target_branch,observed_target_revision,setup_command,phase,result_path,pre_worktrees,pre_branches,created_at,updated_at) VALUES (?1,?2,'p',?3,1,?4,'main','tip','setup','prepared',?5,'[]','{}',1,1)",params![operation,f.candidate.id,repository_identity(&f.primary).unwrap(),f.primary,result.to_str().unwrap()]).unwrap();
    fs::write(&result, "cwd").unwrap();
    assert_eq!(
        setup_files(&f.db, &f.candidate.id, &root).unwrap(),
        vec![result.clone(), result.with_extension("pid")]
    );
    fs::remove_file(&result).unwrap();
    std::os::unix::fs::symlink(Path::new(&f.primary).join(".git/config"), &result).unwrap();
    assert!(setup_files(&f.db, &f.candidate.id, &root)
        .unwrap_err()
        .contains("unowned"));
    f.db.execute(
        "UPDATE environment_creation_operations SET result_path='/unrelated/file'",
        [],
    )
    .unwrap();
    assert!(setup_files(&f.db, &f.candidate.id, &root)
        .unwrap_err()
        .contains("exact owned location"));
}

#[test]
fn existing_cleanup_journal_supplies_evidence_after_worktree_already_removed() {
    let mut f = Fixture::new();
    let r = capture_resources(&f.db, &f.candidate.id).unwrap().remove(0);
    // Use the normal cleanup initializer's schema, retaining its proven ownership
    // even if a previous operation already removed the environment metadata.
    f.db.execute("INSERT INTO card_cleanup_operations(card_id,environment_id,workflow_revision,environment_revision,status,phase,completion_outcome,repository_id,source_path,target_path,source_branch,target_branch,source_revision,target_revision,delete_local_branch,delete_remote_branch,pane_ids,override_authorized,registration_validated,started_at,updated_at) VALUES (?1,'env',1,1,'failed','delete_local_branch','closed',?2,?3,?4,?5,'main',?6,?6,1,0,'[]',1,1,1,1)",params![f.candidate.id,r.repository,r.path,r.target,r.branch,r.tip]).unwrap();
    git(
        &f.primary,
        &["worktree", "remove", "--force", "--", &f.source],
    )
    .unwrap();
    let initial = git_output(&f.primary, &["rev-parse", "HEAD"]).unwrap();
    f.db.execute("UPDATE card_environments SET source_revision=?1", [initial])
        .unwrap();
    assert_eq!(capture_resources(&f.db, &f.candidate.id).unwrap(), vec![r]);
    f.authorize();
    f.advance_runtime();
    assert!(!f.step(|_| panic!()).unwrap());
    assert!(!f.step(|_| panic!()).unwrap());
    assert!(!f.branch_exists());
    assert!(f.step(|_| panic!()).unwrap());
}
