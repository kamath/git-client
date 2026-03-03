import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

interface Commit {
  id: string;
  summary: string;
  author: string;
  time: number;
}

function App() {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function selectFolder() {
    const selected = await open({ directory: true });
    if (!selected) return;

    setFolder(selected);
    setError(null);
    setLoading(true);
    try {
      const result = await invoke<Commit[]>("get_commits", { path: selected });
      setCommits(result);
    } catch (e) {
      setError(String(e));
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }

  function formatDate(epoch: number) {
    return new Date(epoch * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <main className="container">
      <h1>Git Commit Viewer</h1>
      <button className="select-folder" onClick={selectFolder}>
        {folder ? "Change Folder" : "Select a Git Repository"}
      </button>
      {folder && <p className="folder-path">{folder}</p>}
      {loading && <p>Loading commits...</p>}
      {error && <p className="error">{error}</p>}
      {commits.length > 0 && (
        <div className="commit-list">
          {commits.map((c) => (
            <div key={c.id} className="commit-row">
              <div className="commit-info">
                <span className="commit-summary">{c.summary}</span>
                <span className="commit-meta">
                  {c.author} &middot; {formatDate(c.time)}
                </span>
              </div>
              <code className="commit-hash">{c.id.slice(0, 7)}</code>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

export default App;
