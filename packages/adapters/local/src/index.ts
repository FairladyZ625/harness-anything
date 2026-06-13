import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { DomainStatus, EngineError, PackageDisposition, TaskId, WriteError } from "../../../kernel/src/domain/index.ts";
import { findEntityRefs, isDomainStatus, isPackageDisposition, isTerminalStatus } from "../../../kernel/src/domain/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/ports/index.ts";
import type { WriteOpKind } from "../../../kernel/src/ports/write-coordinator.ts";
import { makeJournaledWriteCoordinator, type JournalActor } from "../../../kernel/src/store/index.ts";
import { stablePayloadHash } from "../../../kernel/src/store/hash.ts";
import { isGeneratedTaskId, resolveHarnessLayout, taskDocumentPath as harnessTaskDocumentPath, taskPackagePath, validateTaskIdSyntax } from "../../../kernel/src/layout/index.ts";
import { resolveTaskCreatedBy, type TaskCreatedBy } from "./created-by.ts";

export { collectGitDiffEvidence } from "./git-diff-evidence.ts";
export type { GitDiffEvidenceFile, GitDiffEvidenceOptions, GitDiffEvidenceReport } from "./git-diff-evidence.ts";

export interface LocalLifecycleOptions {
  readonly rootDir: string;
  readonly coordinator?: WriteCoordinator;
  readonly clock?: () => Date;
}

export interface LocalWriteCoordinatorOptions {
  readonly rootDir: string;
  readonly actor?: JournalActor;
}

export interface CreateLocalTaskInput {
  readonly taskId: TaskId;
  readonly title: string;
  readonly allowManualId?: boolean;
  readonly slug?: string;
  readonly vertical?: string;
  readonly preset?: string;
  readonly createdBy?: TaskCreatedBy;
}

export interface SetLocalStatusInput {
  readonly taskId: TaskId;
  readonly status: DomainStatus;
}

export interface AppendProgressInput {
  readonly taskId: TaskId;
  readonly text: string;
}

export interface TaskReasonInput {
  readonly taskId: TaskId;
  readonly reason: string;
}

export interface SupersedeTaskInput {
  readonly oldTaskId: TaskId;
  readonly newTaskId: TaskId;
  readonly title: string;
  readonly slug: string;
  readonly reason: string;
}

export type DeleteMode = "soft" | "hard";

export interface DeleteTaskInput extends TaskReasonInput {
  readonly mode: DeleteMode;
}

export interface LocalTaskResult {
  readonly taskId: TaskId;
  readonly status: DomainStatus;
  readonly engine: "local";
  readonly packageDisposition?: PackageDisposition;
}

export interface LocalProgressResult {
  readonly taskId: TaskId;
  readonly path: "progress.md";
}

export interface LocalSupersedeResult {
  readonly oldTaskId: TaskId;
  readonly newTaskId: TaskId;
  readonly packageDisposition: "archived";
}

export interface LocalDeleteResult {
  readonly taskId: TaskId;
  readonly mode: DeleteMode;
  readonly packageDisposition?: "tombstoned";
}

export interface LocalLifecycleEngine {
  readonly createTask: (input: CreateLocalTaskInput) => Effect.Effect<LocalTaskResult, EngineError | WriteError>;
  readonly setStatus: (input: SetLocalStatusInput) => Effect.Effect<LocalTaskResult, EngineError | WriteError>;
  readonly appendProgress: (input: AppendProgressInput) => Effect.Effect<LocalProgressResult, EngineError | WriteError>;
  readonly archiveTask: (input: TaskReasonInput) => Effect.Effect<LocalTaskResult, EngineError | WriteError>;
  readonly supersedeTask: (input: SupersedeTaskInput) => Effect.Effect<LocalSupersedeResult, EngineError | WriteError>;
  readonly deleteTask: (input: DeleteTaskInput) => Effect.Effect<LocalDeleteResult, EngineError | WriteError>;
  readonly reopenTask: (input: TaskReasonInput) => Effect.Effect<LocalTaskResult, EngineError | WriteError>;
}

export function makeLocalWriteCoordinator(options: LocalWriteCoordinatorOptions): WriteCoordinator {
  return makeJournaledWriteCoordinator(options);
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
  readonly createdBy?: TaskCreatedBy;
}

