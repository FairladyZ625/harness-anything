import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, readFrontmatter, readScalar } from "@harness-anything/kernel";
import { decodeEvidencePayload } from "./evidence-payload.ts";

/** A worker's request for an owner ruling, read from the task package. */
export interface RuntimeRulingRequest {
  readonly question: string;
  readonly options: readonly string[];
  readonly recommendation?: string;
  readonly reason?: string;
  readonly dispatchId?: string;
  readonly createdAt?: string;
  readonly malformedReason?: string;
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

export type RuntimeRulingArtifactParse =
  | {
      readonly kind: "valid";
      readonly question: string;
      readonly options: readonly string[];
      readonly path: string;
      readonly recommendation?: string;
      readonly reason?: string;
      readonly dispatchId?: string;
      readonly createdAt?: string;
      readonly answer?: string;
      readonly answeredAt?: string;
    }
  | { readonly kind: "malformed"; readonly path: string; readonly reason: string };

/** The structured artifact written by `ha task escalate` for the dispatch that needs a ruling. */
export function runtimeRulingPath(dispatchId: string): string {
  return `artifacts/rulings/${dispatchId}.md`;
}

export function runtimeRulingResolutionPath(dispatchId: string): string {
  return `artifacts/rulings/${dispatchId}.resolution.md`;
}

/**
 * The one machine-readable shape of an unattended ruling request. The mission tells the worker to
 * use `ha task escalate`; settlement reads this artifact rather than inferring a ruling from prose
 * or from a provider's question-tool frame (which is not structured in the exec JSON stream at all).
 * Returns null for an absent artifact and for any body that is not exactly this declaration.
 * A legacy frontmatter file remains supported; a present but malformed file is retained as a
 * malformed artifact by `parseRulingArtifact` so settlement cannot silently classify the exit as
 * an ordinary worker stop.
 */
export function parseRulingRequest(body: string, path: string): RuntimeRulingRequest | null {
  const parsed = parseRulingArtifact(body, path);
  return parsed?.kind === "valid"
    ? {
        question: parsed.question,
        options: parsed.options,
        path: parsed.path,
        ...(parsed.recommendation === undefined ? {} : { recommendation: parsed.recommendation }),
        ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
        ...(parsed.dispatchId === undefined ? {} : { dispatchId: parsed.dispatchId }),
        ...(parsed.createdAt === undefined ? {} : { createdAt: parsed.createdAt }),
      }
    : null;
}

/** Distinguish an absent artifact from a present file the old worker guidance did not structure. */
export function parseRulingArtifact(body: string, path: string): RuntimeRulingArtifactParse | null {
  if (body.trim() === "") return { kind: "malformed", path, reason: "ruling artifact is empty" };
  const structured = structuredRuling(body, path);
  if (structured !== undefined) return structured;
  const frontmatter = readFrontmatter(body);
  if (frontmatter === null) return { kind: "malformed", path, reason: "missing ruling frontmatter" };
  if (readScalar(frontmatter, "ruling") !== "awaiting")
    return { kind: "malformed", path, reason: "frontmatter must declare ruling: awaiting" };
  const question = readScalar(frontmatter, "question");
  if (question === "") return { kind: "malformed", path, reason: "frontmatter is missing question" };
  return { kind: "valid", question, options: readOptions(frontmatter), path };
}

/** Structured requests are emitted by `ha task escalate`; frontmatter remains supported for old workers. */
const structuredRuling = (body: string, path: string): RuntimeRulingArtifactParse | undefined => {
  const value = decodeEvidencePayload(body);
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { kind: "malformed", path, reason: "structured ruling must be a JSON object" };
  const row = value as Record<string, unknown>;
  if (row.schema !== "worker-escalation/v1")
    return { kind: "malformed", path, reason: "structured ruling must declare schema worker-escalation/v1" };
  if (row.status !== "awaiting")
    return { kind: "malformed", path, reason: "structured ruling must declare status awaiting" };
  if (typeof row.question !== "string" || row.question.trim() === "")
    return { kind: "malformed", path, reason: "structured ruling is missing question" };
  if (!Array.isArray(row.options) || !row.options.every((option) => typeof option === "string" && option.trim() !== ""))
    return { kind: "malformed", path, reason: "structured ruling options must be an array of non-empty strings" };
  if (typeof row.dispatchId !== "string" || !/^dispatch_[a-f0-9]{24}$/u.test(row.dispatchId))
    return { kind: "malformed", path, reason: "structured ruling is missing a valid dispatchId" };
  if (typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)))
    return { kind: "malformed", path, reason: "structured ruling is missing a valid createdAt timestamp" };
  return {
    kind: "valid",
    question: row.question.trim(),
    options: row.options.map((option) => (option as string).trim()),
    path,
    ...(typeof row.recommendation === "string" ? { recommendation: row.recommendation } : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    dispatchId: row.dispatchId,
    createdAt: row.createdAt,
  };
};

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
  const resolution = dispatchId.endsWith(".resolution"),
    baseDispatchId = resolution ? dispatchId.slice(0, -".resolution".length) : dispatchId,
    relative = `${packagePath}/${resolution ? runtimeRulingResolutionPath(baseDispatchId) : runtimeRulingPath(dispatchId)}`;
  try {
    const body = readDocument(relative);
    if (body === null) return null;
    if (resolution) {
      try {
        const value = JSON.parse(body) as Record<string, unknown>;
        return value.schema === "worker-escalation-resolution/v1" &&
          value.dispatchId === baseDispatchId &&
          typeof value.answer === "string" &&
          value.answer.trim() !== "" &&
          typeof value.answeredAt === "string"
          ? {
              question: value.answer,
              options: [],
              path: relative,
              body,
              dispatchId: value.dispatchId,
              createdAt: value.answeredAt,
            }
          : null;
      } catch (error) {
        consumeKnownError(error);
        return null;
      }
    }
    return decodeArtifactBody(body, relative);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

/** Read a ruling artifact without collapsing malformed, present documents into absence. */
function decodeArtifactBody(
  body: string,
  relative: string,
): (RuntimeRulingRequest & { readonly body: string; readonly malformedReason?: string }) | null {
  const parsed = parseRulingArtifact(body, relative);
  if (parsed === null) return null;
  return parsed.kind === "valid"
    ? {
        question: parsed.question,
        options: parsed.options,
        path: parsed.path,
        body,
        ...(parsed.recommendation === undefined ? {} : { recommendation: parsed.recommendation }),
        ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
        ...(parsed.dispatchId === undefined ? {} : { dispatchId: parsed.dispatchId }),
        ...(parsed.createdAt === undefined ? {} : { createdAt: parsed.createdAt }),
      }
    : {
        question: `Ruling artifact is not machine-readable: ${parsed.reason}`,
        options: [],
        path: parsed.path,
        body,
        malformedReason: parsed.reason,
      };
}

/**
 * Legacy workers may still write a ruling file from their cwd. The CLI route writes through the
 * canonical document action, so the projection reader is normally authoritative; the filesystem
 * candidates preserve recovery for files produced by older workers before doc sync.
 */
export function readDispatchRulingFromWorker(input: {
  readonly cwd: string;
  readonly rootDir: string;
  readonly packagePath: string;
  readonly dispatchId: string;
}): RuntimeRulingArtifact | null {
  return rulingFromWorkerInternal(input);
}

function rulingFromWorkerInternal(input: {
  readonly cwd: string;
  readonly rootDir: string;
  readonly packagePath: string;
  readonly dispatchId: string;
}): (RuntimeRulingRequest & { readonly body: string; readonly malformedReason?: string }) | null {
  const relative = runtimeRulingPath(input.dispatchId),
    logicalPath = input.packagePath === "" ? relative : `${input.packagePath}/${relative}`,
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
    const parsed = decodeArtifactBody(body, logicalPath);
    if (parsed === null) continue;
    return parsed;
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
    ...(ruling.recommendation ? [`Recommendation: ${ruling.recommendation}`] : []),
    ...(ruling.reason ? [`Reason: ${ruling.reason}`] : []),
    ...(ruling.options.length
      ? ["Options:", ...ruling.options.map((option, index) => `  ${String(index + 1)}. ${option}`)]
      : []),
    `Ruling artifact: ${ruling.path}`,
    ...(ruling.malformedReason ? [`Ruling artifact issue: ${ruling.malformedReason}`] : []),
    'After the owner decides, run `ha task escalation resolve <task-id> --dispatch-id <dispatch-id> --answer "<answer>"`; the task will resume with that answer.',
  ].join("\n");
}
