//! Explicit, local-only retirement. Remote Git refs and provider cards are retained.
use super::health::{db_error, unix_timestamp};
use super::*;
use super::{
    cards::{card_directory, safe_card_key},
    cleanup::local_ref_tip,
    environment::*,
    git_effects::*,
    repository::*,
};

const RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;
// Lock order: resource startup -> repository coordinator -> board mutation -> runtime registries.
pub(crate) static CARD_RESOURCE_START_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoneCleanupCandidate {
    pub id: String,
    pub done_entered_at: i64,
}
#[derive(Debug, Serialize)]
pub struct DoneCleanupPreview {
    pub candidates: Vec<DoneCleanupCandidate>,
    pub pending_artifacts: usize,
}
#[derive(Debug, Serialize, Default)]
pub struct DoneCleanupResult {
    pub deleted: usize,
    pub removed_ids: Vec<String>,
    pub skipped: usize,
    pub failed: usize,
    pub details: Vec<String>,
}

pub(super) fn preview(connection: &Connection, now: i64) -> Result<DoneCleanupPreview, String> {
    let candidates = connection.prepare("SELECT id,done_entered_at FROM kanban_cards WHERE status='done' AND done_entered_at < ?1 ORDER BY id").map_err(db_error)?
        .query_map([now - RETENTION_SECONDS], |r| Ok(DoneCleanupCandidate { id:r.get(0)?, done_entered_at:r.get(1)? })).map_err(db_error)?
        .collect::<Result<Vec<_>,_>>().map_err(db_error)?;
    let pending_artifacts = connection
        .query_row("SELECT COUNT(*) FROM local_card_purge_jobs", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(db_error)? as usize;
    Ok(DoneCleanupPreview {
        candidates,
        pending_artifacts,
    })
}

fn eligible(
    connection: &Connection,
    candidate: &DoneCleanupCandidate,
    now: i64,
) -> Result<bool, String> {
    connection.query_row("SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE id=?1 AND status='done' AND done_entered_at=?2 AND done_entered_at<?3)", params![candidate.id,candidate.done_entered_at,now-RETENTION_SECONDS], |r| r.get(0)).map_err(db_error)
}

// Stable identity, not mutable presentation fields. The timestamp separately
// identifies the continuous Done period, including leave-and-reenter transitions.
fn identity(connection: &Connection, id: &str) -> Result<String, String> {
    connection.query_row("SELECT external_provider,external_id,binding_id,project_id,created_at FROM kanban_cards WHERE id=?1", [id], |r| {
        Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,i64>(4)?))
    }).map_err(db_error).and_then(|v| serde_json::to_string(&v).map_err(|e| e.to_string()))
}