export function makeLocalLifecycleEngine(options: LocalLifecycleOptions): LocalLifecycleEngine {
  const rootDir = path.resolve(options.rootDir);
  const coordinator = options.coordinator ?? makeJournaledWriteCoordinator({ rootDir, actor: { kind: "agent", id: "local-lifecycle" } });
  const clock = options.clock ?? (() => new Date());

  return {
    createTask: (input) => Effect.gen(function* () {
      validateTaskId(input.taskId);
      if (!input.allowManualId && !isGeneratedTaskId(input.taskId)) {
        return yield* Effect.fail({ _tag: "MalformedSnapshot", raw: `task id must be generated: ${input.taskId}` } satisfies EngineError);
      }
      if (existsSync(indexPath(rootDir, input.taskId))) {
        return yield* Effect.fail({ _tag: "MalformedSnapshot", raw: `task already exists: ${input.taskId}` } satisfies EngineError);
      }
      const bindingCreatedAt = clock().toISOString();
      const createdBy = resolveTaskCreatedBy(rootDir, input.createdBy);
      const index = makeIndex({
        taskId: input.taskId,
        title: input.title,
        status: "planned",
        bindingCreatedAt,
        vertical: input.vertical ?? "default",
        preset: input.preset ?? "default",
        createdBy
      });
      yield* writeTaskDocument(coordinator, input.taskId, "INDEX.md", renderIndex(index), {
        kind: "package_create",
        slug: input.slug
      });
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
      yield* writeTaskDocument(coordinator, input.taskId, "INDEX.md", renderIndex(next), { kind: "transition_local" });
      return { taskId: input.taskId, status: input.status, engine: "local" } satisfies LocalTaskResult;
    }),
    appendProgress: (input) => Effect.gen(function* () {
      yield* readIndexEffect(rootDir, input.taskId);
      const existing = existsSync(taskDocumentPath(rootDir, input.taskId, "progress.md"))
        ? readFileSync(taskDocumentPath(rootDir, input.taskId, "progress.md"), "utf8")
        : "";
      const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      const body = `${existing}${separator}${input.text}\n`;
      yield* writeTaskDocument(coordinator, input.taskId, "progress.md", body, { kind: "progress_append" });
      return { taskId: input.taskId, path: "progress.md" } satisfies LocalProgressResult;
    }),
    archiveTask: (input) => Effect.gen(function* () {
      const index = yield* readIndexEffect(rootDir, input.taskId);
      const next = { ...index, packageDisposition: "archived" as const };
      yield* writeTaskDocument(coordinator, input.taskId, "INDEX.md", renderIndex(next, input.reason), { kind: "package_archive" });
      return { taskId: input.taskId, status: index.status, engine: "local", packageDisposition: "archived" } satisfies LocalTaskResult;
    }),
    supersedeTask: (input) => Effect.gen(function* () {
      validateTaskId(input.newTaskId);
      if (!isGeneratedTaskId(input.newTaskId)) {
        return yield* Effect.fail({ _tag: "MalformedSnapshot", raw: `task id must be generated: ${input.newTaskId}` } satisfies EngineError);
      }
      if (existsSync(indexPath(rootDir, input.newTaskId))) {
        return yield* Effect.fail({ _tag: "MalformedSnapshot", raw: `task already exists: ${input.newTaskId}` } satisfies EngineError);
      }
      const oldIndex = yield* readIndexEffect(rootDir, input.oldTaskId);
      const bindingCreatedAt = clock().toISOString();
      const createdBy = resolveTaskCreatedBy(rootDir);
      const newIndex = makeIndex({
        taskId: input.newTaskId,
        title: input.title,
        status: "planned",
        bindingCreatedAt,
        vertical: oldIndex.vertical,
        preset: oldIndex.preset,
        createdBy
      });
      const archivedOld = { ...oldIndex, packageDisposition: "archived" as const };
      const relationBody = renderSupersedesRelation(input.newTaskId, input.oldTaskId, input.reason);
      yield* writeSupersedeTaskDocuments(coordinator, [
        { taskId: input.oldTaskId, path: "INDEX.md", body: renderIndex(archivedOld, input.reason) },
        { taskId: input.newTaskId, path: "INDEX.md", body: renderIndex(newIndex), packageSlug: input.slug },
        { taskId: input.newTaskId, path: "relations.md", body: relationBody, packageSlug: input.slug }
      ]);
      return { oldTaskId: input.oldTaskId, newTaskId: input.newTaskId, packageDisposition: "archived" } satisfies LocalSupersedeResult;
    }),
    deleteTask: (input) => Effect.gen(function* () {
      const index = yield* readIndexEffect(rootDir, input.taskId);
      if (input.mode === "soft") {
        const next = { ...index, packageDisposition: "tombstoned" as const };
        yield* writeTaskDocument(coordinator, input.taskId, "INDEX.md", renderIndex(next, input.reason), { kind: "package_tombstone" });
        return { taskId: input.taskId, mode: "soft", packageDisposition: "tombstoned" } satisfies LocalDeleteResult;
      }
      if (index.packageDisposition === "archived") {
        return yield* Effect.fail({ _tag: "ArchivedHardDeleteForbidden", taskId: input.taskId } satisfies EngineError);
      }
      if (isTerminalStatus(index.status)) {
        return yield* Effect.fail({ _tag: "TerminalHardDeleteForbidden", taskId: input.taskId, status: index.status } satisfies EngineError);
      }
      if (hasTaskRelations(rootDir, input.taskId)) {
        return yield* Effect.fail({ _tag: "RelatedTaskHardDeleteForbidden", taskId: input.taskId } satisfies EngineError);
      }
      yield* deleteTaskPackage(coordinator, input.taskId, input.reason);
      return { taskId: input.taskId, mode: "hard" } satisfies LocalDeleteResult;
    }),
    reopenTask: (input) => Effect.gen(function* () {
      const index = yield* readIndexEffect(rootDir, input.taskId);
      if (isTerminalStatus(index.status)) {
        return yield* Effect.fail({ _tag: "TerminalReopenRequiresSupersede", taskId: input.taskId, status: index.status } satisfies EngineError);
      }
      const next = { ...index, packageDisposition: "active" as const };
      yield* writeTaskDocument(coordinator, input.taskId, "INDEX.md", renderIndex(next, input.reason), { kind: "package_reopen" });
      return { taskId: input.taskId, status: index.status, engine: "local", packageDisposition: "active" } satisfies LocalTaskResult;
    })
  };
}

