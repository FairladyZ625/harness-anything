import type {
  DecisionProjectionRow,
  FactProjectionRow,
  TaskIndexProjectionRow,
  TaskProjectionQueries,
} from "@harness-anything/kernel";
import { normalizeRepoPath } from "@harness-anything/kernel/internal/domain/production-delta.ts";
import { requireSameProjectionCut, type ProjectionCut } from "./projection-cut.ts";

/**
 * Reverse code-path provenance (dec_9979850C7CE87C17271D78E4D1): from one or more repository paths
 * back to the Tasks whose merges touched them, the in-effect Decisions governing them (with their
 * rejected redlines) and the Facts anchored to them. Pure orchestration over two narrow ports: the
 * canonical projection (indexed lookups only, every read at one verified cut) and a host
 * `GitHistoryPort`. This module never spawns a process; the daemon host injects the port, and the
 * single-writer plane never sees it.
 */

/** dec_9979850C7CE87C17271D78E4D1 CH3: one batched history read covers at most this many paths. */
export const MAX_TRACED_FILES = 5;
export const DEFAULT_TRACE_COMMITS = 20;
export const MAX_TRACE_COMMITS = 200;
/** Per-section row count for `ha trace`; every projection read below is a bounded, indexed page. */
const TRACE_SECTION_ROWS = 20;
const CODE_PATH_EXTENSIONS = /\.(?:ts|tsx|js|mjs|cjs|json|py|rs|go|sql|sh|css|html|md|yaml|yml)$/iu;
const CODE_PATH_ROOTS = new Set(["packages", "tools", "scripts", "src", "test", "docs", "apps"]);
const NON_CODE_PREFIXES = ["http://", "https://", "harness/", ".harness/", "tasks/", "decisions/", "facts/"];
const TASK_ID = /\btask_[0-9a-f]{26}\b/iu;

export type GitHistoryOutcome =
  | { readonly availability: "available"; readonly stdout: string }
  | {
      readonly availability: "unavailable";
      readonly reason: "git_worktree_unavailable" | "git_log_failed";
      readonly message: string;
    };

export interface TraceWorktreeCollision {
  readonly taskId: string;
  readonly tracePaths: readonly string[];
}

type PassiveCollision = TraceWorktreeCollision & Pick<TraceCollision, "matchReason">;

/** Host-implemented Git reads. Runtime-context reads supply the history capability alone. */
export interface GitHistoryPort {
  /** `git log -m --first-parent --name-only` over up to MAX_TRACED_FILES paths in one process. */
  readonly readPathHistory: (input: {
    readonly paths: readonly string[];
    readonly maxCommits: number;
  }) => GitHistoryOutcome;
  /** Commits on local `task_*` branches not yet reachable from HEAD that touch one path. */
  readonly readBranchCollisions?: (input: {
    readonly paths: readonly string[];
    readonly maxCommits: number;
  }) => GitHistoryOutcome;
  /** Bounded probes of other local managed worktrees, scoped to the supplied literal paths. */
  readonly readDirtyWorktreeCollisions?: (input: {
    readonly paths: readonly string[];
    readonly excludeTaskId?: string;
  }) => readonly TraceWorktreeCollision[];
}

export type TraceProjection = Pick<
  TaskProjectionQueries,
  "readCut" | "readTaskIndex" | "readTaskRelationsByTargets" | "readDecisions" | "listDecisions" | "searchFacts"
>;

export type TracePathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: "invalid_trace_path"; readonly message: string };

export interface TraceTouch {
  readonly commitSha: string;
  readonly shortSha: string;
  readonly prNumber: number | null;
  readonly taskId: string | null;
  readonly taskTitle: string | null;
  readonly taskStatus: string | null;
  readonly summary: string;
  readonly paths: readonly string[];
}

export interface TraceDecision {
  readonly decisionId: string;
  readonly title: string;
  readonly state: string;
  readonly summary: string;
  readonly viaTaskIds: readonly string[];
  readonly viaModulePrefix: string | null;
  readonly tracePaths: readonly string[];
  readonly chosen: readonly { readonly id: string; readonly summary: string }[];
  readonly rejected: readonly { readonly id: string; readonly summary: string; readonly whyNot: string }[];
}