fn storage_safety(connection: &Connection, id: &str) -> Result<(), String> {
    let key = safe_card_key(id);
    if key.is_empty() {
        return Err("Empty card storage identity is not owned storage".into());
    }
    let others = connection.prepare("SELECT id FROM kanban_cards WHERE id!=?1 UNION SELECT card_id FROM local_card_purge_jobs WHERE card_id!=?1").map_err(db_error)?
        .query_map([id], |r| r.get::<_,String>(0)).map_err(db_error)?.collect::<Result<Vec<_>,_>>().map_err(db_error)?;
    if others.iter().any(|other| safe_card_key(other) == key) {
        return Err("Card storage key is shared with another card".into());
    }
    Ok(())
}
fn staged_directory(id: &str) -> Result<PathBuf, String> {
    if safe_card_key(id).is_empty() {
        return Err("Empty card storage identity is not owned storage".into());
    }
    Ok(card_directory(id)?.with_file_name(format!(".done-cleanup-{}", safe_card_key(id))))
}
fn validate_directory(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
                return Err(format!(
                    "Refusing non-directory or symlinked storage: {}",
                    ancestor.display()
                ))
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("Could not inspect {}: {e}", ancestor.display())),
        }
    }
    Ok(())
}
fn validate_owned_storage(path: &Path) -> Result<(), String> {
    validate_directory(path)?;
    if !path.exists() {
        return Ok(());
    }
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() == ".git" {
                return Err(format!(
                    "Unaccounted Git checkout in card storage: {}",
                    entry.path().display()
                ));
            }
            if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(())
}
fn stage_and_delete(connection: &mut Connection, id: &str) -> Result<(), String> {
    stage_and_delete_at(connection, id, &card_directory(id)?, &staged_directory(id)?)
}
pub(super) fn stage_and_delete_at(
    connection: &mut Connection,
    id: &str,
    directory: &Path,
    staged: &Path,
) -> Result<(), String> {
    storage_safety(connection, id)?;
    validate_owned_storage(directory)?;
    validate_owned_storage(staged)?;
    if directory.exists() && staged.exists() {
        return Err(format!(
            "Both live and staged storage exist: {}",
            staged.display()
        ));
    }
    let missing_binding:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE id=?1 AND external_provider='superthread' AND binding_id IS NULL)",[id],|r|r.get(0)).map_err(db_error)?;
    if missing_binding {
        return Err(
            "Superthread binding identity is missing; cannot persist a scoped retirement tombstone"
                .into(),
        );
    }
    let tx = connection.savepoint().map_err(db_error)?;
    tx.execute(
        "INSERT INTO local_card_purge_jobs(card_id,storage_key) VALUES (?1,?2)",
        params![id, safe_card_key(id)],
    )
    .map_err(db_error)?;
    // Tombstone and local deletion are atomic. Binding scope avoids suppressing
    // unrelated accounts; this binding's remote card is never reimported.
    tx.execute("INSERT OR IGNORE INTO retired_provider_cards(binding_id,external_id,retired_at) SELECT binding_id,external_id,unixepoch() FROM kanban_cards WHERE id=?1 AND external_provider='superthread' AND binding_id IS NOT NULL",[id]).map_err(db_error)?;
    // Relationships are not retention units. Preserve every nonqualifying card.
    tx.execute(
        "UPDATE kanban_cards SET parent_id=NULL WHERE parent_id=?1",
        [id],
    )
    .map_err(db_error)?;
    tx.execute("DELETE FROM kanban_cards WHERE id=?1", [id])
        .map_err(db_error)?;
    if directory.exists() {
        fs::rename(directory, staged).map_err(|e| format!("Could not stage card files: {e}"))?;
    }
    tx.commit().map_err(db_error)
}

