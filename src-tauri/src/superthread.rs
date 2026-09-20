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

#[derive(Default)]
pub struct SuperthreadService {
    cli_path: Arc<Mutex<Option<PathBuf>>>,
    user_names: Arc<Mutex<HashMap<String, HashMap<String, String>>>>,
    card_base_urls: Arc<Mutex<HashMap<String, String>>>,
    metadata_generation: Arc<AtomicU64>,
    // Deliberately not shared between clones. Every command first clones the managed
    // service and configures that operation-local clone, so concurrent projects can
    // never overwrite one another's credential selection.
    token_env_var: Mutex<String>,
}

impl Clone for SuperthreadService {
    fn clone(&self) -> Self {
        Self {
            cli_path: self.cli_path.clone(),
            user_names: self.user_names.clone(),
            card_base_urls: self.card_base_urls.clone(),
            metadata_generation: self.metadata_generation.clone(),
            token_env_var: Mutex::new(self.token_env_var.lock().map(|value| value.clone()).unwrap_or_default()),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Space {
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
    #[serde(default)]
    workspace_id: String,
    #[serde(default)]
    workspace_name: String,
    #[serde(default, alias = "app_slug")]
    workspace_slug: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SuperthreadTaskParent {
    #[serde(alias = "task_id")]
    pub id: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SuperthreadTaskChild {
    pub task_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SuperthreadCard {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub content: Option<String>,
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
    pub(crate) assignee_names: Vec<String>,
    #[serde(default)]
    pub(crate) card_url: String,
    #[serde(default)]
    pub task_parent: Option<SuperthreadTaskParent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_children: Option<Vec<SuperthreadTaskChild>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_task_children: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
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
    successful_space_ids: Vec<String>,
    warnings: Vec<IntegrationWarning>,
    complete: bool,
}

#[derive(Debug, Serialize)]
pub struct SuperthreadConnectionResult {
    workspace_id: String,
    workspace_name: String,
    workspace_slug: Option<String>,
    spaces: Vec<Space>,
}

#[tauri::command]
pub async fn superthread_test_connection(
    service: State<'_, SuperthreadService>,
    api_token_env_var: String,
) -> Result<SuperthreadConnectionResult, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        service.configure_token_env(&api_token_env_var)?;
        let cli = service.cli_path()?;
        let token = service.api_token()?;
        let auth: AuthStatus = run_st_json(&cli, &["auth", "status"], Some(&token))?;
        if auth.workspace_id.trim().is_empty() || auth.workspace_name.trim().is_empty() {
            return Err("Superthread authentication did not return a stable workspace ID and name".into());
        }
        let spaces = run_st_json(&cli, &["spaces", "list"], Some(&token))?;
        Ok(SuperthreadConnectionResult { workspace_id: auth.workspace_id, workspace_name: auth.workspace_name, workspace_slug: auth.workspace_slug, spaces })
    }).await
}

#[tauri::command]
pub async fn superthread_boards_for_space(
    service: State<'_, SuperthreadService>,
    space_id: String,
    api_token_env_var: String,
) -> Result<Vec<SuperthreadBoard>, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        service.configure_token_env(&api_token_env_var)?;
        require_id(&space_id, "Space")?;
        let cli = service.cli_path()?;
        let token = service.api_token()?;
        let boards: Vec<BoardSummary> = run_st_json(&cli, &["boards", "list", "--space", space_id.trim()], Some(&token))?;
        Ok(boards.into_iter().map(|board| SuperthreadBoard { id: board.id, title: board.title }).collect())
    }).await
}

#[tauri::command]
pub async fn superthread_boards(
    service: State<'_, SuperthreadService>,
    spaces: Vec<String>,
    refresh: bool,
    api_token_env_var: String,
) -> Result<SuperthreadBoardsResponse, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        service.configure_token_env(&api_token_env_var)?;
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
    api_token_env_var: String,
) -> Result<Vec<SuperthreadList>, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        service.configure_token_env(&api_token_env_var)?;
        service.board_lists(&board_id)
    })
    .await
}