export interface TraceFact {
  readonly factId: string;
  readonly ref: string;
  readonly domainType: string;
  readonly summary: string;
  readonly evidenceSource: string;
  readonly observedCommit: string | null;
  readonly recordedByTaskId: string | null;
  readonly matchReason: "evidence_source" | "observed_commit";
  readonly tracePaths: readonly string[];
}

export interface TraceCollision {
  readonly taskId: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly branch: string;
  readonly commits: number;
  readonly matchReason: "branch_diff" | "worktree_dirty";
}

export type TraceGitAvailability =
  | { readonly availability: "available" }
  | Extract<GitHistoryOutcome, { readonly availability: "unavailable" }>;

export interface FileTraceReadResult {
  readonly schema: "file-trace-read/v1";
  readonly ok: true;
  readonly path: string;
  readonly projectionCut: ProjectionCut;
  readonly git: TraceGitAvailability;
  readonly touchHistory: readonly TraceTouch[];
  readonly decisions: readonly TraceDecision[];
  readonly facts: readonly TraceFact[];
  readonly activeTasks: readonly TraceCollision[];
}

/** Repository-relative POSIX path: `\` → `/`, leading `./` dropped, absolute / drive / `..` / empty segments rejected. */
export function normalizeTraceTargetPath(raw: unknown): TracePathResult {
  const invalid = (detail: string): TracePathResult => ({
    ok: false,
    code: "invalid_trace_path",
    message: `Trace path must be a repository-relative path inside the workspace: ${detail}`,
  });
  if (typeof raw !== "string") return invalid("missing path");
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) return invalid(JSON.stringify(raw));
  let normalized = normalizeRepoPath(trimmed);
  while (normalized?.startsWith("./")) normalized = normalized.slice(2);
  if (
    normalized === null ||
    normalized === undefined ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    return invalid(trimmed);
  return { ok: true, path: normalized };
}