// Kept as a small injectable policy seam for status/relationship/failure tests.
#[cfg(test)]
pub(super) fn delete_candidates(
    connection: &mut Connection,
    candidates: &[DoneCleanupCandidate],
    now: i64,
    mut runtime_safe: impl FnMut(&str) -> Result<(), String>,
    mut remove: impl FnMut(&mut Connection, &str) -> Result<(), String>,
) -> Result<DoneCleanupResult, String> {
    let mut result = DoneCleanupResult::default();
    for c in candidates {
        if !eligible(connection, c, now)? {
            result.skipped += 1;
            continue;
        }
        let effect = (|| {
            storage_safety(connection, &c.id)?;
            runtime_safe(&c.id)?;
            let tx = connection.savepoint().map_err(db_error)?;
            tx.execute(
                "UPDATE kanban_cards SET parent_id=NULL WHERE parent_id=?1",
                [&c.id],
            )
            .map_err(db_error)?;
            tx.commit().map_err(db_error)?;
            remove(connection, &c.id)
        })();
        match effect {
            Ok(()) => {
                result.deleted += 1;
                result.removed_ids.push(c.id.clone());
            }
            Err(e) => {
                result.failed += 1;
                result.details.push(format!("{}: failed; {e}", c.id));
            }
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Resource {
    repository: String,
    target: String,
    path: String,
    branch: String,
    tip: String,
}

fn git(target: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(target)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}
fn validate_resource(
    connection: &Connection,
    id: &str,
    r: &Resource,
    allow_absent: bool,
) -> Result<(), String> {
    if ![&r.path, &r.target, &r.repository]
        .iter()
        .all(|p| Path::new(p).is_absolute())
    {
        return Err("Retirement requires absolute repository/worktree ownership paths".into());
    }
    validate_directory(Path::new(&r.path))?;
    let target = validate_target_checkout(&r.target, Some(&r.repository))?;
    let configured: Option<(String,String)> = connection
        .query_row(
            "SELECT p.path,COALESCE(p.target_branch,'main') FROM projects p JOIN kanban_cards c ON c.project_id=p.id WHERE c.id=?1",
            [id],
            |row| Ok((row.get(0)?,row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    if let Some((configured, configured_branch)) = configured {
        if configured_branch == r.branch {
            return Err("Refusing to delete the configured project target branch".into());
        }
        if Path::new(&configured)
            .canonicalize()
            .map_err(|e| e.to_string())?
            != Path::new(&r.target)
                .canonicalize()
                .map_err(|e| e.to_string())?
        {
            return Err("Project primary checkout changed; ownership must be reviewed".into());
        }
    }
    if r.branch.is_empty() || r.branch == target.target_branch {
        return Err("Refusing primary/shared target branch".into());
    }
    // Check all ownership ledgers, not just currently attached environments.
    let claims=connection.prepare("SELECT card_id,worktree_path,branch,repository_id FROM card_environments UNION ALL SELECT card_id,COALESCE(source_path,''),COALESCE(source_branch,''),repository_id FROM environment_creation_operations WHERE source_path IS NOT NULL OR source_branch IS NOT NULL UNION ALL SELECT card_id,source_path,source_branch,repository_id FROM card_target_merge_operations UNION ALL SELECT card_id,source_path,source_branch,repository_id FROM card_cleanup_operations UNION ALL SELECT card_id,json_extract(value,'$.path'),json_extract(value,'$.branch'),json_extract(value,'$.repository') FROM card_retirements,json_each(resources)").map_err(db_error)?
        .query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?))).map_err(db_error)?.collect::<Result<Vec<_>,_>>().map_err(db_error)?;
    let canonical = |p: &str| Path::new(p).canonicalize().ok();
    for (owner, path, branch, repository) in claims {
        if owner == id {
            continue;
        }
        if (!path.is_empty()
            && (path == r.path
                || match (canonical(&path), canonical(&r.path)) {
                    (Some(other), Some(owned)) => {
                        other.starts_with(&owned) || owned.starts_with(&other)
                    }
                    _ => {
                        Path::new(&path).starts_with(&r.path)
                            || Path::new(&r.path).starts_with(&path)
                    }
                }))
            || (branch == r.branch
                && repository
                    .as_deref()
                    .is_none_or(|repo| repo == r.repository))
        {
            return Err(format!(
                "Worktree/branch ownership is shared or ambiguous with {owner}"
            ));
        }
    }
    let inventory = worktree_inventory(&r.target)?;
    if inventory
        .iter()
        .any(|w| w.path != r.path && Path::new(&w.path).starts_with(&r.path))
    {
        return Err("Another registered checkout is nested inside the card worktree".into());
    }
    if inventory.iter().any(|w| {
        w.branch.as_deref() == Some(&r.branch)
            && w.path != r.path
            && (canonical(&w.path).is_none() || canonical(&w.path) != canonical(&r.path))
    }) {
        return Err("Card branch is checked out in another worktree".into());
    }
    if Path::new(&r.path).exists() {
        // Validate all ancestors; never let an override turn into arbitrary rm -rf.
        validate_worktree_contents(Path::new(&r.path))?;
        ensure_registered_distinct_worktree(&r.target, &r.path)?;
        if Path::new(&git_output(&r.path, &["rev-parse", "--absolute-git-dir"])?)
            .canonicalize()
            .map_err(|e| e.to_string())?
            == Path::new(&r.repository)
                .canonicalize()
                .map_err(|e| e.to_string())?
        {
            return Err("Refusing to remove the repository's primary checkout".into());
        }
        if repository_identity(&r.path)? != r.repository {
            return Err("Worktree repository identity changed".into());
        }
        if git_output(&r.path, &["symbolic-ref", "--quiet", "--short", "HEAD"])? != r.branch
            || git_output(&r.path, &["rev-parse", "HEAD"])? != r.tip
        {
            return Err("Worktree branch/tip changed since retirement intent".into());
        }
    } else if !allow_absent {
        return Err("Worktree absent without durable ownership evidence".into());
    }
    match local_ref_tip(&r.target, &r.branch)? {
        Some(tip) if tip == r.tip => Ok(()),
        None if allow_absent && !Path::new(&r.path).exists() => Ok(()),
        _ => Err("Card branch tip changed or disappeared without ownership proof".into()),
    }
}

fn validate_worktree_contents(root: &Path) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|e| format!("Could not inspect worktree contents: {e}"))?
        {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() == ".git" {
                if directory != root {
                    return Err(format!(
                        "Nested Git checkout ownership is ambiguous: {}",
                        directory.display()
                    ));
                }
                continue;
            }
            if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(())
}

fn setup_files(connection: &Connection, id: &str, root: &Path) -> Result<Vec<PathBuf>, String> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT id,result_path FROM environment_creation_operations WHERE card_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    let Some((operation, path)) = row else {
        return Ok(Vec::new());
    };
    let uuid = operation
        .strip_prefix("environment-creation:")
        .ok_or("Setup operation identity is invalid")?;
    uuid::Uuid::parse_str(uuid).map_err(|_| "Setup operation identity is invalid")?;
    validate_directory(root)?;
    let expected = root.join(format!("{operation}.cwd"));
    if Path::new(&path) != expected {
        return Err("Setup result file is outside its exact owned location".into());
    }
    if connection.query_row("SELECT EXISTS(SELECT 1 FROM environment_creation_operations WHERE card_id!=?1 AND result_path=?2)",params![id,path],|r|r.get::<_,bool>(0)).map_err(db_error)? {
        return Err("Setup result file is shared with another card".into());
    }
    let files = vec![expected.clone(), expected.with_extension("pid")];
    for file in &files {
        match fs::symlink_metadata(file) {
            Ok(m) if !m.is_file() || m.file_type().is_symlink() => {
                return Err(format!(
                    "Refusing unowned setup artifact: {}",
                    file.display()
                ))
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(files)
}

fn capture_resources(connection: &Connection, id: &str) -> Result<Vec<Resource>, String> {
    let mut resources: Vec<Resource> = Vec::new();
    let mut proofs = HashSet::new();
    let saved: Option<String> = connection
        .query_row(
            "SELECT resources FROM card_retirements WHERE card_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_error)?
        .flatten();
    let saved: Vec<Resource> =
        serde_json::from_str(saved.as_deref().unwrap_or("[]")).map_err(|e| e.to_string())?;
    let rows=connection.prepare("SELECT repository_id,target_checkout_path,worktree_path,branch,source_revision,0 FROM card_environments WHERE card_id=?1 UNION ALL SELECT repository_id,target_checkout_path,source_path,source_branch,source_revision,worktree_removed FROM environment_creation_operations WHERE card_id=?1 AND source_path IS NOT NULL UNION ALL SELECT repository_id,target_checkout_path,source_path,source_branch,source_revision,0 FROM card_target_merge_operations WHERE card_id=?1 UNION ALL SELECT repository_id,target_path,source_path,source_branch,source_revision,registration_validated FROM card_cleanup_operations WHERE card_id=?1 UNION ALL SELECT json_extract(value,'$.repository'),json_extract(value,'$.target'),json_extract(value,'$.path'),json_extract(value,'$.branch'),json_extract(value,'$.tip'),1 FROM card_retirements,json_each(resources) WHERE card_id=?1").map_err(db_error)?
        .query_map([id],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,bool>(5)?))).map_err(db_error)?.collect::<Result<Vec<_>,_>>().map_err(db_error)?;
    let durable: Vec<Resource> = rows
        .iter()
        .filter_map(|(repo, target, path, branch, tip, proof)| {
            if !proof {
                return None;
            }
            Some(Resource {
                repository: repo.clone()?,
                target: target.clone()?,
                path: path.clone(),
                branch: branch.clone(),
                tip: tip.clone()?,
            })
        })
        .collect();
    for (repo, target, path, branch, recorded_tip, proof) in rows {
        let target = target.ok_or("Missing primary checkout ownership evidence")?;
        let repository = repo.ok_or("Missing repository ownership evidence")?;
        let tip = if Path::new(&path).exists() {
            local_ref_tip(&target, &branch)?.or(recorded_tip)
        } else {
            // After removal, never adopt an advanced/recreated branch merely
            // because it has the same name. Prefer persisted exact-tip proof.
            saved
                .iter()
                .chain(durable.iter().rev())
                .find(|r| {
                    r.repository == repository
                        && r.target == target
                        && r.path == path
                        && r.branch == branch
                })
                .map(|r| r.tip.clone())
                .or(recorded_tip)
        }
        .ok_or("Missing branch identity evidence")?;
        let resource = Resource {
            repository,
            target,
            path,
            branch,
            tip,
        };
        if proof {
            proofs.insert(resource.path.clone());
        }
        if let Some(existing) = resources.iter().find(|r| r.path == resource.path) {
            if existing != &resource {
                return Err("Conflicting resource ownership ledgers".into());
            }
        } else {
            resources.push(resource);
        }
    }
    if let Some(op) = load_creation_operation_row(connection, id)? {
        setup_files(connection, id, &app_data_dir()?.join("setup-results"))?;
        if setup_process_alive(&op.result_path) {
            return Err("Setup process is still alive; resources retained for retry".into());
        }
        if op.source_path.is_none() {
            // A failed/crashed setup may have created resources before recording
            // its result. Inventory drift must not be silently orphaned.
            let before: Vec<WorktreeEvidence> =
                serde_json::from_str(&op.pre_worktrees).map_err(|e| e.to_string())?;
            let branches: std::collections::BTreeMap<String, String> =
                serde_json::from_str(&op.pre_branches).map_err(|e| e.to_string())?;
            if before != worktree_inventory(&op.target_checkout_path)?
                || branches != branch_inventory(&op.target_checkout_path)?
            {
                return Err("Setup changed Git inventory without recording exact ownership; recover environment creation then retry".into());
            }
        } else if !op.source_worktree_new || !op.source_branch_new {
            return Err(
                "Setup resources were pre-existing; exclusive card ownership is unproven".into(),
            );
        }
    }
    for resource in &resources {
        validate_resource(connection, id, resource, proofs.contains(&resource.path))?;
    }
    Ok(resources)
}

// Resource ledgers must not be replaced between capture and a later retry.
fn ownership_evidence(connection: &Connection, id: &str) -> Result<String, String> {
    connection.query_row("SELECT json_array(
        (SELECT json_group_array(json_array(id,revision,repository_id,target_checkout_path,worktree_path,branch)) FROM card_environments WHERE card_id=?1),
        (SELECT json_group_array(json_array(id,revision,repository_id,target_checkout_path,source_path,source_branch,result_path)) FROM environment_creation_operations WHERE card_id=?1),
        (SELECT json_group_array(json_array(id,environment_id,environment_revision,repository_id,target_checkout_path,source_path,source_branch)) FROM card_target_merge_operations WHERE card_id=?1),
        (SELECT json_group_array(json_array(environment_id,environment_revision,repository_id,target_path,source_path,source_branch)) FROM card_cleanup_operations WHERE card_id=?1)
    )",[id],|r|r.get(0)).map_err(db_error)
}

fn verify_intent(connection: &Connection, c: &DoneCleanupCandidate) -> Result<(), String> {
    if !eligible(connection, c, unix_timestamp())? {
        return Err(
            "Card reactivated or continuous Done timestamp changed; no further resources removed"
                .into(),
        );
    }
    let (entered, captured): (i64, String) = connection
        .query_row(
            "SELECT done_entered_at,identity FROM card_retirements WHERE card_id=?1",
            [&c.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_error)?;
    if entered != c.done_entered_at || captured != identity(connection, &c.id)? {
        return Err("Card identity changed since retirement intent; manual review required".into());
    }
    let evidence: Option<String> = connection
        .query_row(
            "SELECT evidence FROM card_retirements WHERE card_id=?1",
            [&c.id],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    if evidence.is_some_and(|saved| ownership_evidence(connection, &c.id).as_ref() != Ok(&saved)) {
        return Err(
            "Resource ownership ledgers changed after retirement capture; review before retry"
                .into(),
        );
    }
    let provider_identity_missing:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE id=?1 AND external_provider='superthread' AND (binding_id IS NULL OR binding_id='' OR external_id=''))",[&c.id],|r|r.get(0)).map_err(db_error)?;
    if provider_identity_missing {
        return Err(
            "Superthread binding/card identity is missing; cannot guarantee retirement suppression"
                .into(),
        );
    }
    storage_safety(connection, &c.id)
}

pub(crate) fn ensure_not_retiring(id: &str) -> Result<(), String> {
    with_read_connection(|connection| {
        let retiring=connection.query_row("SELECT EXISTS(SELECT 1 FROM card_retirements r JOIN kanban_cards c ON c.id=r.card_id WHERE r.card_id=?1 AND c.status='done' AND c.done_entered_at=r.done_entered_at)",[id],|r|r.get::<_,bool>(0)).map_err(db_error)?;
        if retiring {
            Err(
                "Card retirement is pending; finish/retry retirement before starting resources"
                    .into(),
            )
        } else {
            Ok(())
        }
    })
}

fn authorize(connection: &Connection, c: &DoneCleanupCandidate) -> Result<(), String> {
    if !eligible(connection, c, unix_timestamp())? {
        return Err("No longer eligible".into());
    }
    let captured = identity(connection, &c.id)?;
    let old: Option<(i64, String)> = connection
        .query_row(
            "SELECT done_entered_at,identity FROM card_retirements WHERE card_id=?1",
            [&c.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    match old {
        Some((_, old_identity)) if old_identity != captured => {
            return Err("Card identity changed; review retained ownership evidence".into())
        }
        Some((entered, _)) if entered != c.done_entered_at => {
            // A NEW bulk confirmation for a NEW qualifying Done period permits
            // fresh capture. Preserve old ownership proof for already removed
            // resources; never reuse the old authorization on reactivated work.
            connection.execute("UPDATE card_retirements SET done_entered_at=?2,evidence=NULL,phase='runtime',error=NULL WHERE card_id=?1",params![c.id,c.done_entered_at]).map_err(db_error)?;
        }
        Some(_) => (),
        None => {
            connection.execute("INSERT INTO card_retirements(card_id,done_entered_at,identity) VALUES (?1,?2,?3)",params![c.id,c.done_entered_at,captured]).map_err(db_error)?;
        }
    }
    verify_intent(connection, c)
}

fn retire(
    c: &DoneCleanupCandidate,
    pi: &Mutex<PiRpcRegistry>,
    pty: &Mutex<PtyRegistry>,
    setup: &crate::workspace_setup::WorkspaceSetupState,
) -> Result<(), String> {
    // This transaction commits authorization before any process or Git effect.
    with_board_mutation(|connection| authorize(connection, c))?;
    setup.cancel_and_wait(&format!("environment:{}", c.id))?;
    // Ordinary environment coordination requires an existing source directory.
    // Coordinate from durable evidence instead, including after partial removal.
    let repositories = with_read_connection(|db| {
        db.prepare("SELECT repository_id FROM card_environments WHERE card_id=?1 UNION SELECT repository_id FROM environment_creation_operations WHERE card_id=?1 UNION SELECT repository_id FROM card_target_merge_operations WHERE card_id=?1 UNION SELECT repository_id FROM card_cleanup_operations WHERE card_id=?1 UNION SELECT json_extract(value,'$.repository') FROM card_retirements,json_each(resources) WHERE card_id=?1").map_err(db_error)?
            .query_map([&c.id],|r|r.get::<_,Option<String>>(0)).map_err(db_error)?.collect::<Result<Vec<_>,_>>().map_err(db_error)
    })?;
    if repositories.iter().any(Option::is_none) || repositories.len() > 1 {
        return Err("Missing or conflicting repository ownership evidence".into());
    }
    let operation = || {
        // Capture current tips only once, before destructive effects. A crash
        // after removal therefore never loses the exact ownership evidence.
        with_board_mutation(|connection| capture_intent(connection, c))?;
        loop {
            let done = with_board_mutation(|connection| {
                retirement_step(
                    connection,
                    c,
                    |id| {
                        crate::pty::kill_ptys(pty, &crate::pty::card_pty_runtime_ids(pty, id)?)?;
                        for pane in crate::pi_rpc::card_pi_runtime_ids(pi, id)? {
                            crate::pi_rpc::stop_pi_session_impl(pi, &pane)?;
                        }
                        Ok(())
                    },
                    stage_and_delete,
                )
            })?;
            if done {
                return Ok(());
            }
        }
    };
    match repositories.first().and_then(|r| r.as_ref()) {
        Some(repository) => {
            repository_coordinator::global().coordinate(Path::new(repository), operation)
        }
        None => operation(),
    }
}

fn capture_intent(connection: &Connection, c: &DoneCleanupCandidate) -> Result<(), String> {
    verify_intent(connection, c)?;
    let captured: Option<String> = connection
        .query_row(
            "SELECT evidence FROM card_retirements WHERE card_id=?1",
            [&c.id],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    if captured.is_none() {
        let resources = capture_resources(connection, &c.id)?;
        connection
            .execute(
                "UPDATE card_retirements SET resources=?2,evidence=?3 WHERE card_id=?1",
                params![
                    c.id,
                    serde_json::to_string(&resources).map_err(|e| e.to_string())?,
                    ownership_evidence(connection, &c.id)?
                ],
            )
            .map_err(db_error)?;
    }
    Ok(())
}

fn retirement_step(
    connection: &mut Connection,
    c: &DoneCleanupCandidate,
    runtime: impl FnOnce(&str) -> Result<(), String>,
    finalize: impl FnOnce(&mut Connection, &str) -> Result<(), String>,
) -> Result<bool, String> {
    verify_intent(connection, c)?;
    let (phase, json): (String, String) = connection
        .query_row(
            "SELECT phase,resources FROM card_retirements WHERE card_id=?1",
            [&c.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_error)?;
    let resources: Vec<Resource> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    // Each phase was durably recorded by the previous commit. Hold
    // the board write lock through revalidation + effect, excluding
    // reactivation/provider reconciliation until this phase commits.
    match phase.as_str() {
        "runtime" => {
            runtime(&c.id)?;
            connection
                .execute(
                    "UPDATE card_retirements SET phase='worktrees',error=NULL WHERE card_id=?1",
                    [&c.id],
                )
                .map_err(db_error)?;
        }
        "worktrees" => {
            for r in &resources {
                validate_resource(connection, &c.id, r, true)?;
                if Path::new(&r.path).exists() {
                    git(&r.target, &["worktree", "remove", "--force", "--", &r.path])?;
                }
                // Missing directory can still have a registration.
                // Only remove that exact registration, never prune others.
                if worktree_inventory(&r.target)?
                    .iter()
                    .any(|w| w.path == r.path)
                {
                    git(&r.target, &["worktree", "remove", "--force", "--", &r.path])?;
                }
            }
            connection
                .execute(
                    "UPDATE card_retirements SET phase='branches',error=NULL WHERE card_id=?1",
                    [&c.id],
                )
                .map_err(db_error)?;
        }
        "branches" => {
            for r in &resources {
                validate_resource(connection, &c.id, r, true)?;
                if Path::new(&r.path).exists()
                    || worktree_inventory(&r.target)?
                        .iter()
                        .any(|w| w.branch.as_deref() == Some(&r.branch))
                {
                    return Err("Card branch is still checked out or its worktree reappeared; branch retained".into());
                }
                if local_ref_tip(&r.target, &r.branch)?.is_some() {
                    // Compare-and-delete protects against an external ref update
                    // between the last ownership check and branch deletion.
                    git(
                        &r.target,
                        &[
                            "update-ref",
                            "-d",
                            &format!("refs/heads/{}", r.branch),
                            &r.tip,
                        ],
                    )?;
                }
            }
            connection
                .execute(
                    "UPDATE card_retirements SET phase='storage',error=NULL WHERE card_id=?1",
                    [&c.id],
                )
                .map_err(db_error)?;
        }
        "storage" => {
            for r in &resources {
                validate_resource(connection, &c.id, r, true)?;
                if Path::new(&r.path).exists() || local_ref_tip(&r.target, &r.branch)?.is_some() {
                    return Err("Git resources reappeared after cleanup; record and ownership evidence retained".into());
                }
            }
            for file in setup_files(connection, &c.id, &app_data_dir()?.join("setup-results"))? {
                if file.exists() {
                    fs::remove_file(&file).map_err(|e| {
                        format!("Could not remove setup artifact {}: {e}", file.display())
                    })?;
                }
            }
            finalize(connection, &c.id)?;
            return Ok(true);
        }
        _ => return Err(format!("Unknown retirement phase: {phase}")),
    }
    Ok(false)
}

fn finish_purge(
    connection: &Connection,
    id: &str,
    staged: &Path,
    remove: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    validate_owned_storage(staged)?;
    if staged.exists() {
        remove(staged)?;
    }
    connection
        .execute("DELETE FROM local_card_purge_jobs WHERE card_id=?1", [id])
        .map(|_| ())
        .map_err(db_error)
}
fn restore_retained_storage(candidates: &[DoneCleanupCandidate]) -> Vec<String> {
    let mut errors = Vec::new();
    for c in candidates {
        let restore = (|| {
            let retained = with_read_connection(|db| {
                db.query_row("SELECT EXISTS(SELECT 1 FROM kanban_cards WHERE id=?1) AND NOT EXISTS(SELECT 1 FROM local_card_purge_jobs WHERE storage_key=?2)",params![c.id,safe_card_key(&c.id)],|r|r.get::<_,bool>(0)).map_err(db_error)
            })?;
            if retained {
                let live = card_directory(&c.id)?;
                let staged = staged_directory(&c.id)?;
                validate_directory(&live)?;
                validate_directory(&staged)?;
                if staged.exists() && !live.exists() {
                    fs::rename(staged, live).map_err(|e| e.to_string())?;
                }
            }
            Ok::<(), String>(())
        })();
        if let Err(e) = restore {
            errors.push(format!("{}: file restore failed; retry: {e}", c.id));
        }
    }
    errors
}

pub(super) fn execute(
    candidates: Vec<DoneCleanupCandidate>,
    pi: &Mutex<PiRpcRegistry>,
    pty: &Mutex<PtyRegistry>,
    setup: &crate::workspace_setup::WorkspaceSetupState,
) -> Result<DoneCleanupResult, String> {
    let _resources = CARD_RESOURCE_START_LOCK
        .lock()
        .map_err(|_| "Card resource lock failed".to_string())?;
    let mut result = DoneCleanupResult::default();
    let mut seen = HashSet::new();
    for c in &candidates {
        if !seen.insert(c.id.clone()) {
            continue;
        }
        if !with_read_connection(|db| eligible(db, c, unix_timestamp()))? {
            result.skipped += 1;
            result.details.push(format!(
                "{}: not retired; no longer in the confirmed Done period",
                c.id
            ));
            continue;
        }
        match retire(c, pi, pty, setup) {
            Ok(()) => {
                result.deleted += 1;
                result.removed_ids.push(c.id.clone());
            }
            Err(e) => {
                // Never overwrite or drop ownership evidence on failure.
                let _ = with_board_mutation(|db| {
                    db.execute(
                        "UPDATE card_retirements SET error=?2 WHERE card_id=?1",
                        params![c.id, e],
                    )
                    .map(|_| ())
                    .map_err(db_error)
                });
                if matches!(
                    with_read_connection(|db| eligible(db, c, unix_timestamp())),
                    Ok(false)
                ) {
                    result.skipped += 1;
                    result.details.push(format!("{}: no longer qualifying; no further cleanup performed. Any partial-cleanup evidence is retained: {e}",c.id));
                } else {
                    result.failed += 1;
                    result.details.push(format!(
                        "{}: retirement failed; retry this action (ownership changes require review): {e}",
                        c.id
                    ));
                }
            }
        }
    }
    result.details.extend(restore_retained_storage(&candidates));
    let jobs = with_read_connection(|db| {
        db.prepare("SELECT card_id FROM local_card_purge_jobs")
            .map_err(db_error)?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)
    })?;
    for id in jobs {
        let purge = (|| {
            let staged = staged_directory(&id)?;
            with_board_mutation(|db| {
                finish_purge(db, &id, &staged, |p| {
                    fs::remove_dir_all(p).map_err(|e| e.to_string())
                })
            })
        })();
        if let Err(e) = purge {
            if result.removed_ids.contains(&id) {
                result.deleted -= 1;
            }
            result.failed += 1;
            result.details.push(format!(
                "{id}: local record removed but file purge failed; retry this action: {e}"
            ));
        } else if !result.removed_ids.contains(&id) {
            result.deleted += 1;
            result.removed_ids.push(id.clone());
            result
                .details
                .push(format!("{id}: pending file purge completed; fully retired"));
        }
    }
    Ok(result)
}

#[cfg(test)]
#[path = "done_retention_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "done_retirement_resource_tests.rs"]
mod resource_tests;
