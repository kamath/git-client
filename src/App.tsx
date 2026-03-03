import { useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { Command } from "@tauri-apps/plugin-shell";
import { atom, useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/ui/tabs";
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

type CommitTab = "changes" | "history";

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
		case "Untracked":
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

function mapWorkingTreeFileStatus(code: string): string {
	switch (code) {
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
		case "?":
			return "Untracked";
		case "U":
			return "Unmerged";
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

async function getWorkingTreeFiles(path: string): Promise<CommitFile[]> {
	const output = await runGit(path, [
		"status",
		"--short",
		"--untracked-files=normal",
	]);

	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			if (line.length < 3) return null;

			const statusCode = line.slice(0, 2);
			const filePath = line.slice(3);
			if (!filePath) return null;

			if (statusCode === "??") {
				return {
					path: filePath,
					status: mapWorkingTreeFileStatus("?"),
				};
			}

			if (statusCode[1] === " ") {
				return null;
			}

			return {
				path: filePath,
				status: mapWorkingTreeFileStatus(statusCode[1]),
			};
		})
		.filter((value): value is CommitFile => value !== null);
}

async function getWorkingTreeFileDiff(
	path: string,
	file: CommitFile,
): Promise<string> {
	if (file.status === "Untracked") {
		const output = await runGit(path, [
			"diff",
			"--no-index",
			"--no-color",
			"--",
			"/dev/null",
			file.path,
		]);
		return output || `No diff available for ${file.path}`;
	}

	const output = await runGit(path, ["diff", "--no-color", "--", file.path]);
	return output || `No diff available for ${file.path}`;
}

function errorMessage(error: unknown) {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function App() {
	const [folder, setFolder] = useAtom(folderAtom);
	const [recentRepos, setRecentRepos] = useAtom(recentReposAtom);
	const [, addRecentRepo] = useAtom(addRecentRepoAtom);
	const [selectedCommit, setSelectedCommit] = useState<Commit | null>(null);
	const [activeCommitTab, setActiveCommitTab] = useState<CommitTab>("history");
	const [selectedCommitFile, setSelectedCommitFile] =
		useState<CommitFile | null>(null);
	const [selectedWorkingTreeFile, setSelectedWorkingTreeFile] =
		useState<CommitFile | null>(null);

	const commitsQuery = useQuery({
		queryKey: ["commits", folder],
		queryFn: () => getCommits(folder || ""),
		enabled: Boolean(folder),
		retry: 1,
	});

	const commitFilesQuery = useQuery({
		queryKey: ["commit-files", folder, selectedCommit?.id],
		queryFn: () => getCommitFiles(folder || "", selectedCommit!.id),
		enabled: Boolean(folder && selectedCommit),
		retry: 1,
	});

	const commitFileDiffQuery = useQuery({
		queryKey: [
			"commit-file-diff",
			folder,
			selectedCommit?.id,
			selectedCommitFile?.path,
		],
		queryFn: () =>
			getCommitFileDiff(
				folder || "",
				selectedCommit!.id,
				selectedCommitFile!.path,
			),
		enabled: Boolean(folder && selectedCommit && selectedCommitFile),
		retry: 1,
	});

	const workingTreeFilesQuery = useQuery({
		queryKey: ["working-tree-files", folder],
		queryFn: () => getWorkingTreeFiles(folder || ""),
		enabled: Boolean(folder),
		retry: 1,
	});

	const workingTreeFileDiffQuery = useQuery({
		queryKey: ["working-tree-file-diff", folder, selectedWorkingTreeFile?.path],
		queryFn: () => getWorkingTreeFileDiff(folder || "", selectedWorkingTreeFile!),
		enabled: Boolean(
			folder && activeCommitTab === "changes" && selectedWorkingTreeFile,
		),
		retry: 1,
	});

	const commits = commitsQuery.data ?? [];
	const commitFiles = commitFilesQuery.data ?? [];
	const workingTreeFiles = workingTreeFilesQuery.data ?? [];
	const diff =
		activeCommitTab === "changes"
			? workingTreeFileDiffQuery.data ?? ""
			: commitFileDiffQuery.data ?? "";
	const activeSelectedFile =
		activeCommitTab === "history" ? selectedCommitFile : selectedWorkingTreeFile;
	const fileDiffIsError =
		activeCommitTab === "history"
			? commitFileDiffQuery.isError
			: workingTreeFileDiffQuery.isError;
	const fileDiffIsLoading =
		activeCommitTab === "history"
			? commitFileDiffQuery.isFetching
			: workingTreeFileDiffQuery.isFetching;
	const refetchFileDiff = activeCommitTab === "history"
		? () => commitFileDiffQuery.refetch()
		: () => workingTreeFileDiffQuery.refetch();

	const commitsError =
		folder && commitsQuery.error ? errorMessage(commitsQuery.error) : null;
	const commitFilesError =
		folder && selectedCommit && commitFilesQuery.error
			? errorMessage(commitFilesQuery.error)
			: null;
	const workingTreeFilesError =
		folder && workingTreeFilesQuery.error
			? errorMessage(workingTreeFilesQuery.error)
			: null;
	const commitFileDiffError =
		folder && selectedCommit && selectedCommitFile && commitFileDiffQuery.error
			? errorMessage(commitFileDiffQuery.error)
			: null;
	const workingTreeFileDiffError =
		folder &&
		activeCommitTab === "changes" &&
		selectedWorkingTreeFile &&
		workingTreeFileDiffQuery.error
			? errorMessage(workingTreeFileDiffQuery.error)
			: null;

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
				key: `${activeSelectedFile?.path ?? ""}:${line.length}:${count}`,
			};
		});
	}, [diffLines, activeSelectedFile?.path]);

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
			setSelectedCommitFile(null);
			setSelectedWorkingTreeFile(null);
			setActiveCommitTab("history");

			if (remember) {
				addRecentRepo(repo);
			}
		},
		[addRecentRepo, setFolder],
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
			setSelectedCommitFile(null);
			setSelectedWorkingTreeFile(null);
			setActiveCommitTab("history");
			return;
		}

		if (selected !== folder) {
			await loadRepository(selected);
		}
	}

	function loadCommitFiles(commit: Commit) {
		setSelectedCommit(commit);
		setSelectedCommitFile(null);
		setSelectedWorkingTreeFile(null);
		setActiveCommitTab("history");
	}

	function setModeAndClearSelections(mode: CommitTab) {
		setActiveCommitTab(mode);
		if (mode === "history") {
			setSelectedWorkingTreeFile(null);
			return;
		}
		setSelectedCommit(null);
		setSelectedCommitFile(null);
	}

	function loadCommitFileDiff(file: CommitFile) {
		setSelectedCommitFile(file);
		setSelectedWorkingTreeFile(null);
		setActiveCommitTab("history");
	}

	function loadWorkingTreeFileDiff(file: CommitFile) {
		setSelectedWorkingTreeFile(file);
		setSelectedCommitFile(null);
		setActiveCommitTab("changes");
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

				{(
						commitsError ||
						commitFilesError ||
						workingTreeFilesError ||
						commitFileDiffError ||
						workingTreeFileDiffError
					) && (
					<Card className="border-destructive/50">
						<CardContent className="text-sm text-destructive">
							{commitsError ||
								commitFilesError ||
								workingTreeFilesError ||
								commitFileDiffError ||
								workingTreeFileDiffError}
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
								<CardDescription>Switch between Changes and History</CardDescription>
							</CardHeader>
							<Separator />
							<CardContent className="flex min-h-0 flex-1 overflow-hidden p-0">
								<Tabs
									value={activeCommitTab}
									onValueChange={(value) =>
										setModeAndClearSelections(value as CommitTab)
									}
									className="flex min-h-0 flex-1 flex-col"
								>
									<div className="px-4 py-2">
										<TabsList className="w-full justify-start">
											<TabsTrigger value="changes">Changes</TabsTrigger>
											<TabsTrigger value="history">History</TabsTrigger>
										</TabsList>
									</div>
									<TabsContent value="changes" className="min-h-0 flex-1">
										{workingTreeFilesQuery.isError ? (
											<div className="px-4 py-3 text-sm text-destructive">
												<div className="mb-2">Failed to load unstaged files.</div>
												<Button
													size="sm"
													variant="outline"
													onClick={() => workingTreeFilesQuery.refetch()}
													disabled={workingTreeFilesQuery.isFetching}
												>
													Retry
												</Button>
											</div>
										) : workingTreeFilesQuery.isFetching ? (
											<div className="px-4 py-3 text-sm text-muted-foreground">
												Loading unstaged files...
											</div>
										) : !folder ? (
											<div className="px-4 py-3 text-sm text-muted-foreground">
												Select a repository first.
											</div>
										) : workingTreeFiles.length === 0 ? (
											<div className="px-4 py-3 text-sm text-muted-foreground">
												No unstaged files.
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
														{workingTreeFiles.map((file) => (
															<TableRow
																key={file.path}
																onClick={() => loadWorkingTreeFileDiff(file)}
																className={cn(
																	"cursor-pointer",
																	selectedWorkingTreeFile?.path === file.path &&
																		"bg-muted",
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
									</TabsContent>
									<TabsContent value="history" className="min-h-0 flex-1">
										{commitsQuery.isError ? (
											<div className="px-4 py-3 text-sm text-destructive">
												<div className="mb-2">Failed to load commits.</div>
												<Button
													size="sm"
													variant="outline"
													onClick={() => commitsQuery.refetch()}
													disabled={commitsQuery.isFetching}
												>
													Retry
												</Button>
											</div>
										) : commitsQuery.isFetching ? (
											<div className="px-4 py-3 text-sm text-muted-foreground">
												Loading commit history...
											</div>
										) : commits.length === 0 ? (
											<div className="px-4 py-3 text-sm text-muted-foreground">
												No commits to show yet.
											</div>
										) : (
											<ScrollArea className="h-full min-h-0 overflow-y-auto">
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
											</ScrollArea>
										)}
									</TabsContent>
								</Tabs>
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
								<CardTitle className="text-sm">
									{activeCommitTab === "history"
										? "Commit files"
										: "Unstaged file"}
								</CardTitle>
								<CardDescription>
									{activeCommitTab === "history"
										? selectedCommit
											? `Commit ${shortSha(selectedCommit.id)} · ${selectedCommit.summary}`
											: "Select a commit to list changed files"
										: selectedWorkingTreeFile
											? `${selectedWorkingTreeFile.path} · ${selectedWorkingTreeFile.status}`
											: "Select a file in Changes to inspect diff"}
								</CardDescription>
							</CardHeader>
							<Separator />
							<CardContent className="flex min-h-0 flex-1 overflow-hidden p-0">
								{activeCommitTab === "history" ? (
									<>
										{commitFilesQuery.isError ? (
											<div className="px-4 py-3 text-sm text-destructive">
												<div className="mb-2">Failed to load changed files.</div>
												<Button
													size="sm"
													variant="outline"
													onClick={() => commitFilesQuery.refetch()}
													disabled={commitFilesQuery.isFetching}
												>
													Retry
												</Button>
											</div>
										) : commitFilesQuery.isFetching ? (
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
																onClick={() => loadCommitFileDiff(file)}
																className={cn(
																	"cursor-pointer",
																	selectedCommitFile?.path === file.path &&
																		"bg-muted",
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
									</>
								) : (
									<div className="flex h-full items-center px-4 py-3 text-sm text-muted-foreground">
										Select a file in Changes to inspect its diff on the right.
									</div>
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
									{activeSelectedFile
										? `${activeSelectedFile.path}`
										: activeCommitTab === "history"
											? selectedCommit
												? "Select a file from the middle panel"
												: "Select a commit first"
											: "Select a working-tree file"}
								</CardDescription>
							</CardHeader>
							<Separator />
							<CardContent className="flex-1 min-h-0 overflow-hidden p-0">
								<ScrollArea className="h-full min-h-0 overflow-y-auto">
									{fileDiffIsError ? (
										<div className="px-4 py-3 text-sm text-destructive">
											<div className="mb-2">Failed to load file diff.</div>
											<Button
												size="sm"
												variant="outline"
												onClick={refetchFileDiff}
												disabled={fileDiffIsLoading}
											>
												Retry
											</Button>
										</div>
									) : fileDiffIsLoading ? (
										<div className="px-4 py-3 text-sm text-muted-foreground">
											Loading file diff...
										</div>
									) : !activeSelectedFile ? (
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