#[tauri::command]
pub async fn superthread_board_cards(
    service: State<'_, SuperthreadService>,
    board_id: String,
    workspace_slug: Option<String>,
    api_token_env_var: String,
) -> Result<Vec<SuperthreadCard>, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        service.configure_token_env(&api_token_env_var)?;
        service.board_cards(&board_id, workspace_slug.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn superthread_card(
    service: State<'_, SuperthreadService>,
    card_id: String,
    workspace_slug: Option<String>,
    api_token_env_var: String,
) -> Result<SuperthreadCard, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        service.configure_token_env(&api_token_env_var)?;
        service.card(&card_id, workspace_slug.as_deref())
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
pub struct SuperthreadMappingDraft {
    pub(crate) spaces: String,
    pub(crate) board_id: String,
    pub(crate) incoming_column_ids: Vec<String>,
    pub(crate) default_incoming_column_id: String,
    pub(crate) in_progress_column_id: String,
    pub(crate) done_column_id: String,
    pub(crate) api_token_env_var: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SuperthreadMappingTestResult {
    pub(crate) workspace_id: String,
    pub(crate) workspace_name: String,
    pub(crate) space_id: String,
    pub(crate) space_name: String,
    pub(crate) workspace_slug: Option<String>,
    pub(crate) board_id: String,
    pub(crate) board_name: String,
    pub(crate) incoming_columns: Vec<ColumnMapping>,
    pub(crate) default_incoming_column_id: String,
    pub(crate) in_progress_column_id: String,
    pub(crate) in_progress_column_name: String,
    pub(crate) done_column_id: String,
    pub(crate) done_column_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnMapping {
    pub(crate) id: String,
    pub(crate) name: String,
}

#[tauri::command]
pub async fn superthread_test_mapping(
    service: State<'_, SuperthreadService>,
    configuration: SuperthreadMappingDraft,
) -> Result<SuperthreadMappingTestResult, String> {
    let service = service.inner().clone();
    run_blocking(move || service.test_mapping(&configuration)).await
}

#[tauri::command]
pub async fn superthread_create_card(
    service: State<'_, SuperthreadService>,
    board_id: String,
    list_id: String,
    title: String,
    content: String,
    workspace_slug: Option<String>,
    api_token_env_var: String,
) -> Result<SuperthreadCard, String> {
    let service = service.inner().clone();
    run_blocking(move || {
        service.configure_token_env(&api_token_env_var)?;
        service.create_card(
            &board_id,
            &list_id,
            &title,
            &content,
            workspace_slug.as_deref(),
        )
    })
    .await
}

async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("Superthread worker failed: {error}"))?
}

impl SuperthreadService {
    pub(crate) fn configure_token_env(&self, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty()
            || !name
                .starts_with(|character: char| character == '_' || character.is_ascii_alphabetic())
            || !name
                .chars()
                .all(|character| character == '_' || character.is_ascii_alphanumeric())
        {
            return Err(
                "Superthread API Token Env Variable must be a valid environment variable name"
                    .into(),
            );
        }
        *self.token_env_var.lock().map_err(lock_error)? = name.to_string();
        self.api_token().map(|_| ())
    }

    fn api_token(&self) -> Result<String, String> {
        let name = self.token_env_var.lock().map_err(lock_error)?.clone();
        let name = if name.is_empty() {
            "ST_TOKEN"
        } else {
            name.as_str()
        };
        resolve_api_token(name)
    }

    fn boards(&self, included_spaces: &[String]) -> Result<SuperthreadBoardsResponse, String> {
        let cli = self.cli_path()?;
        let token = self.api_token()?;
        let spaces: Vec<Space> = run_st_json(&cli, &["spaces", "list"], Some(&token))?;
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
                    .any(|included| space_matches_filter(&space.title, included))
            })
            .collect::<Vec<_>>();
        let mut boards = Vec::new();
        let mut successful_space_ids = Vec::new();
        let mut warnings = included_spaces
            .iter()
            .filter(|included| {
                !selected_spaces
                    .iter()
                    .any(|space| space_matches_filter(&space.title, included))
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
                    let token = token.clone();
                    std::thread::spawn(move || {
                        let result = run_st_json::<Vec<BoardSummary>>(
                            &cli,
                            &["boards", "list", "--space", &space.id],
                            Some(&token),
                        );
                        (space, result)
                    })
                })
                .collect::<Vec<_>>();

            for handle in handles {
                match handle.join() {
                    Ok((space, Ok(space_boards))) => {
                        successful_space_ids.push(space.id);
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

        let complete = warnings.is_empty();
        Ok(SuperthreadBoardsResponse {
            boards,
            successful_space_ids,
            warnings,
            complete,
        })
    }

    fn board_lists(&self, board_id: &str) -> Result<Vec<SuperthreadList>, String> {
        require_id(board_id, "Board")?;
        let cli = self.cli_path()?;
        let token = self.api_token()?;
        let detail: BoardDetail =
            run_st_json(&cli, &["boards", "get", board_id.trim()], Some(&token))?;
        Ok(detail.lists)
    }

    fn board_cards(
        &self,
        board_id: &str,
        workspace_slug: Option<&str>,
    ) -> Result<Vec<SuperthreadCard>, String> {
        require_id(board_id, "Board")?;
        let cli = self.cli_path()?;
        let token = self.api_token()?;
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
            Some(&token),
        )?;
        let card_base_url = self.card_base_url(&cli, workspace_slug);
        let user_names = self.user_names(&cli)?;
        response.cards.iter_mut().for_each(|card| {
            populate_assignee_names(card, &user_names);
            populate_card_url(card, card_base_url.as_deref());
        });
        Ok(response.cards)
    }

    pub(crate) fn card(
        &self,
        card_id: &str,
        workspace_slug: Option<&str>,
    ) -> Result<SuperthreadCard, String> {
        require_id(card_id, "Card")?;
        let cli = self.cli_path()?;
        let token = self.api_token()?;
        let mut card = run_st_json(&cli, &["cards", "get", card_id.trim()], Some(&token))?;
        populate_assignee_names(&mut card, &self.user_names(&cli)?);
        populate_card_url(
            &mut card,
            self.card_base_url(&cli, workspace_slug).as_deref(),
        );
        Ok(card)
    }

    pub(crate) fn move_card(
        &self,
        card_id: &str,
        board_id: &str,
        list_id: &str,
    ) -> Result<(), String> {
        require_id(card_id, "Card")?;
        require_id(board_id, "Board")?;
        require_id(list_id, "List")?;
        let cli = self.cli_path()?;
        let token = self.api_token()?;
        let output = run_process(
            &cli,
            &[
                "cards",
                "update",
                card_id.trim(),
                "--board",
                board_id.trim(),
                "--list",
                list_id.trim(),
            ],
            ST_COMMAND_TIMEOUT,
            Some(&token),
        )?;
        if output.status.success() {
            Ok(())
        } else {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if message.is_empty() {
                format!("Superthread CLI exited with {}", output.status)
            } else {
                message
            })
        }
    }

    pub(crate) fn test_mapping(
        &self,
        configuration: &SuperthreadMappingDraft,
    ) -> Result<SuperthreadMappingTestResult, String> {
        let spaces = configuration
            .spaces
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        self.configure_token_env(&configuration.api_token_env_var)?;
        let cli = self.cli_path()?;
        let token = self.api_token()?;
        let auth: AuthStatus = run_st_json(&cli, &["auth", "status"], Some(&token))?;
        if auth.workspace_name.trim().is_empty() {
            return Err("Superthread authentication did not identify a workspace".into());
        }
        if spaces.len() != 1 {
            return Err("Select exactly one Superthread space".into());
        }
        let all_spaces: Vec<Space> = run_st_json(&cli, &["spaces", "list"], Some(&token))?;
        let selected_spaces = all_spaces.into_iter().filter(|space| space_matches_filter(&space.title, &spaces[0])).collect::<Vec<_>>();
        if selected_spaces.len() != 1 {
            return Err("Configured Superthread space was not found or was ambiguous; select it by stable ID".into());
        }
        let selected_space = selected_spaces[0].clone();
        let discovery = self.boards(&spaces)?;
        if !discovery.complete {
            return Err(discovery
                .warnings
                .into_iter()
                .map(|warning| warning.message)
                .collect::<Vec<_>>()
                .join("; "));
        }
        let matches = discovery
            .boards
            .into_iter()
            .filter(|board| board.id == configuration.board_id.trim())
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(format!(
                "Configured Superthread board ID '{}' was not found or was ambiguous",
                configuration.board_id
            ));
        }
        let board = matches[0].clone();
        let lists = self.board_lists(&board.id)?;
        let by_id = lists
            .iter()
            .map(|list| (list.id.as_str(), list))
            .collect::<HashMap<_, _>>();
        let mut all = configuration.incoming_column_ids.clone();
        all.push(configuration.in_progress_column_id.clone());
        all.push(configuration.done_column_id.clone());
        if all.iter().any(|id| id.trim().is_empty()) {
            return Err("Incoming, In progress, and Stacks is done columns are required".into());
        }
        let unique = all
            .iter()
            .map(|id| id.trim())
            .collect::<std::collections::HashSet<_>>();
        if unique.len() != all.len() {
            return Err(
                "Incoming, In progress, and Stacks is done columns must be distinct and unique"
                    .into(),
            );
        }
        if !configuration
            .incoming_column_ids
            .iter()
            .any(|id| id == &configuration.default_incoming_column_id)
        {
            return Err("Default incoming column must be one of the Incoming columns".into());
        }
        for id in &all {
            if !by_id.contains_key(id.trim()) {
                return Err(format!(
                    "Configured column ID '{id}' does not belong to board '{}' or was deleted",
                    board.title
                ));
            }
        }
        let incoming_columns = configuration
            .incoming_column_ids
            .iter()
            .map(|id| {
                let list = by_id[id.trim()];
                ColumnMapping {
                    id: list.id.clone(),
                    name: list.title.clone(),
                }
            })
            .collect();
        Ok(SuperthreadMappingTestResult {
            workspace_id: auth.workspace_id,
            workspace_name: auth.workspace_name,
            space_id: selected_space.id,
            space_name: selected_space.title,
            workspace_slug: auth.workspace_slug,
            board_id: board.id,
            board_name: board.title,
            incoming_columns,
            default_incoming_column_id: configuration.default_incoming_column_id.clone(),
            in_progress_column_id: configuration.in_progress_column_id.clone(),
            in_progress_column_name: by_id[configuration.in_progress_column_id.trim()]
                .title
                .clone(),
            done_column_id: configuration.done_column_id.clone(),
            done_column_name: by_id[configuration.done_column_id.trim()].title.clone(),
        })
    }

    fn create_card(
        &self,
        board_id: &str,
        list_id: &str,
        title: &str,
        content: &str,
        workspace_slug: Option<&str>,
    ) -> Result<SuperthreadCard, String> {
        require_id(board_id, "Board")?;
        require_id(list_id, "List")?;
        let title = title.trim();
        if title.is_empty() {
            return Err("Card title is required".to_string());
        }
        let list = self
            .board_lists(board_id)?
            .into_iter()
            .find(|list| list.id == list_id)
            .ok_or_else(|| {
                "Configured default incoming column does not belong to the configured board"
                    .to_string()
            })?;
        let board = SuperthreadBoard {
            id: board_id.trim().to_string(),
            title: String::new(),
        };
        let cli = self.cli_path()?;
        let mut args = vec![
            "cards",
            "create",
            "--board",
            board.id.as_str(),
            "--list",
            list.id.as_str(),
            "--title",
            title,
        ];
        if !content.is_empty() {
            args.extend(["--content", content]);
        }
        let token = self.api_token()?;
        let mut card: SuperthreadCard = run_st_json(&cli, &args, Some(&token))?;
        card.title = title.to_string();
        card.content = Some(content.to_string());
        card.board_id = board.id;
        card.board_title = board.title;
        card.list_id = list.id;
        card.list_title = list.title;
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
        let credential_key = self.token_env_var.lock().map_err(lock_error)?.clone();
        if let Ok(cache) = self.user_names.lock() {
            if let Some(users) = cache.get(&credential_key) {
                return Ok(users.clone());
            }
        }
        let generation = self.metadata_generation.load(Ordering::SeqCst);
        let token = self.api_token()?;
        let users = load_user_names(cli, Some(&token))?;
        if generation == self.metadata_generation.load(Ordering::SeqCst) {
            if let Ok(mut cache) = self.user_names.lock() {
                cache.insert(credential_key, users.clone());
            }
        }
        Ok(users)
    }

    fn card_base_url(&self, cli: &Path, workspace_slug: Option<&str>) -> Option<String> {
        let token_env = self.token_env_var.lock().ok().map(|value| value.clone()).unwrap_or_default();
        let slug_key = workspace_slug
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("__auto__");
        let key = format!("{token_env}:{slug_key}");
        if let Ok(cache) = self.card_base_urls.lock() {
            if let Some(url) = cache.get(&key) {
                return Some(url.clone());
            }
        }
        let generation = self.metadata_generation.load(Ordering::SeqCst);
        let token = self.api_token().ok();
        let url = load_card_base_url(cli, workspace_slug, token.as_deref());
        if generation == self.metadata_generation.load(Ordering::SeqCst) {
            if let (Some(url), Ok(mut cache)) = (url.as_ref(), self.card_base_urls.lock()) {
                cache.insert(key, url.clone());
            }
        }
        url
    }

    fn invalidate_metadata(&self) {
        self.metadata_generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut users) = self.user_names.lock() {
            users.clear();
        }
        if let Ok(mut urls) = self.card_base_urls.lock() {
            urls.clear();
        }
    }
}