interface TaskDocumentWrite {
  readonly taskId: TaskId;
  readonly path: string;
  readonly body: string;
  readonly kind: WriteOpKind;
  readonly packageSlug?: string;
}

interface SupersedeDocumentWrite {
  readonly taskId: TaskId;
  readonly path: string;
  readonly body: string;
  readonly packageSlug?: string;
}

function writeTaskDocument(
  coordinator: WriteCoordinator,
  taskId: TaskId,
  documentPath: string,
  body: string,
  options: {
    readonly kind?: WriteOpKind;
    readonly slug?: string;
  } = {}
): Effect.Effect<void, WriteError> {
  return writeTaskDocuments(coordinator, [{
    taskId,
    path: documentPath,
    body,
    kind: options.kind ?? "doc_write",
    packageSlug: options.slug
  }]);
}

function writeTaskDocuments(
  coordinator: WriteCoordinator,
  writes: ReadonlyArray<TaskDocumentWrite>
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    for (const write of writes) {
      const opId = `${Date.now()}-${stablePayloadHash(write).slice(0, 16)}`;
      yield* coordinator.enqueue({
        opId,
        taskId: write.taskId,
        kind: write.kind,
        payload: {
          path: write.path,
          body: write.body,
          ...(write.packageSlug ? { packageSlug: write.packageSlug } : {})
        }
      });
    }
    yield* coordinator.flush("explicit");
  });
}

function writeSupersedeTaskDocuments(
  coordinator: WriteCoordinator,
  writes: ReadonlyArray<SupersedeDocumentWrite>
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    const opId = `${Date.now()}-${stablePayloadHash({ kind: "package_supersede", writes }).slice(0, 16)}`;
    yield* coordinator.enqueue({
      opId,
      taskId: writes[0]?.taskId ?? "unknown",
      kind: "package_supersede",
      payload: { writes }
    });
    yield* coordinator.flush("explicit");
  });
}

