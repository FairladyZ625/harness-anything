import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { DomainStatus, EngineError, TaskId, WriteError } from "../../../kernel/src/domain/index.ts";
import { isDomainStatus, isTerminalStatus } from "../../../kernel/src/domain/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/ports/index.ts";
import { makeJournaledWriteCoordinator } from "../../../kernel/src/store/index.ts";
import { stablePayloadHash } from "../../../kernel/src/store/hash.ts";

export interface LocalLifecycleOptions {
  readonly rootDir: string;
  readonly coordinator?: WriteCoordinator;
  readonly clock?: () => Date;
}

export interface CreateLocalTaskInput {
  readonly taskId: TaskId;
  readonly title: string;
  readonly vertical?: string;
  readonly preset?: string;
}

export interface SetLocalStatusInput {
  readonly taskId: TaskId;
  readonly status: DomainStatus;
}

export interface AppendProgressInput {
  readonly taskId: TaskId;
  readonly text: string;
}

export interface LocalTaskResult {
  readonly taskId: TaskId;
  readonly status: DomainStatus;
  readonly engine: "local";
}

export interface LocalProgressResult {
  readonly taskId: TaskId;
  readonly path: "progress.md";
}

export interface LocalLifecycleEngine {
  readonly createTask: (input: CreateLocalTaskInput) => Effect.Effect<LocalTaskResult, EngineError | WriteError>;
  readonly setStatus: (input: SetLocalStatusInput) => Effect.Effect<LocalTaskResult, EngineError | WriteError>;
  readonly appendProgress: (input: AppendProgressInput) => Effect.Effect<LocalProgressResult, EngineError | WriteError>;
}

interface LocalTaskIndex {
  readonly taskId: TaskId;
  readonly title: string;
  readonly engine: string;
  readonly status: DomainStatus;
  readonly ref: string | null;
  readonly titleSnapshot: string | null;
  readonly url: string | null;
  readonly bindingCreatedAt: string;
  readonly bindingFingerprint: string;
  readonly packageDisposition: "active" | "archived" | "tombstoned";
  readonly vertical: string;
  readonly preset: string;
}

export function makeLocalLifecycleEngine(options: LocalLifecycleOptions): LocalLifecycleEngine {
  const rootDir = path.resolve(options.rootDir);
  const coordinator = options.coordinator ?? makeJournaledWriteCoordinator({ rootDir, actor: { kind: "agent", id: "local-lifecycle" } });
  const clock = options.clock ?? (() => new Date());

  return {
    createTask: (input) => Effect.gen(function* () {
      validateTaskId(input.taskId);
      if (existsSync(indexPath(rootDir, input.taskId))) {
        return yield* Effect.fail({ _tag: "MalformedSnapshot", raw: `task already exists: ${input.taskId}` } satisfies EngineError);
      }
      const bindingCreatedAt = clock().toISOString();
      const index = makeIndex({
        taskId: input.taskId,
        title: input.title,
        status: "planned",
        bindingCreatedAt,
        vertical: input.vertical ?? "default",
        preset: input.preset ?? "default"
      });
      yield* writeTaskDocument(coordinator, input.taskId, "INDEX.md", renderIndex(index));
      return { taskId: input.taskId, status: "planned", engine: "local" } satisfies LocalTaskResult;
    }),
    setStatus: (input) => Effect.gen(function* () {
      const index = yield* readIndexEffect(rootDir, input.taskId);
      if (index.engine !== "local") {
        return yield* Effect.fail({
          _tag: "EngineOwnsStatus",
          engine: index.engine,
          ref: index.ref ?? input.taskId
        } satisfies EngineError);
      }
      if (!canTransition(index.status, input.status)) {
        return yield* Effect.fail({
          _tag: "MalformedSnapshot",
          raw: `invalid transition: ${index.status} -> ${input.status}`
        } satisfies EngineError);
      }
      const next = { ...index, status: input.status };
      yield* writeTaskDocument(coordinator, input.taskId, "INDEX.md", renderIndex(next));
      return { taskId: input.taskId, status: input.status, engine: "local" } satisfies LocalTaskResult;
    }),
    appendProgress: (input) => Effect.gen(function* () {
      yield* readIndexEffect(rootDir, input.taskId);
      const existing = existsSync(taskDocumentPath(rootDir, input.taskId, "progress.md"))
        ? readFileSync(taskDocumentPath(rootDir, input.taskId, "progress.md"), "utf8")
        : "";
      const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      const body = `${existing}${separator}${input.text}\n`;
      yield* writeTaskDocument(coordinator, input.taskId, "progress.md", body);
      return { taskId: input.taskId, path: "progress.md" } satisfies LocalProgressResult;
    })
  };
}

function writeTaskDocument(
  coordinator: WriteCoordinator,
  taskId: TaskId,
  documentPath: string,
  body: string
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    const opId = `${Date.now()}-${stablePayloadHash({ taskId, documentPath, body }).slice(0, 16)}`;
    yield* coordinator.enqueue({
      opId,
      taskId,
      kind: "doc_write",
      payload: {
        path: documentPath,
        body
      }
    });
    yield* coordinator.flush("explicit");
  });
}

