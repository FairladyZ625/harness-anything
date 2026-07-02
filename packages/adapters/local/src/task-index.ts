import { readFileSync } from "node:fs";
import { Effect } from "effect";
import type { DomainStatus, EngineError, TaskId } from "../../../kernel/src/domain/index.ts";
import { isDomainStatus, isPackageDisposition } from "../../../kernel/src/domain/index.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/layout/index.ts";
import { isGeneratedTaskId, taskDocumentPath as harnessTaskDocumentPath, validateTaskIdSyntax } from "../../../kernel/src/layout/index.ts";
import { readFrontmatter, readNestedScalar, readScalar } from "../../../kernel/src/markdown/frontmatter.ts";
import type { TaskCreatedBy } from "./created-by.ts";
import type { LocalTaskIndex } from "./types.ts";

export type HashPayload = (value: unknown) => string;

export function validateTaskId(taskId: TaskId): void {
  validateTaskIdSyntax(taskId);
}

export function validateGeneratedTaskId(taskId: TaskId): EngineError | undefined {
  validateTaskId(taskId);
  return isGeneratedTaskId(taskId)
    ? undefined
    : { _tag: "GeneratedTaskIdRequired", taskId };
}

export function makeIndex(input: {
  readonly taskId: TaskId;
  readonly title: string;
  readonly status: DomainStatus;
  readonly bindingCreatedAt: string;
  readonly vertical: string;
  readonly preset: string;
  readonly profile?: string;
  readonly createdBy?: TaskCreatedBy;
}, hashPayload: HashPayload): LocalTaskIndex {
  const fingerprint = hashPayload({
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
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {})
  };
}

export function renderIndex(index: LocalTaskIndex, reason?: string): string {
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
    ...(index.profile ? [`profile: ${index.profile}`] : []),
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

export function readIndexEffect(rootInput: HarnessLayoutInput, taskId: TaskId): Effect.Effect<LocalTaskIndex, EngineError> {
  return Effect.try({
    try: () => readIndex(rootInput, taskId),
    catch: (cause): EngineError => isNodeErrorCode(cause, "ENOENT")
      ? { _tag: "TaskNotFound", taskId }
      : { _tag: "MalformedSnapshot", raw: sanitizeReadError(cause) }
  });
}

export function readIndex(rootInput: HarnessLayoutInput, taskId: TaskId): LocalTaskIndex {
  validateTaskId(taskId);
  const body = readFileSync(indexPath(rootInput, taskId), "utf8");
  const frontmatter = readFrontmatter(body);
  if (!frontmatter) throw new Error(`INDEX.md missing frontmatter: ${taskId}`);

  const status = readScalar(frontmatter, "  status", { required: true });
  if (!isDomainStatus(status)) throw new Error(`invalid local status: ${status}`);

  return {
    taskId: readScalar(frontmatter, "task_id", { required: true }),
    title: readScalar(frontmatter, "title", { required: true }),
    engine: readScalar(frontmatter, "  engine", { required: true }),
    status,
    ref: nullIfEmpty(readScalar(frontmatter, "  ref", { required: true })),
    titleSnapshot: nullIfEmpty(readScalar(frontmatter, "  titleSnapshot", { required: true })),
    url: nullIfEmpty(readScalar(frontmatter, "  url", { required: true })),
    bindingCreatedAt: readScalar(frontmatter, "  bindingCreatedAt", { required: true }),
    bindingFingerprint: readScalar(frontmatter, "  bindingFingerprint", { required: true }),
    packageDisposition: readPackageDisposition(frontmatter),
    vertical: readScalar(frontmatter, "vertical", { required: true }),
    preset: readScalar(frontmatter, "preset", { required: true }),
    ...readProfile(frontmatter),
    ...readCreatedBy(frontmatter)
  };
}

export function indexPath(rootInput: HarnessLayoutInput, taskId: TaskId): string {
  return taskDocumentPath(rootInput, taskId, "INDEX.md");
}

export function taskDocumentPath(rootInput: HarnessLayoutInput, taskId: TaskId, documentPath: string): string {
  return harnessTaskDocumentPath(rootInput, taskId, documentPath);
}

function nullIfEmpty(value: string): string | null {
  return value.length === 0 ? null : value;
}

function readCreatedBy(frontmatter: string): { readonly createdBy?: TaskCreatedBy } {
  const block = frontmatter.match(/^createdBy:\n((?:[ \t]+[^\n]*\n?)*)/mu)?.[1];
  if (!block) return {};
  const name = readNestedScalar(block, "name");
  const email = readNestedScalar(block, "email");
  return name && email ? { createdBy: { name, email } } : {};
}

function readPackageDisposition(frontmatter: string): LocalTaskIndex["packageDisposition"] {
  const value = readScalar(frontmatter, "packageDisposition", { required: true });
  return isPackageDisposition(value) ? value : "active";
}

function readProfile(frontmatter: string): { readonly profile?: string } {
  const profile = frontmatter.match(/^profile:[ \t]*(.*)$/mu)?.[1]?.trim() ?? "";
  return profile ? { profile } : {};
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sanitizeReadError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/'[^']*'/gu, "[path]") : "malformed task package";
}
