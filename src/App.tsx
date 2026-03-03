import { useMemo, useState } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { Command } from "@tauri-apps/plugin-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import "./App.css"

interface Commit {
  id: string
  summary: string
  author: string
  time: number
}

interface CommitFile {
  path: string
  status: string
}

const UNIT_SEPARATOR = "\u001f"

function useLoadingState() {
  return useState({ commits: false, files: false, diff: false })
}

function formatDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function shortSha(id: string) {
  return id.slice(0, 7)
}

function statusStyle(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "Added":
      return "default"
    case "Modified":
      return "secondary"
    case "Deleted":
      return "destructive"
    case "Renamed":
      return "outline"
    default:
      return "secondary"
  }
}

function mapFileStatus(code: string): string {
  switch (code[0]) {
    case "A":
      return "Added"
    case "D":
      return "Deleted"
    case "M":
      return "Modified"
    case "R":
      return "Renamed"
    case "C":
      return "Copied"
    case "T":
      return "Type changed"
    default:
      return "Modified"
  }
}

function diffLineClass(line: string) {
  if (line.startsWith("diff --git") || line.startsWith("index ")) {
    return "text-muted-foreground"
  }

  if (line.startsWith("@@")) {
    return "text-accent-foreground"
  }

  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-muted-foreground"
  }

  if (line.startsWith("+")) {
    return "text-primary"
  }

  if (line.startsWith("-")) {
    return "text-destructive"
  }

  return "text-foreground"
}

async function runGit(path: string, args: string[]) {
  const CommandCtor = Command as unknown as {
    create?: (cmd: string, args: string[]) => {
      execute: () => Promise<{ code: number; stdout: string; stderr: string }>
    }
  }

  const CommandConstructor = Command as unknown as {
    new (cmd: string, args: string[]): {
      execute: () => Promise<{ code: number; stdout: string; stderr: string }>
    }
  }

  const command = typeof CommandCtor.create === "function"
    ? CommandCtor.create("git", ["-C", path, ...args])
    : new CommandConstructor("git", ["-C", path, ...args])

  const result = await command.execute()

  if (result.code !== 0) {
    const message = (result.stderr || "command failed").trim() || `Git command failed with ${result.code}`
    throw new Error(message)
  }

  return result.stdout
}

async function getCommits(path: string): Promise<Commit[]> {
  const output = await runGit(
    path,
    [
      "log",
      "--max-count=100",
      "--date=unix",
      "--pretty=format:%H\u001f%an\u001f%ct\u001f%s",
    ]
  )

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(UNIT_SEPARATOR)
      if (parts.length < 4) {
        return null
      }
      const [id, author, epoch, ...summaryParts] = parts
      return {
        id,
        author,
        time: Number.parseInt(epoch || "0", 10),
        summary: summaryParts.join(UNIT_SEPARATOR),
      }
    })
    .filter((value): value is Commit => value !== null)
}

async function getCommitFiles(path: string, commitId: string): Promise<CommitFile[]> {
  const output = await runGit(
    path,
    ["diff-tree", "--no-commit-id", "--name-status", "-r", commitId]
  )

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t")
      if (parts.length < 2) return null

      const statusCode = parts[0]
      const filePath =
        statusCode[0] === "R" || statusCode[0] === "C" ? parts[2] || parts[1] : parts[1]

      return {
        path: filePath,
        status: mapFileStatus(statusCode),
      }
    })
    .filter((value): value is CommitFile => value !== null)
}

async function getCommitFileDiff(path: string, commitId: string, filePath: string): Promise<string> {
  const output = await runGit(path, ["show", "--no-color", commitId, "--", filePath])
  return output || `No diff available for ${filePath}`
}

