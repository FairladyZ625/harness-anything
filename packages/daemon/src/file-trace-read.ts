import type {
  DecisionProjectionRow,
  FactProjectionRow,
  FileTouchRecord,
  FileTraceActiveTaskWarning,
  FileTraceDecisionSummary,
  FileTraceFactSummary,
  FileTraceReadResult,
  TaskIndexProjectionRow,
  TaskProjection,
  WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { runProcessText } from "./process-port.ts";
import { requireSameProjectionCut, type ProjectionCut } from "./projection-cut.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { TaskQueryCell } from "./repo-cell-task-query.ts";

const DEFAULT_TRACE_COMMITS = 50;
const MAX_TRACE_COMMITS = 200;
const DEFAULT_EXTRACT_FILES = 5;
const BOUNDED_QUERY_CAP = 200;
const RADAR_PAGE_CAP = 100;
const DONE_SCAN_CAP = 50;
const FTS_FALLBACK_CAP = 20;
const CODE_PATH_EXTENSIONS = /\.(?:ts|tsx|js|mjs|cjs|json|py|rs|go|sql|sh|css|html)$/iu;
const CODE_PATH_ROOTS = new Set(["packages", "src", "tools", "scripts", "test"]);
const NON_CODE_PREFIXES = [
  "http://",
  "https://",
  "harness/",
  ".harness/",
  "task/",
  "decision/",
  "fact/",
  "work/",
  "person/",
  "agent/",
  "squad/",
];

export type TracePathValidationResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: "invalid_trace_path"; readonly message: string };

export interface TraceFileCausalHistoryError {
  readonly ok: false;
  readonly code: "invalid_trace_path";
  readonly message: string;
}

export type TraceCausalProjection = Partial<
  Pick<
    TaskProjection,
    | "read"
    | "readCut"
    | "readTaskIndex"
    | "readTaskRelationsByTargets"
    | "readRelationQuery"
    | "readDecisions"
    | "listDecisions"
    | "searchFacts"
    | "readDocument"
  >
> &
  Pick<TaskProjection, "readCut">;

export interface TraceFileCausalHistoryInput {
  readonly projection: TraceCausalProjection;
  readonly rootDir?: string;
  readonly path: unknown;
  readonly maxCommits?: unknown;
  readonly includeActiveRadar?: boolean;
  readonly readGitLog?: (args: readonly string[], cwd: string) => string;
}

interface ParsedGitCommit {
  readonly commitSha: string;
  readonly shortSha: string;
  readonly parentShas: readonly string[];
  readonly prNumber: number | null;
  readonly extractedTaskId: string | null;
  readonly subject: string;
}

type LooseDecisionRow = DecisionProjectionRow & {
  readonly summary?: string;
};

type LooseFactRow = FactProjectionRow & {
  readonly domainType?: string;
  readonly subject?: string;
  readonly summary?: string;
  readonly loadBearing?: boolean;
  readonly recordedByTaskId?: string | null;
  readonly lifecycleState?: string;
};

export function normalizeTraceTargetPath(rawPath: unknown): TracePathValidationResult {
  if (typeof rawPath !== "string") {
    return {
      ok: false,
      code: "invalid_trace_path",
      message: "Trace path must be a non-empty repository-relative path within the workspace.",
    };
  }
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) {
    return {
      ok: false,
      code: "invalid_trace_path",
      message: "Trace path must be a non-empty repository-relative path within the workspace.",
    };
  }
  const slashed = trimmed.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/u.test(slashed)) {
    return {
      ok: false,
      code: "invalid_trace_path",
      message: `Absolute paths are outside the trace workspace boundary: ${trimmed}`,
    };
  }
  let stripped = slashed;
  while (stripped.startsWith("./")) stripped = stripped.slice(2);
  const segments = stripped.split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return {
      ok: false,
      code: "invalid_trace_path",
      message: `Trace path must stay cleanly within the repository root: ${trimmed}`,
    };
  }
  return { ok: true, path: segments.join("/") };
}

function normalizeCommitCount(rawCount: unknown): number | null {
  if (rawCount === undefined) return DEFAULT_TRACE_COMMITS;
  const numeric =
    typeof rawCount === "number" ? rawCount : typeof rawCount === "string" ? Number(rawCount) : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_TRACE_COMMITS) return null;
  return numeric;
}

