use super::*;
use super::git_effects::*;
use super::environment::ensure_creation_target_revision;

fn git(path: &Path, args: &[&str]) -> String {
    git_output(path.to_str().unwrap(), args).unwrap()
}

fn fixture() -> (PathBuf, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("stacks-tracking-{}", uuid::Uuid::new_v4()));
    let remote = root.join("remote.git");
    let target = root.join("target");
    let writer = root.join("writer");
    fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "--bare", remote.to_str().unwrap()]);
    git(&root, &["clone", remote.to_str().unwrap(), target.to_str().unwrap()]);
    git(&target, &["config", "user.email", "test@example.com"]);
    git(&target, &["config", "user.name", "Test"]);
    git(&target, &["checkout", "-b", "release"]);
    fs::write(target.join("base"), "base").unwrap();
    git(&target, &["add", "."]);
    git(&target, &["commit", "-m", "base"]);
    git(&target, &["push", "-u", "origin", "release"]);
    git(&root, &["clone", "-b", "release", remote.to_str().unwrap(), writer.to_str().unwrap()]);
    git(&writer, &["config", "user.email", "test@example.com"]);
    git(&writer, &["config", "user.name", "Test"]);
    (root, target, writer)
}

fn advance(writer: &Path) {
    fs::write(writer.join("remote-change"), "remote").unwrap();
    git(writer, &["add", "."]);
    git(writer, &["commit", "-m", "remote change"]);
    git(writer, &["push"]);
}

#[test]
fn tracking_target_fast_forwards_before_snapshot_and_is_idempotent() {
    let (root, target, writer) = fixture();
    advance(&writer);
    let old = validate_checkout(target.to_str().unwrap(), None).unwrap();
    fast_forward_tracking_target(&old).unwrap();
    let updated = validate_checkout(target.to_str().unwrap(), None).unwrap();
    assert_ne!(old.target_revision, updated.target_revision);
    assert_eq!(updated.target_revision, git(&writer, &["rev-parse", "HEAD"]));
    fast_forward_tracking_target(&updated).unwrap();
    assert_eq!(updated.target_revision, git(&target, &["rev-parse", "HEAD"]));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn tracking_target_refuses_dirty_untracked_fetch_failure_and_divergence() {
    let (root, target, writer) = fixture();
    advance(&writer);
    let old = validate_checkout(target.to_str().unwrap(), None).unwrap();
    fs::write(target.join("untracked"), "do not discard").unwrap();
    assert!(validate_checkout(target.to_str().unwrap(), None).unwrap_err().contains("untracked"));
    assert_eq!(old.target_revision, git(&target, &["rev-parse", "HEAD"]));
    fs::remove_file(target.join("untracked")).unwrap();
    git(&target, &["remote", "set-url", "origin", root.join("missing").to_str().unwrap()]);
    assert!(fast_forward_tracking_target(&old).unwrap_err().contains("fetch"));
    git(&target, &["remote", "set-url", "origin", root.join("remote.git").to_str().unwrap()]);
    fs::write(target.join("local"), "local").unwrap();
    git(&target, &["add", "."]);
    git(&target, &["commit", "-m", "local change"]);
    let local = validate_checkout(target.to_str().unwrap(), None).unwrap();
    assert!(fast_forward_tracking_target(&local).unwrap_err().contains("diverged"));
    assert_eq!(local.target_revision, git(&target, &["rev-parse", "HEAD"]));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn setup_pulling_a_second_update_cannot_attach_against_old_snapshot() {
    let (root, target, writer) = fixture();
    let snapshot = validate_checkout(target.to_str().unwrap(), None).unwrap();
    // A custom setup such as stwork pulls after Stacks has taken its snapshot.
    advance(&writer);
    git(&target, &["pull", "--ff-only"]);
    let changed = validate_checkout(target.to_str().unwrap(), None).unwrap();
    assert!(ensure_creation_target_revision("release", &snapshot.target_revision, &changed)
        .unwrap_err().contains("advanced during setup"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn target_without_upstream_stays_local_even_with_remote() {
    let (root, target, writer) = fixture();
    git(&target, &["checkout", "-b", "local-only"]);
    advance(&writer);
    // A configured remote alone is not an upstream for this branch.
    git(&target, &["config", "branch.local-only.remote", "origin"]);
    let before = validate_checkout(target.to_str().unwrap(), None).unwrap();
    fast_forward_tracking_target(&before).unwrap();
    assert_eq!(before.target_revision, git(&target, &["rev-parse", "HEAD"]));
    fs::remove_dir_all(root).unwrap();
}