function App() {
  const [commits, setCommits] = useState<Commit[]>([])
  const [folder, setFolder] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedCommit, setSelectedCommit] = useState<Commit | null>(null)
  const [commitFiles, setCommitFiles] = useState<CommitFile[]>([])
  const [selectedFile, setSelectedFile] = useState<CommitFile | null>(null)
  const [diff, setDiff] = useState("")
  const [loading, setLoading] = useLoadingState()

  const diffLines = useMemo(() => {
    if (!diff) return []
    return diff.replace(/\n$/, "").split("\n")
  }, [diff])

  async function selectFolder() {
    const selected = await open({ directory: true })
    if (!selected) return

    setFolder(selected)
    setSelectedCommit(null)
    setSelectedFile(null)
    setCommitFiles([])
    setDiff("")
    setError(null)
    setLoading((state) => ({ ...state, commits: true }))

    try {
      const result = await getCommits(selected)
      setCommits(result)
    } catch (e) {
      setError(String(e))
      setCommits([])
    } finally {
      setLoading((state) => ({ ...state, commits: false }))
    }
  }

  async function loadCommitFiles(commit: Commit) {
    if (!folder) return

    setSelectedCommit(commit)
    setSelectedFile(null)
    setDiff("")
    setError(null)
    setLoading((state) => ({ ...state, files: true, diff: false }))

    try {
      const files = await getCommitFiles(folder, commit.id)
      setCommitFiles(files)
    } catch (e) {
      setError(String(e))
      setCommitFiles([])
    } finally {
      setLoading((state) => ({ ...state, files: false }))
    }
  }

  async function loadFileDiff(file: CommitFile) {
    if (!folder || !selectedCommit) return

    setSelectedFile(file)
    setDiff("")
    setError(null)
    setLoading((state) => ({ ...state, diff: true }))

    try {
      const patch = await getCommitFileDiff(folder, selectedCommit.id, file.path)
      setDiff(patch)
    } catch (e) {
      setError(String(e))
      setDiff(String(e))
    } finally {
      setLoading((state) => ({ ...state, diff: false }))
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-4 p-4 md:p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">GitHub Desktop-style Commit Browser</CardTitle>
            <CardDescription>
              Open a repository, pick a commit, pick a file, then inspect the diff.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <p className="text-sm text-muted-foreground">
                {folder
                  ? `Repository: ${folder}`
                  : "No repository selected yet"}
              </p>
              <Button variant="outline" onClick={selectFolder}>
                {folder ? "Change repository" : "Open repository"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {error && (
          <Card className="border-destructive/50">
            <CardContent className="text-sm text-destructive">{error}</CardContent>
          </Card>
        )}

        <div className="grid gap-4 lg:grid-cols-[360px_360px_1fr]">
          <Card className="min-h-0">
            <CardHeader>
              <CardTitle className="text-sm">Commits</CardTitle>
              <CardDescription>
                {commits.length > 0
                  ? `${commits.length} commits loaded`
                  : "Select a repository to load commits"}
              </CardDescription>
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              <ScrollArea className="h-[62vh]">
                {loading.commits ? (
                  <div className="px-4 py-3 text-sm text-muted-foreground">
                    Loading commit history...
                  </div>
                ) : commits.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-muted-foreground">
                    No commits to show yet.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">SHA</TableHead>
                        <TableHead>Summary</TableHead>
                        <TableHead>Author</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {commits.map((commit) => (
                        <TableRow
                          key={commit.id}
                          onClick={() => loadCommitFiles(commit)}
                          className={cn(
                            "cursor-pointer",
                            selectedCommit?.id === commit.id && "bg-muted"
                          )}
                        >
                          <TableCell className="font-mono text-xs">{shortSha(commit.id)}</TableCell>
                          <TableCell className="max-w-48 truncate">
                            {commit.summary || "(no message)"}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            <div className="flex max-w-28 flex-col gap-1 truncate">
                              <span>{commit.author}</span>
                              <span>{formatDate(commit.time)}</span>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="min-h-0">
            <CardHeader>
              <CardTitle className="text-sm">Changed files</CardTitle>
              <CardDescription>
                {selectedCommit
                  ? `Commit ${shortSha(selectedCommit.id)} · ${selectedCommit.summary}`
                  : "Select a commit to list changed files"}
              </CardDescription>
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              {loading.files ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">Loading changed files...</div>
              ) : !selectedCommit ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">No commit selected.</div>
              ) : commitFiles.length === 0 ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">This commit has no changed files.</div>
              ) : (
                <ScrollArea className="h-[62vh]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>File</TableHead>
                        <TableHead className="w-24">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {commitFiles.map((file) => (
                        <TableRow
                          key={file.path}
                          onClick={() => loadFileDiff(file)}
                          className={cn(
                            "cursor-pointer",
                            selectedFile?.path === file.path && "bg-muted"
                          )}
                        >
                          <TableCell className="max-w-56 truncate text-sm">
                            {file.path}
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusStyle(file.status)}>{file.status}</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              )}
            </CardContent>
          </Card>

          <Card className="min-h-0">
            <CardHeader>
              <CardTitle className="text-sm">Diff</CardTitle>
              <CardDescription>
                {selectedFile
                  ? `${selectedFile.path}`
                  : selectedCommit
                    ? "Select a file from the middle panel"
                    : "Select a commit first"}
              </CardDescription>
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              <ScrollArea className="h-[62vh]">
                {loading.diff ? (
                  <div className="px-4 py-3 text-sm text-muted-foreground">Loading file diff...</div>
                ) : !selectedFile ? (
                  <div className="px-4 py-3 text-sm text-muted-foreground">No file selected.</div>
                ) : (
                  <pre className="min-h-full p-4 text-xs leading-6">
                    {diffLines.length === 0 ? (
                      <span className="text-muted-foreground">No diff content available.</span>
                    ) : (
                      <>
                        {diffLines.map((line, index) => (
                          <div
                            key={`${selectedFile.path}-${index}`}
                            className={cn("whitespace-pre-wrap font-mono", diffLineClass(line))}
                          >
                            {line || "\u00A0"}
                          </div>
                        ))}
                      </>
                    )}
                  </pre>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}

export default App