/** Ancestor prefixes a decision's `appliesTo.modules` entry may name for this path, path itself included. */
export function traceModulePrefixes(path: string): readonly string[] {
  const segments = path.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

/** Up to `maxFiles` distinct repository code paths named in a task plan (backticked or bare). */
export function extractReferencedCodePaths(markdown: string, maxFiles = MAX_TRACED_FILES): readonly string[] {
  if (!markdown || maxFiles <= 0) return [];
  const selected: string[] = [];
  for (const match of markdown.matchAll(/`([^`\r\n]+)`|(?:^|[\s(])([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)/gu)) {
    const token = (match[1] ?? match[2] ?? "")
      .trim()
      .replace(/^["'([]+|["'),;:\]]+$/gu, "")
      .replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?:[-:]\d+)*)$/u, "");
    if (!token || NON_CODE_PREFIXES.some((prefix) => token.toLowerCase().startsWith(prefix))) continue;
    const normalized = normalizeTraceTargetPath(token);
    if (!normalized.ok || !normalized.path.includes("/") || /[\s*{}<>$]/u.test(normalized.path)) continue;
    const root = normalized.path.slice(0, normalized.path.indexOf("/"));
    if (!CODE_PATH_EXTENSIONS.test(normalized.path) || !CODE_PATH_ROOTS.has(root)) continue;
    if (selected.includes(normalized.path)) continue;
    selected.push(normalized.path);
    if (selected.length >= maxFiles) break;
  }
  return selected;
}

interface ParsedCommit {
  readonly commitSha: string;
  readonly parentShas: readonly string[];
  readonly subject: string;
  readonly prNumber: number | null;
  readonly taskId: string | null;
  readonly files: readonly string[];
}

export const GIT_HISTORY_FORMAT = "%x1e%H%x1f%P%x1f%s";
export const GIT_COLLISION_FORMAT = "%x1e%H%x1f%S";

/** Parse `git log --name-only --format=GIT_HISTORY_FORMAT` output. */
export function parseGitHistory(stdout: string): readonly ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const record of stdout.split("\x1e")) {
    const [header = "", ...fileLines] = record.split(/\r?\n/u);
    const [sha = "", parents = "", subject = ""] = header.split("\x1f");
    if (!/^[0-9a-f]{40}$/iu.test(sha.trim()) || commits.some((commit) => commit.commitSha === sha.trim())) continue;
    const pr = /(?:Merge pull request #(\d+)\b|\(#(\d+)\)\s*$)/u.exec(subject);
    commits.push({
      commitSha: sha.trim().toLowerCase(),
      parentShas: parents.trim().split(/\s+/u).filter(Boolean),
      subject: subject.trim(),
      prNumber: pr ? Number(pr[1] ?? pr[2]) : null,
      taskId: TASK_ID.exec(subject)?.[0].toLowerCase() ?? null,
      files: fileLines.map((line) => line.trim()).filter(Boolean),
    });
  }
  return commits;
}

/** Parse `git log --source --format=GIT_COLLISION_FORMAT` into commit counts per task branch. */
export function parseBranchCollisions(stdout: string, paths: readonly string[]) {
  const byTask = new Map<string, { branch: string; commits: number; tracePaths: ReadonlySet<string> }>();
  for (const record of stdout.split("\x1e")) {
    const [header = "", ...files] = record.split("\0"),
      [, source = ""] = header.trim().split("\x1f");
    const taskId = TASK_ID.exec(source)?.[0].toLowerCase();
    if (taskId === undefined) continue;
    const touched =
      paths.length === 1
        ? paths
        : paths.filter((path) =>
            files.some((file) => {
              const target = file.replace(/^\r?\n/u, "");
              return target === path || target.startsWith(`${path}/`);
            }),
          );
    const entry = byTask.get(taskId) ?? { branch: source.replace(/^refs\/heads\//u, ""), commits: 0, tracePaths: [] };
    byTask.set(taskId, {
      ...entry,
      commits: entry.commits + 1,
      tracePaths: new Set([...entry.tracePaths, ...touched]),
    });
  }
  return byTask;
}

/** Commits attributed to each requested path, from one batched `--name-only` history. */
function commitsTouching(commits: readonly ParsedCommit[], paths: readonly string[]): Map<string, string[]> {
  const byCommit = new Map<string, string[]>();
  for (const commit of commits) {
    const touched =
      paths.length === 1
        ? [...paths]
        : paths.filter((path) => commit.files.some((file) => file === path || file.startsWith(`${path}/`)));
    byCommit.set(commit.commitSha, touched);
  }
  return byCommit;
}

interface TraceGraph {
  readonly reads: ProjectionCut[];
  readonly git: TraceGitAvailability;
  readonly commits: readonly ParsedCommit[];
  readonly commitPaths: ReadonlyMap<string, readonly string[]>;
  readonly taskById: ReadonlyMap<string, TaskIndexProjectionRow>;
  readonly commitTask: ReadonlyMap<string, string>;
  readonly decisions: readonly TraceDecision[];
  readonly facts: readonly TraceFact[];
}

/** The shared reverse walk for `ha trace` and dispatch injection: one Git process, bounded indexed reads. */
function traceGraph(input: {
  readonly projection: TraceProjection;
  readonly paths: readonly string[];
  readonly maxCommits: number;
  readonly gitHistory: GitHistoryPort | null;
  readonly decisionStates: "in_effect" | "any";
  readonly sectionRows: number;
}): TraceGraph {
  const { projection, paths, sectionRows } = input,
    reads: ProjectionCut[] = [projection.readCut()];
  const history: GitHistoryOutcome =
    input.gitHistory === null
      ? { availability: "unavailable", reason: "git_worktree_unavailable", message: "No host Git history port." }
      : input.gitHistory.readPathHistory({ paths, maxCommits: input.maxCommits });
  const commits = history.availability === "available" ? parseGitHistory(history.stdout) : [],
    commitPaths = commitsTouching(commits, paths),
    taskById = new Map<string, TaskIndexProjectionRow>(),
    commitTask = new Map<string, string>();
  const namedTaskIds = [...new Set(commits.flatMap((commit) => (commit.taskId === null ? [] : [commit.taskId])))];
  if (namedTaskIds.length > 0) {
    const read = projection.readTaskIndex({ taskIds: namedTaskIds });
    reads.push(read);
    for (const row of read.rows) taskById.set(row.taskId, row);
  }
  const unnamedShas = [
    ...new Set(commits.filter((commit) => commit.taskId === null).flatMap((c) => [c.commitSha, ...c.parentShas])),
  ];
  const shaTask = new Map<string, string>();
  if (unnamedShas.length > 0) {
    const read = projection.readTaskIndex({ submissionCommitShas: unnamedShas });
    reads.push(read);
    for (const row of read.rows) {
      taskById.set(row.taskId, row);
      for (const sha of row.submissionCommitShas ?? []) shaTask.set(sha.toLowerCase(), row.taskId);
    }
  }
  for (const commit of commits) {
    const taskId =
      commit.taskId ?? [commit.commitSha, ...commit.parentShas].map((sha) => shaTask.get(sha)).find(Boolean) ?? null;
    if (taskId !== null) commitTask.set(commit.commitSha, taskId);
  }
  // Decisions reach a path through the tasks that changed it (derives anchors) or by declaring a
  // module prefix of it; both are index probes, and bodies are never loaded.
  const viaTasks = new Map<string, Set<string>>(),
    taskIds = [...new Set(commitTask.values())];
  if (taskIds.length > 0) {
    const derives = projection.readTaskRelationsByTargets(
      taskIds.map((id) => `task/${id}`),
      "derives",
    );
    reads.push(derives);
    for (const edge of derives.rows) {
      const anchor = /^decision\/([^/]+)\//u.exec(edge.sourceRef);
      if (edge.state !== "active" || anchor === null) continue;
      const set = viaTasks.get(anchor[1]!) ?? new Set<string>();
      set.add(edge.targetRef.slice("task/".length));
      viaTasks.set(anchor[1]!, set);
    }
  }
  const prefixes = [...new Set(paths.flatMap(traceModulePrefixes))],
    moduleRead = projection.listDecisions({
      state: "in_effect",
      modulePrefixes: prefixes,
      withBody: false,
      limit: sectionRows,
    });
  reads.push(moduleRead);
  const rows = new Map(moduleRead.decisions.map((row) => [row.decisionId, row] as const)),
    missing = [...viaTasks.keys()].filter((id) => !rows.has(id)).slice(0, sectionRows);
  if (missing.length > 0) {
    const read = projection.readDecisions(missing, false);
    reads.push(read);
    for (const row of read.decisions) rows.set(row.decisionId, row);
  }
  const decisions = [...rows.values()]
    .filter((row) => input.decisionStates === "any" || row.state === "in_effect")
    .map((row) => traceDecision(row, viaTasks.get(row.decisionId), paths, commitPaths, commitTask))
    .filter((decision) => decision.viaTaskIds.length > 0 || decision.viaModulePrefix !== null);
  const facts = traceFacts(projection, reads, paths, commits, commitPaths, sectionRows);
  return { reads, git: gitAvailability(history), commits, commitPaths, taskById, commitTask, decisions, facts };
}

function gitAvailability(history: GitHistoryOutcome): TraceGitAvailability {
  return history.availability === "available" ? { availability: "available" } : history;
}

function traceDecision(
  row: DecisionProjectionRow,
  viaTasks: ReadonlySet<string> | undefined,
  paths: readonly string[],
  commitPaths: ReadonlyMap<string, readonly string[]>,
  commitTask: ReadonlyMap<string, string>,
): TraceDecision {
  const modules = row.appliesTo.modules
      .map((entry) => normalizeTraceTargetPath(entry.replace(/[\\/]+$/u, "")))
      .flatMap((entry) => (entry.ok ? [entry.path] : [])),
    moduleMatch = (path: string) => modules.find((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
    viaTaskIds = [...(viaTasks ?? [])].sort(),
    tracePaths = paths.filter(
      (path) =>
        moduleMatch(path) !== undefined ||
        [...commitPaths].some(
          ([sha, touched]) => touched.includes(path) && viaTaskIds.includes(commitTask.get(sha) ?? ""),
        ),
    );
  return {
    decisionId: row.decisionId,
    title: row.title,
    state: row.state,
    summary: row.chosen[0]?.text ?? row.question ?? row.title,
    viaTaskIds,
    viaModulePrefix: paths.map(moduleMatch).find((prefix) => prefix !== undefined) ?? null,
    tracePaths,
    chosen: row.chosen.map((entry) => ({ id: entry.id, summary: entry.text })),
    rejected: row.rejected.map((entry) => ({ id: entry.id, summary: entry.text, whyNot: entry.whyNot })),
  };
}

function traceFacts(
  projection: TraceProjection,
  reads: ProjectionCut[],
  paths: readonly string[],
  commits: readonly ParsedCommit[],
  commitPaths: ReadonlyMap<string, readonly string[]>,
  limit: number,
): readonly TraceFact[] {
  const facts = new Map<string, TraceFact>(),
    bySource = projection.searchFacts({ evidenceSourcePaths: paths, limit });
  reads.push(bySource);
  const keep = (row: FactProjectionRow, matchReason: TraceFact["matchReason"], tracePaths: readonly string[]) => {
    if (row.archived || row.invalidated || facts.has(row.ref) || tracePaths.length === 0) return;
    facts.set(row.ref, {
      factId: row.factId,
      ref: row.ref,
      domainType: row.domainTypes?.[0] ?? "general",
      summary: row.statement,
      evidenceSource: row.evidenceSource,
      observedCommit: row.observedCommit ?? null,
      recordedByTaskId: row.taskId ?? null,
      matchReason,
      tracePaths,
    });
  };
  for (const row of bySource.facts)
    keep(
      row,
      "evidence_source",
      paths.filter(
        (path) =>
          row.evidenceSource === path ||
          row.evidenceSource.startsWith(`${path}:`) ||
          row.evidenceSource.startsWith(`${path}#`),
      ),
    );
  if (commits.length > 0) {
    const byCommit = projection.searchFacts({ observedCommits: commits.map((commit) => commit.commitSha), limit });
    reads.push(byCommit);
    for (const row of byCommit.facts)
      keep(row, "observed_commit", commitPaths.get((row.observedCommit ?? "").toLowerCase()) ?? []);
  }
  return [...facts.values()];
}

function checkedCommitLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null) return DEFAULT_TRACE_COMMITS;
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  return Number.isInteger(value) && value >= 1 && value <= MAX_TRACE_COMMITS ? value : null;
}

/** `ha trace <path>`: the full reverse trace of one path, plus unmerged task-branch collisions. */
export function traceFileCausalHistory(input: {
  readonly projection: TraceProjection;
  readonly path: unknown;
  readonly limit?: unknown;
  readonly gitHistory: GitHistoryPort | null;
}): FileTraceReadResult | Extract<TracePathResult, { readonly ok: false }> {
  const normalized = normalizeTraceTargetPath(input.path);
  if (!normalized.ok) return normalized;
  const maxCommits = checkedCommitLimit(input.limit);
  if (maxCommits === null)
    return {
      ok: false,
      code: "invalid_trace_path",
      message: `Trace --limit must be an integer between 1 and ${String(MAX_TRACE_COMMITS)}.`,
    };
  const path = normalized.path,
    graph = traceGraph({
      projection: input.projection,
      paths: [path],
      maxCommits,
      gitHistory: input.gitHistory,
      decisionStates: "any",
      sectionRows: TRACE_SECTION_ROWS,
    });
  const { branches, dirty, rows } = readCollisions(input.projection, graph.reads, input.gitHistory, [path], maxCommits);
  const activeTasks: TraceCollision[] = [...rows.keys()].map((taskId) => ({
    taskId,
    title: rows.get(taskId)?.title ?? null,
    status: rows.get(taskId)?.status ?? null,
    branch: branches.get(taskId)?.branch ?? taskId,
    commits: branches.get(taskId)?.commits ?? 0,
    matchReason: dirty.has(taskId) ? "worktree_dirty" : "branch_diff",
  }));
  return {
    schema: "file-trace-read/v1",
    ok: true,
    path,
    projectionCut: requireSameProjectionCut("trace", graph.reads),
    git: graph.git,
    touchHistory: graph.commits.map((commit) => {
      const taskId = graph.commitTask.get(commit.commitSha) ?? null,
        task = taskId === null ? undefined : graph.taskById.get(taskId);
      return {
        commitSha: commit.commitSha,
        shortSha: commit.commitSha.slice(0, 9),
        prNumber: commit.prNumber,
        taskId,
        taskTitle: task?.title ?? null,
        taskStatus: task?.status ?? null,
        summary: commit.subject,
        paths: graph.commitPaths.get(commit.commitSha) ?? [],
      };
    }),
    decisions: rankDecisions(graph.decisions),
    facts: graph.facts,
    activeTasks,
  };
}