function makeIndex(input: {
  readonly taskId: TaskId;
  readonly title: string;
  readonly status: DomainStatus;
  readonly bindingCreatedAt: string;
  readonly vertical: string;
  readonly preset: string;
}): LocalTaskIndex {
  const fingerprint = stablePayloadHash({
    engine: "local",
    ref: null,
    bindingCreatedAt: input.bindingCreatedAt
  });
  return {
    taskId: input.taskId,
    title: input.title,
    engine: "local",
    status: input.status,
    ref: null,
    titleSnapshot: input.title,
    url: null,
    bindingCreatedAt: input.bindingCreatedAt,
    bindingFingerprint: `sha256:${fingerprint}`,
    packageDisposition: "active",
    vertical: input.vertical,
    preset: input.preset
  };
}

function renderIndex(index: LocalTaskIndex): string {
  return [
    "---",
    "schema: task-package/v2",
    `task_id: ${index.taskId}`,
    `title: ${index.title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    `  engine: ${index.engine}`,
    `  status: ${index.status}`,
    `  ref: ${index.ref ?? ""}`,
    `  titleSnapshot: ${index.titleSnapshot ?? ""}`,
    `  url: ${index.url ?? ""}`,
    `  bindingCreatedAt: ${index.bindingCreatedAt}`,
    `  bindingFingerprint: ${index.bindingFingerprint}`,
    `packageDisposition: ${index.packageDisposition}`,
    `vertical: ${index.vertical}`,
    `preset: ${index.preset}`,
    "---",
    "",
    `# ${index.title}`,
    ""
  ].join("\n");
}

function readIndexEffect(rootDir: string, taskId: TaskId): Effect.Effect<LocalTaskIndex, EngineError> {
  return Effect.try({
    try: () => readIndex(rootDir, taskId),
    catch: (cause): EngineError => ({
      _tag: "MalformedSnapshot",
      raw: isNodeErrorCode(cause, "ENOENT") ? `task not found: ${taskId}` : sanitizeReadError(cause)
    })
  });
}

function readIndex(rootDir: string, taskId: TaskId): LocalTaskIndex {
  validateTaskId(taskId);
  const body = readFileSync(indexPath(rootDir, taskId), "utf8");
  const frontmatter = body.match(/^---\n([\s\S]*?)\n---/u)?.[1];
  if (!frontmatter) throw new Error(`INDEX.md missing frontmatter: ${taskId}`);

  const status = readScalar(frontmatter, "  status");
  if (!isDomainStatus(status)) throw new Error(`invalid local status: ${status}`);

  return {
    taskId: readScalar(frontmatter, "task_id"),
    title: readScalar(frontmatter, "title"),
    engine: readScalar(frontmatter, "  engine"),
    status,
    ref: nullIfEmpty(readScalar(frontmatter, "  ref")),
    titleSnapshot: nullIfEmpty(readScalar(frontmatter, "  titleSnapshot")),
    url: nullIfEmpty(readScalar(frontmatter, "  url")),
    bindingCreatedAt: readScalar(frontmatter, "  bindingCreatedAt"),
    bindingFingerprint: readScalar(frontmatter, "  bindingFingerprint"),
    packageDisposition: readScalar(frontmatter, "packageDisposition") as LocalTaskIndex["packageDisposition"],
    vertical: readScalar(frontmatter, "vertical"),
    preset: readScalar(frontmatter, "preset")
  };
}

function readScalar(frontmatter: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = frontmatter.match(new RegExp(`^${escaped}:\\s*(.*)$`, "mu"))?.[1];
  if (value === undefined) throw new Error(`frontmatter missing ${key.trim()}`);
  return value.trim();
}

function nullIfEmpty(value: string): string | null {
  return value.length === 0 ? null : value;
}

function canTransition(from: DomainStatus, to: DomainStatus): boolean {
  if (from === to) return true;
  if (isTerminalStatus(from)) return false;
  if (from === "planned") return to === "active" || to === "blocked" || to === "cancelled";
  if (from === "active") return to === "blocked" || to === "in_review" || to === "done" || to === "cancelled";
  if (from === "blocked") return to === "active" || to === "cancelled";
  if (from === "in_review") return to === "active" || to === "blocked" || to === "done" || to === "cancelled";
  return false;
}

function validateTaskId(taskId: TaskId): void {
  if (taskId.length === 0 || taskId.includes("/") || taskId.includes("..")) {
    throw new Error(`invalid task id: ${taskId}`);
  }
}

function indexPath(rootDir: string, taskId: TaskId): string {
  return taskDocumentPath(rootDir, taskId, "INDEX.md");
}

function taskDocumentPath(rootDir: string, taskId: TaskId, documentPath: string): string {
  return path.join(rootDir, "tasks", taskId, documentPath);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sanitizeReadError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/'[^']*'/gu, "[path]") : "malformed task package";
}
