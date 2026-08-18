use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    collections::HashMap,
    env,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::State;
use wait_timeout::ChildExt;

const ST_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const BOARD_DISCOVERY_CONCURRENCY: usize = 4;

#[derive(Clone, Default)]
pub struct SuperthreadService {
    cli_path: Arc<Mutex<Option<PathBuf>>>,
    user_names: Arc<Mutex<Option<HashMap<String, String>>>>,
    card_base_urls: Arc<Mutex<HashMap<String, String>>>,
    metadata_generation: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Deserialize)]
struct Space {
    id: String,
    title: String,
}

#[derive(Debug, Clone, Deserialize)]
struct BoardSummary {
    id: String,
    title: String,
}

#[derive(Debug, Deserialize)]
struct BoardDetail {
    #[serde(default)]
    lists: Vec<SuperthreadList>,
}

#[derive(Debug, Deserialize)]
struct CardsResponse {
    #[serde(default)]
    cards: Vec<SuperthreadCard>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SuperthreadList {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub behavior: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CardAssignee {
    user_id: String,
}

#[derive(Debug, Deserialize)]
struct SuperthreadUser {
    user_id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    first_name: String,
    #[serde(default)]
    last_name: String,
    #[serde(default)]
    email: String,
}

#[derive(Debug, Deserialize)]
struct AuthStatus {
    workspace_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SuperthreadCard {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub content: String,
    pub list_id: String,
    #[serde(default)]
    pub list_title: String,
    #[serde(default)]
    pub board_id: String,
    #[serde(default)]
    pub board_title: String,
    #[serde(default)]
    pub total_comments: u64,
    #[serde(default)]
    assignees: Vec<CardAssignee>,
    #[serde(default)]
    assignee_names: Vec<String>,
    #[serde(default)]
    card_url: String,
}

#[derive(Debug, Serialize)]
pub struct SuperthreadBoard {
    id: String,
    title: String,
}

#[derive(Debug, Serialize)]
pub struct IntegrationWarning {
    scope: String,
    message: String,
}

#[derive(Debug, Serialize)]
pub struct SuperthreadBoardsResponse {
    boards: Vec<SuperthreadBoard>,
    warnings: Vec<IntegrationWarning>,
}

#[tauri::command]
pub async fn superthread_boards(
    service: State<'_, SuperthreadService>,
    spaces: Vec<String>,
    refresh: bool,
) -> Result<SuperthreadBoardsResponse, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        if refresh {
            service.invalidate_metadata();
        }
        service.boards(&spaces)
    })
    .await
}

#[tauri::command]
pub async fn superthread_board_lists(
    service: State<'_, SuperthreadService>,
    board_id: String,
) -> Result<Vec<SuperthreadList>, String> {
    let service = service.inner().clone();
    run_blocking(move || service.board_lists(&board_id)).await
}

#[tauri::command]
pub async fn superthread_board_cards(
    service: State<'_, SuperthreadService>,
    board_id: String,
    workspace_slug: Option<String>,
) -> Result<Vec<SuperthreadCard>, String> {
    let service = service.inner().clone();
    run_blocking(move || service.board_cards(&board_id, workspace_slug.as_deref())).await
}

#[tauri::command]
pub async fn superthread_card(
    service: State<'_, SuperthreadService>,
    card_id: String,
    workspace_slug: Option<String>,
) -> Result<SuperthreadCard, String> {
    let service = service.inner().clone();
    run_blocking(move || service.card(&card_id, workspace_slug.as_deref())).await
}

async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("Superthread worker failed: {error}"))?
}