function readCollisions(
  projection: TraceProjection,
  reads: ProjectionCut[],
  gitHistory: GitHistoryPort | null,
  paths: readonly string[],
  maxCommits: number,
  excludeTaskId?: string,
) {
  const outcome = gitHistory?.readBranchCollisions?.({ paths, maxCommits }),
    branches = parseBranchCollisions(outcome?.availability === "available" ? outcome.stdout : "", paths),
    hits =
      gitHistory?.readDirtyWorktreeCollisions?.({ paths, ...(excludeTaskId === undefined ? {} : { excludeTaskId }) }) ??
      [],
    dirty = new Map(hits.map(({ taskId, tracePaths }) => [taskId, tracePaths])),
    taskIds = [...new Set([...dirty.keys(), ...branches.keys()])].filter((taskId) => taskId !== excludeTaskId),
    missingRows = new Map<string, TaskIndexProjectionRow | undefined>(taskIds.map((taskId) => [taskId, undefined]));
  let rows = missingRows;
  if (taskIds.length > 0) {
    const read = projection.readTaskIndex({ taskIds });
    reads.push(read);
    const foundRows = new Map(read.rows.map((row) => [row.taskId, row]));
    rows = new Map(
      taskIds
        .filter((taskId) => {
          const row = foundRows.get(taskId);
          return row === undefined || (row.status !== "done" && row.status !== "cancelled");
        })
        .map((taskId) => [taskId, foundRows.get(taskId)]),
    );
  }
  return { branches, dirty, rows };
}

