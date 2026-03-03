use serde::Serialize;

#[derive(Serialize)]
struct Commit {
    id: String,
    summary: String,
    author: String,
    time: i64,
}

#[tauri::command]
fn get_commits(path: String) -> Result<Vec<Commit>, String> {
    let repo = git2::Repository::discover(&path)
        .map_err(|e| format!("Not a git repository: {}", e))?;

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push_head().map_err(|e| e.to_string())?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| e.to_string())?;

    let mut commits = Vec::new();
    for oid in revwalk.take(100) {
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        commits.push(Commit {
            id: oid.to_string(),
            summary: commit.summary().unwrap_or("").to_string(),
            author: commit.author().name().unwrap_or("Unknown").to_string(),
            time: commit.time().seconds(),
        });
    }

    Ok(commits)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_commits])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