impl SuperthreadService {
    fn boards(&self, included_spaces: &[String]) -> Result<SuperthreadBoardsResponse, String> {
        let cli = self.cli_path()?;
        let spaces: Vec<Space> = run_st_json(&cli, &["spaces", "list"])?;
        let included_spaces = included_spaces
            .iter()
            .map(|space| space.trim())
            .filter(|space| !space.is_empty())
            .collect::<Vec<_>>();
        let selected_spaces = spaces
            .into_iter()
            .filter(|space| {
                included_spaces
                    .iter()
                    .any(|included| space.title.trim().eq_ignore_ascii_case(included))
            })
            .collect::<Vec<_>>();
        let mut boards = Vec::new();
        let mut warnings = included_spaces
            .iter()
            .filter(|included| {
                !selected_spaces
                    .iter()
                    .any(|space| space.title.trim().eq_ignore_ascii_case(included))
            })
            .map(|included| IntegrationWarning {
                scope: format!("space:{included}"),
                message: format!("Superthread space '{included}' was not found"),
            })
            .collect::<Vec<_>>();

        for chunk in selected_spaces.chunks(BOARD_DISCOVERY_CONCURRENCY) {
            let handles = chunk
                .iter()
                .cloned()
                .map(|space| {
                    let cli = cli.clone();
                    std::thread::spawn(move || {
                        let result = run_st_json::<Vec<BoardSummary>>(
                            &cli,
                            &["boards", "list", "--space", &space.id],
                        );
                        (space, result)
                    })
                })
                .collect::<Vec<_>>();

            for handle in handles {
                match handle.join() {
                    Ok((_space, Ok(space_boards))) => {
                        boards.extend(space_boards.into_iter().map(|board| SuperthreadBoard {
                            id: board.id,
                            title: board.title,
                        }))
                    }
                    Ok((space, Err(message))) => warnings.push(IntegrationWarning {
                        scope: format!("space:{}", space.title),
                        message,
                    }),
                    Err(_) => warnings.push(IntegrationWarning {
                        scope: "board-discovery".to_string(),
                        message: "A board discovery worker failed".to_string(),
                    }),
                }
            }
        }

        Ok(SuperthreadBoardsResponse { boards, warnings })
    }

    fn board_lists(&self, board_id: &str) -> Result<Vec<SuperthreadList>, String> {
        require_id(board_id, "Board")?;
        let cli = self.cli_path()?;
        let detail: BoardDetail = run_st_json(&cli, &["boards", "get", board_id.trim()])?;
        Ok(detail.lists)
    }

    fn board_cards(
        &self,
        board_id: &str,
        workspace_slug: Option<&str>,
    ) -> Result<Vec<SuperthreadCard>, String> {
        require_id(board_id, "Board")?;
        let cli = self.cli_path()?;
        let mut response: CardsResponse = run_st_json(
            &cli,
            &[
                "cards",
                "list",
                "--board",
                board_id.trim(),
                "--status",
                "all",
            ],
        )?;
        let card_base_url = self.card_base_url(&cli, workspace_slug);
        response
            .cards
            .iter_mut()
            .for_each(|card| populate_card_url(card, card_base_url.as_deref()));
        Ok(response.cards)
    }

    fn card(&self, card_id: &str, workspace_slug: Option<&str>) -> Result<SuperthreadCard, String> {
        require_id(card_id, "Card")?;
        let cli = self.cli_path()?;
        let mut card = run_st_json(&cli, &["cards", "get", card_id.trim()])?;
        populate_assignee_names(&mut card, &self.user_names(&cli)?);
        populate_card_url(
            &mut card,
            self.card_base_url(&cli, workspace_slug).as_deref(),
        );
        Ok(card)
    }

    fn cli_path(&self) -> Result<PathBuf, String> {
        if let Some(path) = self.cli_path.lock().map_err(lock_error)?.clone() {
            return Ok(path);
        }
        let path = find_st_cli()?;
        *self.cli_path.lock().map_err(lock_error)? = Some(path.clone());
        Ok(path)
    }

    fn user_names(&self, cli: &Path) -> Result<HashMap<String, String>, String> {
        if let Ok(cache) = self.user_names.lock() {
            if let Some(users) = cache.as_ref() {
                return Ok(users.clone());
            }
        }
        let generation = self.metadata_generation.load(Ordering::SeqCst);
        let users = load_user_names(cli)?;
        if generation == self.metadata_generation.load(Ordering::SeqCst) {
            if let Ok(mut cache) = self.user_names.lock() {
                *cache = Some(users.clone());
            }
        }
        Ok(users)
    }