fn space_matches_filter(title: &str, filter: &str) -> bool {
    let title = title.trim();
    let filter = filter.trim();
    title.eq_ignore_ascii_case(filter)
        || (filter.eq_ignore_ascii_case("Product")
            && title.eq_ignore_ascii_case("Product & Engineering"))
}

fn require_id(value: &str, kind: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{kind} ID is required"))
    } else {
        Ok(())
    }
}

fn load_user_names(cli: &Path, token: Option<&str>) -> Result<HashMap<String, String>, String> {
    Ok(
        run_st_json::<Vec<SuperthreadUser>>(cli, &["users", "list"], token)?
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

fn load_card_base_url(
    cli: &Path,
    configured_slug: Option<&str>,
    token: Option<&str>,
) -> Option<String> {
    let workspace_slug = if let Some(slug) = configured_slug
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        slugify(slug)
    } else {
        let status: AuthStatus = run_st_json(cli, &["auth", "status"], token).ok()?;
        status.workspace_slug.map(|value| slugify(&value)).unwrap_or_default()
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

fn run_st_json<T: for<'de> Deserialize<'de>>(
    cli: &Path,
    args: &[&str],
    token: Option<&str>,
) -> Result<T, String> {
    let mut full_args = args.to_vec();
    full_args.extend(["--output", "json"]);
    let output = run_process(cli, &full_args, ST_COMMAND_TIMEOUT, token)?;
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

fn run_process(
    program: &Path,
    args: &[&str],
    timeout: Duration,
    token: Option<&str>,
) -> Result<ProcessOutput, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(token) = token {
        command.env("ST_TOKEN", token);
    }
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
    let mut stdout = stdout_reader
        .join()
        .map_err(|_| "Could not read process output".to_string())??;
    let mut stderr = stderr_reader
        .join()
        .map_err(|_| "Could not read process errors".to_string())??;
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        stdout = redact_bytes(stdout, token);
        stderr = redact_bytes(stderr, token);
    }
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

fn redact_bytes(bytes: Vec<u8>, token: &str) -> Vec<u8> {
    String::from_utf8_lossy(&bytes).replace(token, "[REDACTED]").into_bytes()
}

pub(crate) fn resolve_api_token(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || !name.starts_with(|character: char| character == '_' || character.is_ascii_alphabetic())
        || !name.chars().all(|character| character == '_' || character.is_ascii_alphanumeric())
    {
        return Err("Superthread API Token Env Variable must be a valid environment variable name".into());
    }
    env::var(name).ok().filter(|token| !token.trim().is_empty())
        .or_else(|| token_from_login_shell(name))
        .ok_or_else(|| format!("Superthread API token environment variable {name} is not set in the app or login shell; Stacks does not use the Superthread CLI config token"))
}

fn token_from_login_shell(name: &str) -> Option<String> {
    // The shell source is constant. The already-validated variable name is passed as
    // positional data, not interpolated into executable shell text.
    let shell = PathBuf::from(env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()));
    let output = run_process(
        &shell,
        &["-lic", "printf '\\036'; printenv \"$1\"; printf '\\036'", "stacks-token", name],
        Duration::from_secs(5),
        None,
    ).ok()?;
    if !output.status.success() { return None; }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let token = stdout.split('\u{1e}').nth(1)?.trim().to_string();
    (!token.is_empty()).then_some(token)
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
    let output = run_process(
        &shell,
        &["-lic", "command -v st"],
        Duration::from_secs(5),
        None,
    )?;
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
    fn matches_the_known_product_space_rename_without_broad_substrings() {
        assert!(space_matches_filter("Product & Engineering", "Product"));
        assert!(space_matches_filter(
            "Product & Engineering",
            "product & engineering"
        ));
        assert!(!space_matches_filter("Product Marketing", "Product"));
    }

    #[test]
    fn requires_the_configured_token_environment_variable() {
        let service = SuperthreadService::default();
        let error = service
            .configure_token_env("STACKS_TEST_MISSING_SUPERTHREAD_TOKEN_140")
            .unwrap_err();
        assert!(error.contains("is not set in the app or login shell"));
        assert!(error.contains("does not use the Superthread CLI config token"));
    }

    #[test]
    fn operation_clones_keep_credentials_isolated_and_redact_failures() {
        std::env::set_var("STACKS_ST_TOKEN_ONE", "secret-one");
        std::env::set_var("STACKS_ST_TOKEN_TWO", "secret-two");
        let first = SuperthreadService::default();
        let second = first.clone();
        first.configure_token_env("STACKS_ST_TOKEN_ONE").unwrap();
        second.configure_token_env("STACKS_ST_TOKEN_TWO").unwrap();
        assert_eq!(first.api_token().unwrap(), "secret-one");
        assert_eq!(second.api_token().unwrap(), "secret-two");
        let output = run_process(Path::new("/bin/sh"), &["-c", "printf '%s' \"$ST_TOKEN\" >&2; exit 1"], Duration::from_secs(1), Some("secret-one")).unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stderr), "[REDACTED]");
    }

    #[test]
    fn rejects_variable_names_before_login_shell_resolution() {
        assert!(resolve_api_token("TOKEN; echo unsafe").unwrap_err().contains("valid environment variable"));
    }

    #[test]
    fn slugifies_workspace_names() {
        assert_eq!(slugify("Arcasa"), "arcasa");
        assert_eq!(slugify("My Product Team"), "my-product-team");
        assert_eq!(slugify("  Team / One  "), "team-one");
    }

    #[test]
    fn parses_card_fixture_with_actual_task_parent_shape() {
        let card: SuperthreadCard = serde_json::from_str(
            r#"{
            "id":"2242",
            "title":"Child",
            "list_id":"doing",
            "assignees":[{"user_id":"u1"}],
            "task_parent":{"task_id":"2240","title":"Parent"},
            "task_children":[
                {"task_id":"2243","title":"First child","status":"started"},
                {"task_id":"2244","title":"Second child","status":"backlog"}
            ],
            "total_task_children":2
        }"#,
        )
        .unwrap();
        assert_eq!(card.id, "2242");
        assert_eq!(card.content, None);
        assert_eq!(card.total_comments, 0);
        assert_eq!(card.assignees[0].user_id, "u1");
        assert_eq!(
            card.task_parent.as_ref().map(|parent| parent.id.as_str()),
            Some("2240")
        );
        assert_eq!(card.total_task_children, Some(2));
        let children = card.task_children.unwrap();
        assert_eq!(
            (
                children[0].task_id.as_str(),
                children[0].title.as_str(),
                children[0].status.as_str()
            ),
            ("2243", "First child", "started")
        );
        assert_eq!(
            serde_json::to_value(card.task_parent.unwrap()).unwrap()["id"],
            "2240"
        );
    }

    #[test]
    fn parses_legacy_task_parent_id_shape() {
        let card: SuperthreadCard = serde_json::from_str(
            r#"{"id":"2242","title":"Child","list_id":"doing","task_parent":{"id":"2240","title":"Parent"}}"#,
        )
        .unwrap();
        assert_eq!(card.task_parent.unwrap().id, "2240");
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
        std::env::set_var("ST_TOKEN", "fixture-token");
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
    fn fixture_service(script: &str) -> (SuperthreadService, PathBuf) {
        use std::{fs, os::unix::fs::PermissionsExt};
        let path = env::temp_dir().join(format!("stacks-st-fixture-{}", uuid::Uuid::new_v4()));
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let service = SuperthreadService::default();
        std::env::set_var("ST_TOKEN", "fixture-token");
        *service.cli_path.lock().unwrap() = Some(path.clone());
        (service, path)
    }

    #[test]
    fn parses_auth_status_without_treating_user_identity_as_workspace_identity() {
        let status: AuthStatus = serde_json::from_str(r#"{
          "id":"user-id","name":"User Name","workspace_id":"workspace-id","workspace_name":"Workspace Name"
        }"#).unwrap();
        assert_eq!(status.workspace_id, "workspace-id");
        assert_eq!(status.workspace_name, "Workspace Name");
    }

    #[cfg(unix)]
    #[test]
    fn validates_mapping_ids_and_refreshes_current_labels() {
        use std::fs;
        let script = r#"#!/bin/sh
case "$1 $2" in
  "auth status") echo '{"id":"user-id","name":"Test User","workspace_id":"workspace-id","workspace_name":"Test workspace"}' ;;
  "spaces list") echo '[{"id":"s1","title":"Configured"}]' ;;
  "boards list") echo '[{"id":"b1","title":"Renamed board"},{"id":"b2","title":"Renamed board"}]' ;;
  "boards get") echo '{"lists":[{"id":"in1","title":"Renamed incoming"},{"id":"progress","title":"Doing"},{"id":"done","title":"Shipped"}]}' ;;
  *) echo "unexpected arguments: $*" >&2; exit 2 ;;