function deleteTaskPackage(
  coordinator: WriteCoordinator,
  taskId: TaskId,
  reason: string
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    const opId = `${Date.now()}-${stablePayloadHash({ taskId, reason, kind: "package_delete_hard" }).slice(0, 16)}`;
    yield* coordinator.enqueue({
      opId,
      taskId,
      kind: "package_delete_hard",
      payload: { reason }
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
  readonly createdBy?: TaskCreatedBy;
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
    preset: input.preset,
    ...(input.createdBy ? { createdBy: input.createdBy } : {})
  };
}

function renderIndex(index: LocalTaskIndex, reason?: string): string {
  const lines = [
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
    ...(index.createdBy ? [
      "createdBy:",
      `  name: ${index.createdBy.name}`,
      `  email: ${index.createdBy.email}`
    ] : []),
    "---",
    "",
    `# ${index.title}`,
    ""
  ];
  if (reason && reason.length > 0) {
    lines.push("## Lifecycle Note", "", reason, "");
  }
  return lines.join("\n");
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
    packageDisposition: readPackageDisposition(frontmatter),
    vertical: readScalar(frontmatter, "vertical"),
    preset: readScalar(frontmatter, "preset"),
    ...readCreatedBy(frontmatter)
  };
}

function readScalar(frontmatter: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = frontmatter.match(new RegExp(`^${escaped}:[ \\t]*(.*)$`, "mu"))?.[1];
  if (value === undefined) throw new Error(`frontmatter missing ${key.trim()}`);
  return value.trim();
}

function nullIfEmpty(value: string): string | null {
  return value.length === 0 ? null : value;
}

function readCreatedBy(frontmatter: string): { readonly createdBy?: TaskCreatedBy } {
  const block = frontmatter.match(/^createdBy:\n((?:[ \t]+[^\n]*\n?)*)/mu)?.[1];
  if (!block) return {};
  const name = readOptionalNestedScalar(block, "name");
  const email = readOptionalNestedScalar(block, "email");
  return name && email ? { createdBy: { name, email } } : {};
}

function readOptionalNestedScalar(block: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return block.match(new RegExp(`^[ \\t]+${escaped}:[ \\t]*(.*)$`, "mu"))?.[1]?.trim() ?? "";
}

function readPackageDisposition(frontmatter: string): LocalTaskIndex["packageDisposition"] {
  const value = readScalar(frontmatter, "packageDisposition");
  return isPackageDisposition(value) ? value : "active";
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
  validateTaskIdSyntax(taskId);
}

function renderSupersedesRelation(newTaskId: TaskId, oldTaskId: TaskId, reason: string): string {
  return [
    "---",
    "schema: task-relations/v1",
    `source: task/${newTaskId}`,
    `target: task/${oldTaskId}`,
    "type: supersedes",
    "strength: strong",
    "direction: directed",
    "provenance: declared",
    "state: active",
    "---",
    "",
    "# Supersedes",
    "",
    `task/${newTaskId} supersedes task/${oldTaskId}.`,
    "",
    "## Reason",
    "",
    reason,
    ""
  ].join("\n");
}

function hasTaskRelations(rootDir: string, taskId: TaskId): boolean {
  const layout = resolveHarnessLayout(rootDir);
  const ownPackage = taskPackagePath(rootDir, taskId);
  for (const filePath of listTextFiles(layout.authoredRoot)) {
    const body = readFileSync(filePath, "utf8");
    const refs = findEntityRefs(body);
    if (refs.some((ref) => !ref.externalHarness && ref.id === taskId)) return true;
    if (filePath.startsWith(ownPackage) && refs.some((ref) => !ref.externalHarness && ref.id !== taskId)) return true;
  }
  return false;
}

function listTextFiles(inputPath: string): ReadonlyArray<string> {
  if (!existsSync(inputPath)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(inputPath, { withFileTypes: true })) {
    const fullPath = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTextFiles(fullPath));
      continue;
    }
    if (/\.(md|markdown|txt|ya?ml|json)$/iu.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function indexPath(rootDir: string, taskId: TaskId): string {
  return taskDocumentPath(rootDir, taskId, "INDEX.md");
}

function taskDocumentPath(rootDir: string, taskId: TaskId, documentPath: string): string {
  return harnessTaskDocumentPath(rootDir, taskId, documentPath);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sanitizeReadError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/'[^']*'/gu, "[path]") : "malformed task package";
}
