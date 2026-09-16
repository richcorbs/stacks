use ignore::WalkBuilder;
use serde::Serialize;
use std::path::{Component, Path};

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 100;
const MAX_VISITED: usize = 50_000;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PiPathSuggestion {
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn discover_pi_paths(
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<PiPathSuggestion>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        discover(&root, &query, limit.unwrap_or(DEFAULT_LIMIT))
    })
    .await
    .map_err(|error| format!("Path discovery task failed: {error}"))?
}

fn discover(root: &str, query: &str, limit: usize) -> Result<Vec<PiPathSuggestion>, String> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|error| format!("Could not access Pi working directory: {error}"))?;
    if !canonical_root.is_dir() {
        return Err("Pi working directory is not a directory".to_string());
    }
    validate_query(query)?;
    let normalized_query = query.replace('\\', "/").to_lowercase();
    let limit = limit.clamp(1, MAX_LIMIT);
    let mut matches = Vec::new();

    let walker = WalkBuilder::new(&canonical_root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build();

    for entry in walker.skip(1).take(MAX_VISITED) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Some(file_type) => file_type,
            None => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let canonical = match std::fs::canonicalize(entry.path()) {
            Ok(path) => path,
            Err(_) => continue,
        };
        if !canonical.starts_with(&canonical_root) {
            continue;
        }
        let relative = match entry.path().strip_prefix(&canonical_root) {
            Ok(path) => path,
            Err(_) => continue,
        };
        let display = relative.to_string_lossy().replace('\\', "/");
        if let Some(score) = fuzzy_path_score(&display.to_lowercase(), &normalized_query) {
            matches.push((score, display, file_type.is_dir()));
        }
    }

    matches.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| right.2.cmp(&left.2))
            .then_with(|| left.1.to_lowercase().cmp(&right.1.to_lowercase()))
    });
    Ok(matches
        .into_iter()
        .take(limit)
        .map(|(_, path, is_dir)| PiPathSuggestion { path, is_dir })
        .collect())
}

fn validate_query(query: &str) -> Result<(), String> {
    let path = Path::new(query);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Path query must stay within the Pi working directory".to_string());
    }
    Ok(())
}

fn fuzzy_path_score(candidate: &str, query: &str) -> Option<(u8, usize, usize)> {
    if query.is_empty() {
        return Some((0, candidate.matches('/').count(), candidate.len()));
    }
    if candidate.starts_with(query) {
        return Some((0, candidate.len() - query.len(), candidate.len()));
    }
    if let Some(index) = candidate.rfind(query) {
        return Some((1, index, candidate.len()));
    }
    let mut search_from = 0;
    let mut previous_character_index = None;
    let mut gaps = 0;
    for character in query.chars() {
        let (offset, matched) = candidate[search_from..]
            .char_indices()
            .find(|(_, candidate_character)| *candidate_character == character)?;
        let byte_index = search_from + offset;
        let character_index = candidate[..byte_index].chars().count();
        gaps += previous_character_index
            .map_or(character_index, |previous| character_index - previous - 1);
        previous_character_index = Some(character_index);
        search_from = byte_index + matched.len_utf8();
    }
    Some((2, gaps, candidate.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "stacks-pi-paths-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn includes_hidden_files_and_directories_but_respects_gitignore_and_git_internals() {
        let fixture = Fixture::new();
        fs::write(
            fixture.path().join(".gitignore"),
            "ignored.txt\nignored-dir/\n",
        )
        .unwrap();
        fs::write(fixture.path().join(".hidden"), "hidden").unwrap();
        fs::create_dir(fixture.path().join("docs")).unwrap();
        fs::write(fixture.path().join("docs/readme.md"), "readme").unwrap();
        fs::write(fixture.path().join("ignored.txt"), "ignored").unwrap();
        fs::create_dir(fixture.path().join("ignored-dir")).unwrap();
        fs::write(fixture.path().join("ignored-dir/a"), "ignored").unwrap();
        fs::create_dir(fixture.path().join(".git")).unwrap();
        fs::write(fixture.path().join(".git/config"), "git").unwrap();

        let paths = discover(fixture.path().to_str().unwrap(), "", 100).unwrap();
        assert!(paths.contains(&PiPathSuggestion {
            path: ".hidden".into(),
            is_dir: false
        }));
        assert!(paths.contains(&PiPathSuggestion {
            path: "docs".into(),
            is_dir: true
        }));
        assert!(paths.contains(&PiPathSuggestion {
            path: "docs/readme.md".into(),
            is_dir: false
        }));
        assert!(!paths
            .iter()
            .any(|item| item.path.contains("ignored") || item.path.starts_with(".git/")));
    }

    #[test]
    fn rejects_traversal_and_bounds_results() {
        let fixture = Fixture::new();
        for index in 0..10 {
            fs::write(fixture.path().join(format!("file-{index}")), "x").unwrap();
        }
        assert!(discover(fixture.path().to_str().unwrap(), "../outside", 10).is_err());
        assert_eq!(
            discover(fixture.path().to_str().unwrap(), "file", 3)
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn fuzzy_matching_handles_unicode_paths() {
        assert!(fuzzy_path_score("docs/café.md", "cé").is_some());
        assert!(fuzzy_path_score("日本語.md", "日語").is_some());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_include_symlinks_that_leave_the_root() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        symlink(std::env::temp_dir(), fixture.path().join("outside-link")).unwrap();
        assert!(!discover(fixture.path().to_str().unwrap(), "outside", 10)
            .unwrap()
            .iter()
            .any(|item| item.path == "outside-link"));
    }
}
