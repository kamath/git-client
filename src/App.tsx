import { open } from "@tauri-apps/plugin-dialog";
import { Command } from "@tauri-apps/plugin-shell";
import { atom, useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import "./App.css";

interface Commit {
	id: string;
	summary: string;
	author: string;
	time: number;
}

interface CommitFile {
	path: string;
	status: string;
}

const UNIT_SEPARATOR = "\u001f";
const MAX_RECENT_REPOS = 8;
const RECENT_REPOS_KEY = "recentRepos";
const OPEN_REPO_VALUE = "__open__";
const CLEAR_RECENTS_VALUE = "__clear_recents__";

const folderAtom = atom<string | null>(null);
const recentReposAtom = atomWithStorage<string[]>(RECENT_REPOS_KEY, []);
const addRecentRepoAtom = atom(null, (get, set, value: string) => {
	const repo = value.trim();
	if (!repo) return;

	const existing = sanitizeRecentRepos(get(recentReposAtom) ?? []);
	const next = [repo, ...existing.filter((entry) => entry !== repo)];
	set(recentReposAtom, next.slice(0, MAX_RECENT_REPOS));
});

function sanitizeRecentRepos(repos: string[]) {
	return repos
		.map((repo) => repo.trim())
		.filter(Boolean)
		.filter((repo, index, arr) => arr.indexOf(repo) === index);
}

function useLoadingState() {
	return useState({ commits: false, files: false, diff: false });
}

function formatDate(epoch: number) {
	return new Date(epoch * 1000).toLocaleString([], {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function shortSha(id: string) {
	return id.slice(0, 7);
}

function statusStyle(
	status: string,
): "default" | "secondary" | "destructive" | "outline" {
	switch (status) {
		case "Added":
			return "default";
		case "Modified":
			return "secondary";
		case "Deleted":
			return "destructive";
		case "Renamed":
			return "outline";
		default:
			return "secondary";
	}
}

function mapFileStatus(code: string): string {
	switch (code[0]) {
		case "A":
			return "Added";
		case "D":
			return "Deleted";
		case "M":
			return "Modified";
		case "R":
			return "Renamed";
		case "C":
			return "Copied";
		case "T":
			return "Type changed";
		default:
			return "Modified";
	}
}

function diffLineClass(line: string) {
	if (line.startsWith("diff --git") || line.startsWith("index ")) {
		return "text-muted-foreground";
	}

	if (line.startsWith("@@")) {
		return "text-accent-foreground";
	}

	if (line.startsWith("+++") || line.startsWith("---")) {
		return "text-muted-foreground";
	}

	if (line.startsWith("+")) {
		return "text-primary";
	}

	if (line.startsWith("-")) {
		return "text-destructive";
	}

	return "text-foreground";
}

async function runGit(path: string, args: string[]) {
	const CommandCtor = Command as unknown as {
		create?: (
			cmd: string,
			args: string[],
		) => {
			execute: () => Promise<{ code: number; stdout: string; stderr: string }>;
		};
	};

	const CommandConstructor = Command as unknown as {
		new (
			cmd: string,
			args: string[],
		): {
			execute: () => Promise<{ code: number; stdout: string; stderr: string }>;
		};
	};

	const command =
		typeof CommandCtor.create === "function"
			? CommandCtor.create("git", ["-C", path, ...args])
			: new CommandConstructor("git", ["-C", path, ...args]);

	const result = await command.execute();

	if (result.code !== 0) {
		const message =
			(result.stderr || "command failed").trim() ||
			`Git command failed with ${result.code}`;
		throw new Error(message);
	}

	return result.stdout;
}

async function getCommits(path: string): Promise<Commit[]> {
	const output = await runGit(path, [
		"log",
		"--max-count=100",
		"--date=unix",
		"--pretty=format:%H\u001f%an\u001f%ct\u001f%s",
	]);

	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const parts = line.split(UNIT_SEPARATOR);
			if (parts.length < 4) {
				return null;
			}
			const [id, author, epoch, ...summaryParts] = parts;
			return {
				id,
				author,
				time: Number.parseInt(epoch || "0", 10),
				summary: summaryParts.join(UNIT_SEPARATOR),
			};
		})
		.filter((value): value is Commit => value !== null);
}

async function getCommitFiles(
	path: string,
	commitId: string,
): Promise<CommitFile[]> {
	const output = await runGit(path, [
		"diff-tree",
		"--no-commit-id",
		"--name-status",
		"-r",
		commitId,
	]);

	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const parts = line.split("\t");
			if (parts.length < 2) return null;

			const statusCode = parts[0];
			const filePath =
				statusCode[0] === "R" || statusCode[0] === "C"
					? parts[2] || parts[1]
					: parts[1];

			return {
				path: filePath,
				status: mapFileStatus(statusCode),
			};
		})
		.filter((value): value is CommitFile => value !== null);
}