    fn card_base_url(&self, cli: &Path, workspace_slug: Option<&str>) -> Option<String> {
        let key = workspace_slug
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("__auto__");
        if let Ok(cache) = self.card_base_urls.lock() {
            if let Some(url) = cache.get(key) {
                return Some(url.clone());
            }
        }
        let generation = self.metadata_generation.load(Ordering::SeqCst);
        let url = load_card_base_url(cli, workspace_slug);
        if generation == self.metadata_generation.load(Ordering::SeqCst) {
            if let (Some(url), Ok(mut cache)) = (url.as_ref(), self.card_base_urls.lock()) {
                cache.insert(key.to_string(), url.clone());
            }
        }
        url
    }

    fn invalidate_metadata(&self) {
        self.metadata_generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut users) = self.user_names.lock() {
            *users = None;
        }
        if let Ok(mut urls) = self.card_base_urls.lock() {
            urls.clear();
        }
    }
}

fn require_id(value: &str, kind: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{kind} ID is required"))
    } else {
        Ok(())
    }
}

fn load_user_names(cli: &Path) -> Result<HashMap<String, String>, String> {
    Ok(
        run_st_json::<Vec<SuperthreadUser>>(cli, &["users", "list"])?
            .into_iter()
            .map(|user| {
                let full_name = format!("{} {}", user.first_name.trim(), user.last_name.trim())
                    .trim()
                    .to_string();
                let name = if !user.display_name.trim().is_empty() {
                    user.display_name.trim().to_string()
                } else if !full_name.is_empty() {
                    full_name
                } else if !user.email.trim().is_empty() {
                    user.email.trim().to_string()
                } else {
                    user.user_id.clone()
                };
                (user.user_id, name)
            })
            .collect(),
    )
}

fn populate_assignee_names(card: &mut SuperthreadCard, user_names: &HashMap<String, String>) {
    card.assignee_names = card
        .assignees
        .iter()
        .map(|assignee| {
            user_names
                .get(&assignee.user_id)
                .cloned()
                .unwrap_or_else(|| assignee.user_id.clone())
        })
        .collect();
}

fn load_card_base_url(cli: &Path, configured_slug: Option<&str>) -> Option<String> {
    let workspace_slug = if let Some(slug) = configured_slug
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        slugify(slug)
    } else {
        let status: AuthStatus = run_st_json(cli, &["whoami"]).ok()?;
        env::var("ST_WORKSPACE_SLUG")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| slugify(&value))
            .unwrap_or_else(|| slugify(&status.workspace_name))
    };
    if workspace_slug.is_empty() {
        return None;
    }
    let app_url =
        env::var("ST_APP_URL").unwrap_or_else(|_| "https://app.superthread.com".to_string());
    Some(format!(
        "{}/{}",
        app_url.trim_end_matches('/'),
        workspace_slug
    ))
}

fn populate_card_url(card: &mut SuperthreadCard, base_url: Option<&str>) {
    card.card_url = base_url
        .map(|base| format!("{base}/card-{}", card.id))
        .unwrap_or_default();
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(character.to_ascii_lowercase());
            pending_dash = false;
        } else {
            pending_dash = true;
        }
    }
    slug
}

fn run_st_json<T: for<'de> Deserialize<'de>>(cli: &Path, args: &[&str]) -> Result<T, String> {
    let mut full_args = args.to_vec();
    full_args.extend(["--output", "json"]);
    let output = run_process(cli, &full_args, ST_COMMAND_TIMEOUT)?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("Superthread CLI exited with {}", output.status)
        } else {
            message
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid Superthread CLI response: {error}"))
}

#[derive(Debug)]
struct ProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_process(program: &Path, args: &[&str], timeout: Duration) -> Result<ProcessOutput, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not run {}: {error}", program.display()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not capture process output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not capture process errors".to_string())?;
    let stdout_reader = std::thread::spawn(move || read_stream(stdout));
    let stderr_reader = std::thread::spawn(move || read_stream(stderr));

    let status = match child.wait_timeout(timeout) {
        Ok(Some(status)) => status,
        Ok(None) => {
            terminate_process_group(&mut child);
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!(
                "{} timed out after {} seconds",
                program.display(),
                timeout.as_secs()
            ));
        }
        Err(error) => {
            terminate_process_group(&mut child);
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!("Could not wait for {}: {error}", program.display()));
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "Could not read process output".to_string())??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Could not read process errors".to_string())??;
    Ok(ProcessOutput {
        status,
        stdout,
        stderr,
    })
}