/** Rejected redlines first, then task lineage, then module scope. */
function rankDecisions(decisions: readonly TraceDecision[]): readonly TraceDecision[] {
  const score = (decision: TraceDecision) =>
    (decision.state === "in_effect" ? 4 : 0) +
    (decision.rejected.some((entry) => entry.whyNot.trim() !== "") ? 2 : 0) +
    (decision.viaTaskIds.length > 0 ? 1 : 0);
  return [...decisions].sort((a, b) => score(b) - score(a) || a.decisionId.localeCompare(b.decisionId));
}

export interface PassiveTraceSelection {
  readonly paths: readonly string[];
  readonly reads: readonly ProjectionCut[];
  readonly git: TraceGitAvailability;
  readonly decisions: readonly TraceDecision[];
  readonly facts: readonly TraceFact[];
  readonly collisions: readonly PassiveCollision[];
}

/**
 * Dispatch-time passive redlines (CH3): at most MAX_TRACED_FILES plan paths through ONE batched Git
 * read, deduplicated against the forward context, keeping at most `maxDecisions` in-effect Decisions
 * (rejected whyNot first) and `maxFacts` live Facts. Rendering and the byte budget stay with the caller.
 */
export function selectPassiveTraceContext(input: {
  readonly projection: TraceProjection;
  readonly planBody: string;
  readonly gitHistory: GitHistoryPort | null;
  readonly taskId?: string;
  readonly excludeDecisionIds: readonly string[];
  readonly excludeFactRefs: readonly string[];
  readonly maxDecisions: number;
  readonly maxFacts: number;
  readonly maxCommits?: number;
}): PassiveTraceSelection | null {
  const paths = extractReferencedCodePaths(input.planBody, MAX_TRACED_FILES);
  if (paths.length === 0) return null;
  const graph = traceGraph({
    projection: input.projection,
    paths,
    maxCommits: input.maxCommits ?? DEFAULT_TRACE_COMMITS * 2,
    gitHistory: input.gitHistory,
    decisionStates: "in_effect",
    sectionRows: TRACE_SECTION_ROWS,
  });
  const { branches, dirty, rows } = readCollisions(
    input.projection,
    graph.reads,
    input.gitHistory,
    paths,
    input.maxCommits ?? DEFAULT_TRACE_COMMITS,
    input.taskId,
  );
  const collisions: PassiveCollision[] = [];
  for (const taskId of rows.keys()) {
    const dirtyPaths = dirty.get(taskId) ?? [],
      branchPaths = [...(branches.get(taskId)?.tracePaths ?? [])].filter((path) => !dirtyPaths.includes(path));
    if (dirtyPaths.length > 0) collisions.push({ taskId, tracePaths: dirtyPaths, matchReason: "worktree_dirty" });
    if (branchPaths.length > 0) collisions.push({ taskId, tracePaths: branchPaths, matchReason: "branch_diff" });
  }
  return {
    paths,
    reads: graph.reads,
    git: graph.git,
    collisions,
    decisions: rankDecisions(graph.decisions)
      .filter((decision) => !input.excludeDecisionIds.includes(decision.decisionId))
      .slice(0, input.maxDecisions),
    facts: [...graph.facts]
      .filter((fact) => !input.excludeFactRefs.includes(fact.ref))
      .sort((a, b) => Number(b.matchReason === "evidence_source") - Number(a.matchReason === "evidence_source"))
      .slice(0, input.maxFacts),
  };
}
