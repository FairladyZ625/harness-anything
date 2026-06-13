import { readFileSync } from "node:fs";
import { Effect } from "effect";
import type { DomainStatus, EngineError, TaskId } from "../../../kernel/src/domain/index.ts";
import { isDomainStatus, isPackageDisposition } from "../../../kernel/src/domain/index.ts";
import { isGeneratedTaskId, taskDocumentPath as harnessTaskDocumentPath, validateTaskIdSyntax } from "../../../kernel/src/layout/index.ts";
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
    : { _tag: "MalformedSnapshot", raw: `task id must be generated: ${taskId}` };
}

export function makeIndex(input: {
  readonly taskId: TaskId;
  readonly title: string;
  readonly status: DomainStatus;
  readonly bindingCreatedAt: string;
  readonly vertical: string;
  readonly preset: string;
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

export function readIndexEffect(rootDir: string, taskId: TaskId): Effect.Effect<LocalTaskIndex, EngineError> {
  return Effect.try({
    try: () => readIndex(rootDir, taskId),
    catch: (cause): EngineError => ({
      _tag: "MalformedSnapshot",
      raw: isNodeErrorCode(cause, "ENOENT") ? `task not found: ${taskId}` : sanitizeReadError(cause)
    })
  });
}

export function readIndex(rootDir: string, taskId: TaskId): LocalTaskIndex {
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

export function indexPath(rootDir: string, taskId: TaskId): string {
  return taskDocumentPath(rootDir, taskId, "INDEX.md");
}

export function taskDocumentPath(rootDir: string, taskId: TaskId, documentPath: string): string {
  return harnessTaskDocumentPath(rootDir, taskId, documentPath);
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

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sanitizeReadError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/'[^']*'/gu, "[path]") : "malformed task package";
}