esac
"#;
        let (service, path) = fixture_service(script);
        let draft = SuperthreadMappingDraft {
            spaces: "Configured".into(),
            board_id: "b1".into(),
            incoming_column_ids: vec!["in1".into()],
            default_incoming_column_id: "in1".into(),
            in_progress_column_id: "progress".into(),
            done_column_id: "done".into(),
            api_token_env_var: "ST_TOKEN".into(),
        };
        let tested = service.test_mapping(&draft).unwrap();
        assert_eq!(tested.workspace_id, "workspace-id");
        assert_eq!(
            (tested.board_id.as_str(), tested.board_name.as_str()),
            ("b1", "Renamed board")
        );
        assert_eq!(tested.incoming_columns[0].name, "Renamed incoming");

        let mut duplicate = draft.clone();
        duplicate.incoming_column_ids.push("progress".into());
        assert!(service
            .test_mapping(&duplicate)
            .unwrap_err()
            .contains("distinct"));
        let mut deleted = draft;
        deleted.done_column_id = "other-board-list".into();
        assert!(service
            .test_mapping(&deleted)
            .unwrap_err()
            .contains("does not belong"));
        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn moves_the_exact_card_on_the_captured_board_and_list() {
        use std::fs;
        let log = env::temp_dir().join(format!("stacks-st-move-log-{}", uuid::Uuid::new_v4()));
        let script = format!(
            r#"#!/bin/sh
printf '%s\n' "$*" > '{}'
"#,
            log.display()
        );
        let (service, path) = fixture_service(&script);
        service.move_card("141", "board-7", "done-3").unwrap();
        assert_eq!(
            fs::read_to_string(&log).unwrap().trim(),
            "cards update 141 --board board-7 --list done-3"
        );
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(log);
    }

    #[cfg(unix)]
    #[test]
    fn creates_an_unassigned_card_in_the_configured_destination() {
        use std::fs;
        let log = env::temp_dir().join(format!("stacks-st-log-{}", uuid::Uuid::new_v4()));
        let script = format!(
            r#"#!/bin/sh
case "$1 $2" in
  "spaces list") echo '[{{"id":"s1","title":"Configured"}}]' ;;
  "boards list") echo '[{{"id":"b1","title":" dev - active "}}]' ;;
  "boards get") echo '{{"lists":[{{"id":"l1","title":" BACKLOG ","behavior":"backlog"}}]}}' ;;
  "cards create") printf '%s\n' "$*" > '{}'; echo '{{"id":"48","title":"ignored","list_id":"ignored","assignees":[]}}' ;;
  "users list") echo '[]' ;;
  *) echo "unexpected arguments: $*" >&2; exit 2 ;;