async function getCommitFileDiff(
	path: string,
	commitId: string,
	filePath: string,
): Promise<string> {
	const output = await runGit(path, [
		"show",
		"--no-color",
		commitId,
		"--",
		filePath,
	]);
	return output || `No diff available for ${filePath}`;
}

function App() {
	const [commits, setCommits] = useState<Commit[]>([]);
	const [folder, setFolder] = useAtom(folderAtom);
	const [recentRepos, setRecentRepos] = useAtom(recentReposAtom);
	const [, addRecentRepo] = useAtom(addRecentRepoAtom);
	const [error, setError] = useState<string | null>(null);
	const [selectedCommit, setSelectedCommit] = useState<Commit | null>(null);
	const [commitFiles, setCommitFiles] = useState<CommitFile[]>([]);
	const [selectedFile, setSelectedFile] = useState<CommitFile | null>(null);
	const [diff, setDiff] = useState("");
	const [loading, setLoading] = useLoadingState();

	const diffLines = useMemo(() => {
		if (!diff) return [];
		return diff.replace(/\n$/, "").split("\n");
	}, [diff]);
	const diffLinesWithKeys = useMemo(() => {
		const seen: Record<string, number> = {};
		return diffLines.map((line) => {
			const count = (seen[line] ?? 0) + 1;
			seen[line] = count;

			return {
				line,
				key: `${selectedFile?.path ?? ""}:${line.length}:${count}`,
			};
		});
	}, [diffLines, selectedFile?.path]);

	const normalizedRecentRepos = useMemo(
		() => sanitizeRecentRepos(recentRepos),
		[recentRepos],
	);

	const loadRepository = useCallback(
		async (selected: string, remember = true) => {
			const repo = selected.trim();
			if (!repo) return;

			setFolder(repo);
			setSelectedCommit(null);
			setSelectedFile(null);
			setCommitFiles([]);
			setDiff("");
			setError(null);

			if (remember) {
				addRecentRepo(repo);
			}

			setLoading((state) => ({ ...state, commits: true }));

			try {
				const result = await getCommits(selected);
				setCommits(result);
			} catch (e) {
				setError(String(e));
				setCommits([]);
			} finally {
				setLoading((state) => ({ ...state, commits: false }));
			}
		},
		[addRecentRepo, setFolder, setLoading],
	);

	useEffect(() => {
		const initialRepo = normalizedRecentRepos[0];
		if (!folder && initialRepo) {
			void loadRepository(initialRepo, false);
		}
	}, [folder, normalizedRecentRepos, loadRepository]);

	async function selectFolder() {
		const selected = await open({ directory: true });
		if (!selected) return;

		await loadRepository(selected);
	}

	async function selectRecentFolder(selected: string) {
		if (selected === OPEN_REPO_VALUE) {
			await selectFolder();
			return;
		}
		if (selected === CLEAR_RECENTS_VALUE) {
			const ok = window.confirm(
				`Clear all ${normalizedRecentRepos.length} recent repositories? This cannot be undone.`,
			);
			if (!ok) return;

			setRecentRepos([]);
			setFolder(null);
			setSelectedCommit(null);
			setSelectedFile(null);
			setCommitFiles([]);
			setDiff("");
			setError(null);
			setCommits([]);
			return;
		}

		if (selected !== folder) {
			await loadRepository(selected);
		}
	}

	async function loadCommitFiles(commit: Commit) {
		if (!folder) return;

		setSelectedCommit(commit);
		setSelectedFile(null);
		setDiff("");
		setError(null);
		setLoading((state) => ({ ...state, files: true, diff: false }));

		try {
			const files = await getCommitFiles(folder, commit.id);
			setCommitFiles(files);
		} catch (e) {
			setError(String(e));
			setCommitFiles([]);
		} finally {
			setLoading((state) => ({ ...state, files: false }));
		}
	}

	async function loadFileDiff(file: CommitFile) {
		if (!folder || !selectedCommit) return;

		setSelectedFile(file);
		setDiff("");
		setError(null);
		setLoading((state) => ({ ...state, diff: true }));

		try {
			const patch = await getCommitFileDiff(
				folder,
				selectedCommit.id,
				file.path,
			);
			setDiff(patch);
		} catch (e) {
			setError(String(e));
			setDiff(String(e));
		} finally {
			setLoading((state) => ({ ...state, diff: false }));
		}
	}

	return (
		<main className="h-screen min-h-screen overflow-hidden bg-background text-foreground">
			<div className="mx-auto flex h-full w-full flex-col">
				<Card>
					<CardHeader>
						<CardTitle className="text-xl">
							GitHub Desktop-style Commit Browser
						</CardTitle>
						<CardDescription>
							Open a repository, pick a commit, pick a file, then inspect the
							diff.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="w-full">
							<Select value={folder ?? ""} onValueChange={selectRecentFolder}>
								<SelectTrigger className="w-full md:max-w-[30rem]">
									<SelectValue placeholder="Open repository" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={OPEN_REPO_VALUE}>
										Open repository...
									</SelectItem>
									<SelectSeparator />
									{normalizedRecentRepos.map((repo) => (
										<SelectItem key={repo} value={repo}>
											{repo}
										</SelectItem>
									))}
									<SelectSeparator />
									<SelectItem value={CLEAR_RECENTS_VALUE}>
										<span className="text-destructive">
											Clear recent repositories
										</span>
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</CardContent>
				</Card>

				{error && (
					<Card className="border-destructive/50">
						<CardContent className="text-sm text-destructive">
							{error}
						</CardContent>
					</Card>
				)}

				<ResizablePanelGroup className="min-h-0 flex-1 overflow-hidden">
					<ResizablePanel
						defaultSize={30}
						minSize={20}
						className="min-h-0 overflow-hidden"
					>
						<Card className="h-full min-h-0">
							<CardHeader>
								<CardTitle className="text-sm">Commits</CardTitle>
								<CardDescription>
									{commits.length > 0
										? `${commits.length} commits loaded`
										: "Select a repository to load commits"}
								</CardDescription>
							</CardHeader>
							<Separator />
							<CardContent className="flex-1 min-h-0 overflow-hidden p-0">
								<ScrollArea className="h-full min-h-0 overflow-y-auto">
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
															selectedCommit?.id === commit.id && "bg-muted",
														)}
													>
														<TableCell className="font-mono text-xs">
															{shortSha(commit.id)}
														</TableCell>
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
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={25}
						minSize={16}
						className="min-h-0 overflow-hidden"
					>
						<Card className="h-full min-h-0">
							<CardHeader>
								<CardTitle className="text-sm">Changed files</CardTitle>
								<CardDescription>
									{selectedCommit
										? `Commit ${shortSha(selectedCommit.id)} · ${selectedCommit.summary}`
										: "Select a commit to list changed files"}
								</CardDescription>
							</CardHeader>
							<Separator />
							<CardContent className="flex-1 min-h-0 overflow-hidden p-0">
								{loading.files ? (
									<div className="px-4 py-3 text-sm text-muted-foreground">
										Loading changed files...
									</div>
								) : !selectedCommit ? (
									<div className="px-4 py-3 text-sm text-muted-foreground">
										No commit selected.
									</div>
								) : commitFiles.length === 0 ? (
									<div className="px-4 py-3 text-sm text-muted-foreground">
										This commit has no changed files.
									</div>
								) : (
									<ScrollArea className="h-full min-h-0 overflow-y-auto">
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
															selectedFile?.path === file.path && "bg-muted",
														)}
													>
														<TableCell className="max-w-56 truncate text-sm">
															{file.path}
														</TableCell>
														<TableCell>
															<Badge variant={statusStyle(file.status)}>
																{file.status}
															</Badge>
														</TableCell>
													</TableRow>
												))}
											</TableBody>
										</Table>
									</ScrollArea>
								)}
							</CardContent>
						</Card>
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={45}
						minSize={20}
						className="min-h-0 overflow-hidden"
					>
						<Card className="h-full min-h-0">
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
							<CardContent className="flex-1 min-h-0 overflow-hidden p-0">
								<ScrollArea className="h-full min-h-0 overflow-y-auto">
									{loading.diff ? (
										<div className="px-4 py-3 text-sm text-muted-foreground">
											Loading file diff...
										</div>
									) : !selectedFile ? (
										<div className="px-4 py-3 text-sm text-muted-foreground">
											No file selected.
										</div>
									) : (
										<pre className="min-h-full p-4 text-xs leading-6">
											{diffLines.length === 0 ? (
												<span className="text-muted-foreground">
													No diff content available.
												</span>
											) : (
												diffLinesWithKeys.map((lineItem) => (
													<div
														key={lineItem.key}
														className={cn(
															"whitespace-pre-wrap font-mono",
															diffLineClass(lineItem.line),
														)}
													>
														{lineItem.line || "\u00A0"}
													</div>
												))
											)}
										</pre>
									)}
								</ScrollArea>
							</CardContent>
						</Card>
					</ResizablePanel>
				</ResizablePanelGroup>
			</div>
		</main>
	);
}

export default App;