fn terminate_process_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
}

fn read_stream(mut stream: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    stream
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn find_st_cli() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("ST_CLI_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Ok(path);
    }
    if let Some(path) = env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local/bin/st"))
        .filter(|path| path.is_file())
    {
        return Ok(path);
    }

    let shell = PathBuf::from(env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()));
    let output = run_process(&shell, &["-lic", "command -v st"], Duration::from_secs(5))?;
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    if output.status.success() && path.is_file() {
        return Ok(path);
    }

    Err("Superthread CLI not found. Install `st` or set ST_CLI_PATH.".to_string())
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> String {
    format!("Superthread cache lock failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies_workspace_names() {
        assert_eq!(slugify("Arcasa"), "arcasa");
        assert_eq!(slugify("My Product Team"), "my-product-team");
        assert_eq!(slugify("  Team / One  "), "team-one");
    }

    #[test]
    fn parses_card_fixture_with_missing_optional_fields() {
        let card: SuperthreadCard = serde_json::from_str(
            r#"{
            "id":"2067",
            "title":"Example",
            "list_id":"doing",
            "assignees":[{"user_id":"u1"}]
        }"#,
        )
        .unwrap();
        assert_eq!(card.id, "2067");
        assert_eq!(card.total_comments, 0);
        assert_eq!(card.assignees[0].user_id, "u1");
    }

    #[cfg(unix)]
    #[test]
    fn exercises_the_cli_adapter_with_partial_access() {
        use std::{fs, os::unix::fs::PermissionsExt};
        let path = env::temp_dir().join(format!("stacks-st-fixture-{}", uuid::Uuid::new_v4()));
        fs::write(&path, r#"#!/bin/sh
case "$1 $2" in
  "spaces list") echo '[{"id":"s1","title":"Product"},{"id":"s2","title":"Product"},{"id":"s3","title":"Engineering"}]' ;;
  "boards list") if [ "$4" = "s2" ]; then echo 'access denied' >&2; exit 1; else echo '[{"id":"b1","title":"Roadmap"}]'; fi ;;
  "boards get") echo '{"lists":[{"id":"l1","title":"Doing","behavior":"started"}]}' ;;
  "cards list") echo '{"cards":[{"id":"2067","title":"Example","list_id":"l1"}]}' ;;
  "cards get") echo '{"id":"2067","title":"Example","list_id":"l1","assignees":[{"user_id":"u1"}]}' ;;
  "users list") echo '[{"user_id":"u1","display_name":"Ada"}]' ;;
  "whoami --output") echo '{"workspace_name":"Arcasa"}' ;;
  *) echo "unexpected arguments: $*" >&2; exit 2 ;;
esac
"#).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let service = SuperthreadService::default();
        *service.cli_path.lock().unwrap() = Some(path.clone());

        let boards = service.boards(&["Product".to_string()]).unwrap();
        assert_eq!(boards.boards.len(), 1);
        assert_eq!(boards.warnings.len(), 1);
        let list = &service.board_lists("b1").unwrap()[0];
        assert_eq!(list.title, "Doing");
        assert_eq!(list.behavior, "started");
        assert_eq!(
            service.board_cards("b1", Some("arcasa")).unwrap()[0].card_url,
            "https://app.superthread.com/arcasa/card-2067"
        );
        assert_eq!(
            service.card("2067", Some("arcasa")).unwrap().assignee_names,
            vec!["Ada"]
        );

        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn terminates_timed_out_processes() {
        let error = run_process(
            Path::new("/bin/sh"),
            &["-c", "sleep 1"],
            Duration::from_millis(10),
        )
        .unwrap_err();
        assert!(error.contains("timed out"));
    }
}