esac
"#,
            log.display()
        );
        let (service, path) = fixture_service(&script);

        let card = service
            .create_card(
                "b1",
                "l1",
                "  Ship card  ",
                "Detailed brief",
                Some("Example Workspace"),
            )
            .unwrap();

        assert_eq!(card.title, "Ship card");
        assert_eq!(card.content.as_deref(), Some("Detailed brief"));
        assert_eq!(card.board_id, "b1");
        assert_eq!(card.board_title, "");
        assert_eq!(card.list_id, "l1");
        assert_eq!(card.list_title, " BACKLOG ");
        assert!(card.assignee_names.is_empty());
        assert_eq!(
            card.card_url,
            "https://app.superthread.com/example-workspace/card-48"
        );
        let args = fs::read_to_string(&log).unwrap();
        assert_eq!(args.trim(), "cards create --board b1 --list l1 --title Ship card --content Detailed brief --output json");
        assert!(!args.contains("assignee"));

        service
            .create_card("b1", "l1", "No brief", "", Some("Example Workspace"))
            .unwrap();
        let args = fs::read_to_string(&log).unwrap();
        assert_eq!(
            args.trim(),
            "cards create --board b1 --list l1 --title No brief --output json"
        );

        let _ = fs::remove_file(path);
        let _ = fs::remove_file(log);
    }

    #[cfg(unix)]
    #[test]
    fn validates_the_configured_destination_before_creation() {
        use std::fs;
        let marker = env::temp_dir().join(format!("stacks-st-create-{}", uuid::Uuid::new_v4()));
        let script = format!(
            r#"#!/bin/sh
case "$1 $2" in
  "boards get") echo '{{"lists":[{{"id":"other","title":"Other"}}]}}' ;;
  "cards create") touch '{}'; echo '{{"id":"48","title":"Card","list_id":"other"}}' ;;
  *) echo "unexpected arguments: $*" >&2; exit 2 ;;
esac
"#,
            marker.display()
        );
        let (service, path) = fixture_service(&script);
        let error = service
            .create_card("b1", "missing", "Card", "", Some("test"))
            .unwrap_err();
        assert!(
            error.contains("does not belong"),
            "unexpected error: {error}"
        );
        assert!(
            !marker.exists(),
            "create command ran after validation failed"
        );
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(marker);
    }

    #[cfg(unix)]
    #[test]
    fn terminates_timed_out_processes() {
        let error = run_process(
            Path::new("/bin/sh"),
            &["-c", "sleep 1"],
            Duration::from_millis(10),
            None,
        )
        .unwrap_err();
        assert!(error.contains("timed out"));
    }
}