export function extractReferencedCodePaths(markdown: string, maxFiles = DEFAULT_EXTRACT_FILES): readonly string[] {
  if (!markdown || maxFiles <= 0) return [];
  const candidates: string[] = [];
  const tokenPattern = /`([^`\r\n]+)`|(?:^|[\s(])([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)/gu;
  for (const match of markdown.matchAll(tokenPattern)) {
    const token = match[1] ?? match[2];
    if (token) candidates.push(token);
  }
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const rawCandidate of candidates) {
    const cleanedToken = rawCandidate
      .trim()
      .replace(/^["'([]+|["'),;:\]]+$/gu, "")
      .replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/u, "");
    if (!cleanedToken) continue;
    const lowered = cleanedToken.toLowerCase();
    if (NON_CODE_PREFIXES.some((prefix) => lowered.startsWith(prefix))) continue;
    const normalized = normalizeTraceTargetPath(cleanedToken);
    if (!normalized.ok) continue;
    const clean = normalized.path;
    if (!clean.includes("/")) continue;
    const topDir = clean.slice(0, clean.indexOf("/"));
    if (!CODE_PATH_EXTENSIONS.test(clean) && !CODE_PATH_ROOTS.has(topDir)) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    selected.push(clean);
    if (selected.length >= maxFiles) break;
  }
  return selected;
}

function parseGitTouchLines(rawOutput: string): readonly ParsedGitCommit[] {
  const commits: ParsedGitCommit[] = [];
  const seenSha = new Set<string>();
  for (const line of rawOutput.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const firstSep = line.indexOf("|");
    if (firstSep <= 0) continue;
    const secondSep = line.indexOf("|", firstSep + 1);
    if (secondSep < 0) continue;
    const commitSha = line.slice(0, firstSep).trim();
    if (!/^[0-9a-f]{7,64}$/iu.test(commitSha) || seenSha.has(commitSha)) continue;
    seenSha.add(commitSha);
    const parentText = line.slice(firstSep + 1, secondSep).trim();
    const subject = line.slice(secondSep + 1).trim();
    const prMatch = /(?:Merge pull request #(\d+)\b|\(#(\d+)\))/u.exec(subject);
    const taskMatch = /\b(task_[0-9a-f]{26})\b/iu.exec(subject);
    commits.push({
      commitSha,
      shortSha: commitSha.slice(0, 9),
      parentShas: parentText ? parentText.split(/\s+/u).filter(Boolean) : [],
      prNumber: prMatch ? Number(prMatch[1] ?? prMatch[2]) : null,
      extractedTaskId: taskMatch ? taskMatch[1]!.toLowerCase() : null,
      subject,
    });
  }
  return commits;
}

function readGitTouchHistory(
  targetPath: string,
  maxCommits: number,
  rootDir: string | undefined,
  readGitLog: TraceFileCausalHistoryInput["readGitLog"],
): readonly ParsedGitCommit[] {
  const gitArgs = ["log", "-m", "--first-parent", "-n", String(maxCommits), "--format=%H|%P|%s", "--", targetPath];
  let stdout: string;
  if (readGitLog) {
    stdout = readGitLog(gitArgs, rootDir ?? process.cwd());
  } else if (rootDir) {
    try {
      stdout = runProcessText("git", gitArgs, rootDir);
    } catch {
      return [];
    }
  } else {
    return [];
  }
  return parseGitTouchLines(stdout);
}

function normalizeModulePrefix(rawPrefix: string): string {
  return rawPrefix.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function collectTaskAncestors(
  projection: TraceCausalProjection,
  seedTaskIds: readonly string[],
  taskById: Map<string, TaskIndexProjectionRow>,
  cuts: ProjectionCut[],
): readonly string[] {
  const collected: string[] = [];
  const seen = new Set<string>();
  const queue = [...seedTaskIds];
  while (queue.length > 0) {
    const taskId = queue.shift()!;
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    collected.push(taskId);
    let row = taskById.get(taskId);
    if (!row && projection.readTaskIndex) {
      const read = projection.readTaskIndex({ taskIds: [taskId] });
      cuts.push(read);
      for (const candidate of read.rows) taskById.set(candidate.taskId, candidate);
      row = taskById.get(taskId);
    }
    if (row?.parentTaskId && !seen.has(row.parentTaskId)) queue.push(row.parentTaskId);
  }
  return collected;
}

function collectDecisionAndAnchor(ref: string): { readonly decisionId: string | null } {
  const match = /^decision\/([^/]+)/u.exec(ref);
  return { decisionId: match ? match[1]! : null };
}

function decisionSummaryText(decision: LooseDecisionRow): string {
  if (typeof decision.summary === "string" && decision.summary.trim().length > 0) return decision.summary.trim();
  const bodyText = decision.body?.body?.trim();
  if (bodyText && bodyText.length > 0) {
    const firstParagraph = bodyText
      .split(/\r?\n\r?\n/u)
      .map((block) => block.trim())
      .find((block) => block.length > 0 && !block.startsWith("#") && !block.startsWith("<!--"));
    if (firstParagraph) return firstParagraph.replace(/\s+/gu, " ").trim();
  }
  if (decision.chosen.length > 0) return decision.chosen[0]!.text;
  if (decision.question.trim().length > 0) return decision.question.trim();
  return decision.title;
}

function matchSubmissionTaskId(
  projection: TraceCausalProjection,
  commit: ParsedGitCommit,
  candidateRows: readonly TaskIndexProjectionRow[],
  cuts: ProjectionCut[],
): string | null {
  if (commit.extractedTaskId !== null) return commit.extractedTaskId;
  if (!projection.read || candidateRows.length === 0) return null;
  const shas = new Set([commit.commitSha, ...commit.parentShas]);
  for (const row of candidateRows) {
    const taskRead = projection.read(row.taskId);
    cuts.push(taskRead);
    const executions = taskRead.snapshot.executions ?? [];
    for (const execution of executions) {
      const sub = (execution as { readonly submission?: { readonly commitSha?: string | null } }).submission;
      const submittedSha = sub?.commitSha;
      if (typeof submittedSha === "string" && submittedSha.length > 0 && shas.has(submittedSha)) {
        return row.taskId;
      }
    }
  }
  return null;
}

function matchObservedCommit(observedCommit: string | undefined | null, shas: ReadonlySet<string>): boolean {
  if (typeof observedCommit !== "string" || observedCommit.length < 7) return false;
  for (const sha of shas) {
    if (sha === observedCommit || sha.startsWith(observedCommit) || observedCommit.startsWith(sha)) return true;
  }
  return false;
}

export function traceFileCausalHistory(
  input: TraceFileCausalHistoryInput,
): FileTraceReadResult | TraceFileCausalHistoryError {
  const normalized = normalizeTraceTargetPath(input.path);
  if (!normalized.ok) return normalized;
  const maxCommits = normalizeCommitCount(input.maxCommits);
  if (maxCommits === null) {
    return {
      ok: false,
      code: "invalid_trace_path",
      message: `Trace commit count must be an integer between 1 and ${MAX_TRACE_COMMITS}.`,
    };
  }
  const targetPath = normalized.path;
  const cuts: ProjectionCut[] = [input.projection.readCut()];
  const parsedCommits = readGitTouchHistory(targetPath, maxCommits, input.rootDir, input.readGitLog);

  const taskById = new Map<string, TaskIndexProjectionRow>();
  const extractedIds = [
    ...new Set(parsedCommits.map((c) => c.extractedTaskId).filter((id): id is string => id !== null)),
  ];
  if (extractedIds.length > 0 && input.projection.readTaskIndex) {
    const indexed = input.projection.readTaskIndex({ taskIds: extractedIds });
    cuts.push(indexed);
    for (const row of indexed.rows) taskById.set(row.taskId, row);
  }

  const activeRows: TaskIndexProjectionRow[] = [];
  if (input.includeActiveRadar && input.projection.readTaskIndex) {
    for (const status of ["active", "in_review"] as const) {
      const activeRead = input.projection.readTaskIndex({
        status,
        activePackagesOnly: true,
        limit: RADAR_PAGE_CAP,
      });
      cuts.push(activeRead);
      for (const row of activeRead.rows) {
        taskById.set(row.taskId, row);
        activeRows.push(row);
      }
    }
  }

  const allCommitShas = new Set<string>();
  const unresolvedCommits = parsedCommits.some((c) => c.extractedTaskId === null);
  let fallbackCandidates: TaskIndexProjectionRow[] = [];
  if (unresolvedCommits && parsedCommits.length > 0 && input.projection.readTaskIndex) {
    const doneRead = input.projection.readTaskIndex({
      status: "done",
      activePackagesOnly: true,
      limit: DONE_SCAN_CAP,
    });
    cuts.push(doneRead);
    for (const row of doneRead.rows) taskById.set(row.taskId, row);
    fallbackCandidates = [...doneRead.rows, ...activeRows];
  }

  const touchHistory: FileTouchRecord[] = [];
  const matchedTaskIds: string[] = [];
  for (const commit of parsedCommits) {
    allCommitShas.add(commit.commitSha);
    for (const parentSha of commit.parentShas) allCommitShas.add(parentSha);
    const taskId = matchSubmissionTaskId(input.projection, commit, fallbackCandidates, cuts);
    if (taskId && !matchedTaskIds.includes(taskId)) matchedTaskIds.push(taskId);
    let taskRow = taskId ? taskById.get(taskId) : undefined;
    if (!taskRow && taskId && input.projection.read) {
      const read = input.projection.read(taskId);
      cuts.push(read);
      if (read.snapshot.task) {
        taskRow = {
          supersededBy: null,
          taskId: read.snapshot.task.taskId,
          title: read.snapshot.task.title,
          status: read.snapshot.task.status,
          pinned: read.snapshot.task.pinned,
          parentTaskId: read.snapshot.task.metadata?.parentTaskId ?? null,
          workKind: read.snapshot.task.metadata?.workKind ?? null,
          riskTier: read.snapshot.task.metadata?.riskTier ?? null,
          urgency: read.snapshot.task.metadata?.urgency ?? null,
          taskClass: read.snapshot.task.taskClass,
          packageDisposition: read.snapshot.task.packageDisposition ?? "active",
          packagePath: read.packagePath,
          updatedAt: "",
        };
        taskById.set(taskId, taskRow);
      }
    }
    touchHistory.push({
      commitSha: commit.commitSha,
      shortSha: commit.shortSha,
      prNumber: commit.prNumber,
      taskId,
      taskTitle: taskRow?.title ?? null,
      taskStatus: taskRow?.status ?? null,
      summary: commit.subject,
    });
  }

  const allTaskIds = collectTaskAncestors(input.projection, matchedTaskIds, taskById, cuts);
  const allTaskRefSet = new Set(allTaskIds.map((id) => `task/${id}`));

  const edgeById = new Map<string, { sourceRef: string; targetRef: string; relationType: string; state: string }>();
  if (allTaskIds.length > 0 && input.projection.readTaskRelationsByTargets) {
    const taskRefs = allTaskIds.map((id) => `task/${id}`);
    for (const relType of ["derives", "relates"] as const) {
      const targetRead = input.projection.readTaskRelationsByTargets(taskRefs, relType, true);
      cuts.push(targetRead);
      for (const edge of targetRead.rows) {
        if (edge.state === "active") edgeById.set(edge.relationId, edge);
      }
    }
  }
  if (allTaskIds.length > 0 && input.projection.readRelationQuery) {
    for (const taskId of allTaskIds) {
      const relRead = input.projection.readRelationQuery({
        entity: `task/${taskId}`,
        state: "active",
        limit: BOUNDED_QUERY_CAP,
      });
      cuts.push(relRead);
      for (const edge of relRead.rows) {
        if (edge.state === "active") edgeById.set(edge.relationId, edge);
      }
    }
  }

  const decisionToViaTasks = new Map<string, Set<string>>();
  for (const edge of edgeById.values()) {
    if (edge.state !== "active") continue;
    if (edge.relationType !== "derives" && edge.relationType !== "relates") continue;
    const sourceIsTask = allTaskRefSet.has(edge.sourceRef);
    const targetIsTask = allTaskRefSet.has(edge.targetRef);
    if (!sourceIsTask && !targetIsTask) continue;
    const otherRef = targetIsTask ? edge.sourceRef : edge.targetRef;
    const taskId = (targetIsTask ? edge.targetRef : edge.sourceRef).slice("task/".length);
    const { decisionId } = collectDecisionAndAnchor(otherRef);
    if (!decisionId) continue;
    let bucket = decisionToViaTasks.get(decisionId);
    if (!bucket) {
      bucket = new Set<string>();
      decisionToViaTasks.set(decisionId, bucket);
    }
    bucket.add(taskId);
  }

  const decisionRows: LooseDecisionRow[] = [];
  const seenDecisionIds = new Set<string>();
  const relatedDecisionIds = [...decisionToViaTasks.keys()];
  if (relatedDecisionIds.length > 0 && input.projection.readDecisions) {
    const decRead = input.projection.readDecisions(relatedDecisionIds, true);
    cuts.push(decRead);
    for (const row of decRead.decisions as readonly LooseDecisionRow[]) {
      if (!seenDecisionIds.has(row.decisionId)) {
        seenDecisionIds.add(row.decisionId);
        decisionRows.push(row);
      }
    }
  }
  if (input.projection.listDecisions) {
    const listRead = input.projection.listDecisions({
      state: "in_effect",
      withBody: true,
      limit: BOUNDED_QUERY_CAP,
    });
    cuts.push(listRead);
    for (const row of listRead.decisions as readonly LooseDecisionRow[]) {
      if (!seenDecisionIds.has(row.decisionId)) {
        seenDecisionIds.add(row.decisionId);
        decisionRows.push(row);
      }
    }
  } else if (relatedDecisionIds.length === 0 && input.projection.readDecisions) {
    const decRead = input.projection.readDecisions([], true);
    cuts.push(decRead);
    for (const row of decRead.decisions as readonly LooseDecisionRow[]) {
      if (!seenDecisionIds.has(row.decisionId)) {
        seenDecisionIds.add(row.decisionId);
        decisionRows.push(row);
      }
    }
  }

  const decisions: FileTraceDecisionSummary[] = [];
  const matchedDecisionIds = new Set<string>();
  for (const row of decisionRows) {
    const viaTasks = [...(decisionToViaTasks.get(row.decisionId) ?? [])];
    const modulePrefixes = (row.appliesTo?.modules ?? []).map(normalizeModulePrefix).filter(Boolean);
    const matchedModule =
      modulePrefixes.find((prefix) => targetPath === prefix || targetPath.startsWith(`${prefix}/`)) ?? null;
    if (viaTasks.length === 0 && matchedModule === null) continue;
    matchedDecisionIds.add(row.decisionId);
    decisions.push({
      decisionId: row.decisionId,
      title: row.title,
      state: row.state ?? "in_effect",
      summary: decisionSummaryText(row),
      viaTaskIds: viaTasks,
      viaModulePrefix: matchedModule,
      chosen: (row.chosen ?? []).map((entry) => ({
        id: entry.id,
        summary: entry.text ?? (entry as { readonly summary?: string }).summary ?? "",
      })),
      rejected: (row.rejected ?? []).map((entry) => ({
        id: entry.id,
        summary: entry.text ?? (entry as { readonly summary?: string }).summary ?? "",
        whyNot: entry.whyNot ?? null,
      })),
    });
  }

  if (matchedDecisionIds.size > 0 && input.projection.readRelationQuery) {
    for (const decisionId of matchedDecisionIds) {
      const decRelRead = input.projection.readRelationQuery({
        entity: `decision/${decisionId}`,
        state: "active",
        limit: BOUNDED_QUERY_CAP,
      });
      cuts.push(decRelRead);
      for (const edge of decRelRead.rows) {
        if (edge.state === "active") edgeById.set(edge.relationId, edge);
      }
    }
  }

  const linkedFactIds = new Set<string>();
  for (const edge of edgeById.values()) {
    if (edge.state !== "active") continue;
    if (
      edge.relationType !== "evidenced-by" &&
      edge.relationType !== "produces" &&
      edge.relationType !== "relates" &&
      edge.relationType !== "supports"
    ) {
      continue;
    }
    const sourceDecisionId = collectDecisionAndAnchor(edge.sourceRef).decisionId;
    const targetDecisionId = collectDecisionAndAnchor(edge.targetRef).decisionId;
    const touchesSource =
      allTaskRefSet.has(edge.sourceRef) || (sourceDecisionId !== null && matchedDecisionIds.has(sourceDecisionId));
    const touchesTarget =
      allTaskRefSet.has(edge.targetRef) || (targetDecisionId !== null && matchedDecisionIds.has(targetDecisionId));
    if (touchesSource && edge.targetRef.startsWith("fact/")) linkedFactIds.add(edge.targetRef.slice("fact/".length));
    if (touchesTarget && edge.sourceRef.startsWith("fact/")) linkedFactIds.add(edge.sourceRef.slice("fact/".length));
  }

  const facts: FileTraceFactSummary[] = [];
  if (input.projection.searchFacts) {
    const rawFacts: LooseFactRow[] = [];
    const seenFactIds = new Set<string>();
    const appendFacts = (rows: readonly LooseFactRow[]) => {
      for (const row of rows) {
        const factId = row.factId ?? row.ref.replace(/^fact\//u, "");
        if (!seenFactIds.has(factId)) {
          seenFactIds.add(factId);
          rawFacts.push(row);
        }
      }
    };
    const linkedRefs = [...linkedFactIds].map((id) => `fact/${id}`);
    if (linkedRefs.length > 0) {
      const refRead = input.projection.searchFacts({ refs: linkedRefs, limit: BOUNDED_QUERY_CAP });
      cuts.push(refRead);
      appendFacts(refRead.facts as readonly LooseFactRow[]);
    }
    for (const taskId of allTaskIds) {
      const taskFactRead = input.projection.searchFacts({ taskId, limit: RADAR_PAGE_CAP });
      cuts.push(taskFactRead);
      appendFacts(taskFactRead.facts as readonly LooseFactRow[]);
    }
    if (touchHistory.length > 0) {
      const commitScanRead = input.projection.searchFacts({ limit: BOUNDED_QUERY_CAP });
      cuts.push(commitScanRead);
      appendFacts(commitScanRead.facts as readonly LooseFactRow[]);
    } else if (linkedRefs.length === 0 && allTaskIds.length === 0) {
      const ftsRead = input.projection.searchFacts({ query: targetPath, limit: FTS_FALLBACK_CAP });
      cuts.push(ftsRead);
      appendFacts(ftsRead.facts as readonly LooseFactRow[]);
    }

    for (const rawFact of rawFacts) {
      if (rawFact.archived === true || rawFact.lifecycleState === "archived") continue;
      const factId = rawFact.factId ?? rawFact.ref.replace(/^fact\//u, "");
      const recordedByTask = rawFact.recordedByTaskId ?? rawFact.taskId ?? null;
      const subjectRef = rawFact.subject ?? rawFact.evidenceSource ?? "";
      const subjectDecisionId = collectDecisionAndAnchor(subjectRef).decisionId;
      const matched =
        linkedFactIds.has(factId) ||
        (recordedByTask !== null && allTaskIds.includes(recordedByTask)) ||
        allTaskRefSet.has(subjectRef) ||
        (subjectDecisionId !== null && matchedDecisionIds.has(subjectDecisionId)) ||
        matchObservedCommit(rawFact.observedCommit, allCommitShas) ||
        rawFact.evidenceSource === targetPath ||
        subjectRef === `code/${targetPath}`;
      if (!matched) continue;
      facts.push({
        factId,
        domainType: rawFact.domainTypes?.[0] ?? rawFact.domainType ?? "general",
        subjectRef,
        summary: rawFact.statement ?? rawFact.summary ?? "",
        loadBearing: rawFact.loadBearing ?? true,
        observedCommit: rawFact.observedCommit ?? null,
        recordedByTaskId: recordedByTask,
      });
    }
  }

  const activeTasks: FileTraceActiveTaskWarning[] = [];
  if (input.includeActiveRadar) {
    const matchedSet = new Set(matchedTaskIds);
    const seenActiveIds = new Set<string>();
    for (const row of activeRows) {
      if (seenActiveIds.has(row.taskId)) continue;
      if (row.status !== "active" && row.status !== "in_review") continue;
      const pkg = (row.packagePath ?? `tasks/${row.taskId}`).replace(/^harness\//u, "");
      const docRead = input.projection.readDocument?.(`${pkg}/task_plan.md`);
      if (docRead) cuts.push(docRead);
      const body = docRead?.document?.body ?? "";
      const bodyPaths = body ? extractReferencedCodePaths(body, 50) : [];
      if (bodyPaths.includes(targetPath) || body.includes(targetPath)) {
        seenActiveIds.add(row.taskId);
        activeTasks.push({
          taskId: row.taskId,
          title: row.title,
          status: row.status,
          matchReason: "plan_reference",
        });
      } else if (matchedSet.has(row.taskId)) {
        seenActiveIds.add(row.taskId);
        activeTasks.push({
          taskId: row.taskId,
          title: row.title,
          status: row.status,
          matchReason: "execution_diff",
        });
      }
    }
  }

  const verifiedCut = requireSameProjectionCut("trace", cuts);
  return {
    schema: "file-trace-read/v1",
    ok: true,
    path: targetPath,
    projectionCut: verifiedCut,
    touchHistory,
    decisions,
    facts,
    activeTasks,
  };
}

export function traceView(cell: TaskQueryCell, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const rawMaxCommits = action.limit;
  const result = traceFileCausalHistory({
    projection: cell.projection,
    rootDir: cell.rootDir,
    path: action.path,
    ...(rawMaxCommits === undefined ? {} : { maxCommits: rawMaxCommits }),
    includeActiveRadar: true,
  });
  if (!result.ok) throw cell.cellCodedError(result.code, result.message);
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, result.projectionCut.sourceRevision),
    result,
    result.projectionCut.sourceRevision,
    null,
    result.projectionCut,
  );
}
