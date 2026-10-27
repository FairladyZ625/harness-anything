import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, readFrontmatter, readScalar } from "@harness-anything/kernel";

/** A worker's request for an owner ruling, read from the task package. */
export interface RuntimeRulingRequest {
  readonly question: string;
  readonly options: readonly string[];
  /** Task-package-relative logical path of the artifact that carries the request. */
  readonly path: string;
}

/**
 * The request plus the bytes it was parsed from. Settlement publishes those exact bytes through the
 * dispatch archive, which is the one publication path that already runs on every exit, so the ask
 * becomes visible to the projection-backed read faces without asking the worker to doc-sync.
 */
export interface RuntimeRulingArtifact extends RuntimeRulingRequest {
  readonly body: string;
}

/** The artifact a dispatched worker writes when it needs a ruling instead of finishing. */
export function runtimeRulingPath(dispatchId: string): string {
  return `artifacts/rulings/${dispatchId}.md`;
}

/**
 * The one machine-readable shape of an unattended ruling request. The mission tells the worker to
 * write this file and stop; settlement reads it here rather than inferring a ruling from prose or
 * from a provider's question-tool frame (which is not structured in the exec JSON stream at all).
 * Returns null for an absent artifact and for any body that is not exactly this declaration — a
 * malformed ruling is not a ruling, so the dispatch keeps its ordinary classification.
 */
export function parseRulingRequest(body: string, path: string): RuntimeRulingRequest | null {
  const frontmatter = readFrontmatter(body);
  if (frontmatter === null || readScalar(frontmatter, "ruling") !== "awaiting") return null;
  const question = readScalar(frontmatter, "question");
  if (question === "") return null;
  return { question, options: readOptions(frontmatter), path };
}

/** The `options:` block: one `- <option>` entry per line, in the worker's order. */
function readOptions(frontmatter: string): readonly string[] {
  const lines = frontmatter.split("\n"),
    start = lines.findIndex((line) => line.trimEnd() === "options:");
  if (start < 0) return [];
  const options: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const entry = /^\s*-\s+(.*)$/u.exec(line);
    if (entry === null) break;
    const text = entry[1]!.trim();
    if (text !== "") options.push(text);
  }
  return options;
}

/** Read this dispatch's ruling artifact through a document reader (the projection fallback). */
export function readDispatchRuling(
  readDocument: (relativePath: string) => string | null,
  packagePath: string,
  dispatchId: string,
): RuntimeRulingArtifact | null {
  const relative = `${packagePath}/${runtimeRulingPath(dispatchId)}`;
  try {
    const body = readDocument(relative);
    if (body === null) return null;
    const parsed = parseRulingRequest(body, relative);
    return parsed === null ? null : { ...parsed, body };
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

/**
 * The worker writes its ruling into the task package as it reaches it from its own cwd: the
 * mirrored `harness/<packagePath>` inside a task worktree, or the package root itself when the
 * dispatch runs in the package. That file is not in the ledger projection at settlement time — a
 * worktree artifact is a new local file, and only doc sync publishes documents — so settlement
 * reads the worker's own filesystem. The projection reader above remains the fallback for an
 * artifact the worker did publish. Candidates are tried in the order the dispatch could have
 * written them; the first parseable one wins.
 */
export function readDispatchRulingFromWorker(input: {
  readonly cwd: string;
  readonly rootDir: string;
  readonly packagePath: string;
  readonly dispatchId: string;
}): RuntimeRulingArtifact | null {
  const relative = runtimeRulingPath(input.dispatchId),
    logicalPath = `${input.packagePath}/${relative}`,
    candidates = [
      // A task worktree reaches its package through the ledger mirror.
      path.join(input.cwd, "harness", ...input.packagePath.split("/"), ...relative.split("/")),
      // A package-bound dispatch's cwd is the package itself.
      path.join(input.cwd, ...relative.split("/")),
      // A worker that wrote through the canonical ledger, or a daemon running inside it.
      path.join(input.rootDir, "harness", ...input.packagePath.split("/"), ...relative.split("/")),
    ];
  for (const candidate of candidates) {
    const body = readFileIfPresent(candidate);
    if (body === null) continue;
    const parsed = parseRulingRequest(body, logicalPath);
    if (parsed !== null) return { ...parsed, body };
  }
  return null;
}

export function readFileIfPresent(file: string, maxBytes = Number.POSITIVE_INFINITY): string | null {
  try {
    return existsSync(file) && statSizeAtMost(file, maxBytes) ? readFileSync(file, "utf8") : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

function statSizeAtMost(file: string, maxBytes: number): boolean {
  const stat = statSync(file, { throwIfNoEntry: false });
  return stat?.isFile() === true && stat.size <= maxBytes;
}

/**
 * The receipt text for a ruling stop: the question and ordered options ride the persisted result,
 * so `ha runtime wait`, the dispatch row and the archived report show the ask without a raw
 * provider log. The attempt `reason` stays the one-line question.
 */
export function rulingReceiptText(ruling: RuntimeRulingRequest): string {
  return [
    `Awaiting owner ruling: ${ruling.question}`,
    ...(ruling.options.length
      ? ["Options:", ...ruling.options.map((option, index) => `  ${String(index + 1)}. ${option}`)]
      : []),
    `Ruling artifact: ${ruling.path}`,
    'Answer, then continue this session: ha agent run <agent-id> --resume-dispatch <dispatch-id> --prompt "<answer>"',
  ].join("\n");
}
