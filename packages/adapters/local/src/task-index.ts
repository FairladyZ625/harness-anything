import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import type { DomainStatus, EngineError, TaskId } from "../../../kernel/src/domain/index.ts";
import { isDomainStatus, isPackageDisposition } from "../../../kernel/src/domain/index.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/layout/index.ts";
import { isGeneratedTaskId, taskDocumentPath as harnessTaskDocumentPath, validateTaskIdSyntax } from "../../../kernel/src/layout/index.ts";
import { readFrontmatter, readNestedScalar, readScalar } from "../../../kernel/src/markdown/frontmatter.ts";
import type { ProvenancePayload } from "../../../kernel/src/ports/index.ts";
import { ProvenanceEntrySchema } from "../../../kernel/src/schemas/common.ts";
import type { TaskCreatedBy } from "./created-by.ts";
import type { LocalTaskIndex } from "./types.ts";

export type HashPayload = (value: unknown) => string;

const ProvenanceListSchema = Schema.Array(ProvenanceEntrySchema).pipe(Schema.minItems(1));

export function validateTaskId(taskId: TaskId): void {
  validateTaskIdSyntax(taskId);
}

export function validateGeneratedTaskId(taskId: TaskId): EngineError | undefined {
  validateTaskId(taskId);
  return isGeneratedTaskId(taskId)
    ? undefined
    : { _tag: "GeneratedTaskIdRequired", taskId };
}

export function assertValidParentBinding(
  rootInput: HarnessLayoutInput,
  childTaskId: TaskId,
  parentTaskId: TaskId
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  validateTaskId(childTaskId);
  validateTaskId(parentTaskId);
  if (childTaskId === parentTaskId) {
    return { ok: false, reason: `parent cycle detected: ${childTaskId} -> ${parentTaskId}` };
  }
  if (!existsIndex(rootInput, parentTaskId)) {
    return { ok: false, reason: `parent task not found: ${parentTaskId}` };
  }

  const chain = [childTaskId, parentTaskId];
  const visited = new Set<string>([childTaskId]);
  let current = parentTaskId;
  while (current) {
    if (visited.has(current)) {
      return { ok: false, reason: `parent cycle detected: ${chain.concat(current).join(" -> ")}` };
    }
    visited.add(current);
    const parent = readIndex(rootInput, current).parent;
    if (!parent) return { ok: true };
    chain.push(parent);
    current = parent;
  }
  return { ok: true };
}

export function makeIndex(input: {
  readonly taskId: TaskId;
  readonly title: string;
  readonly parent?: TaskId;
  readonly status: DomainStatus;
  readonly bindingCreatedAt: string;
  readonly vertical: string;
  readonly preset: string;
  readonly provenance?: ReadonlyArray<ProvenancePayload>;
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
    ...(input.parent ? { parent: input.parent } : {}),
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
    provenance: input.provenance ?? [humanFallbackProvenance(input.bindingCreatedAt)],
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
    ...(index.parent ? [`parent: ${index.parent}`] : []),
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
    "provenance:",
    ...index.provenance.map((entry) => `  - {runtime: ${JSON.stringify(entry.runtime)}, sessionId: ${JSON.stringify(entry.sessionId)}, boundAt: ${JSON.stringify(entry.boundAt)}}`),
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
  const bindingCreatedAt = readScalar(frontmatter, "  bindingCreatedAt", { required: true });
  const provenance = parseProvenance(frontmatter);

  return {
    taskId: readScalar(frontmatter, "task_id", { required: true }),
    title: readScalar(frontmatter, "title", { required: true }),
    ...readParent(frontmatter),
    engine: readScalar(frontmatter, "  engine", { required: true }),
    status,
    ref: nullIfEmpty(readScalar(frontmatter, "  ref", { required: true })),
    titleSnapshot: nullIfEmpty(readScalar(frontmatter, "  titleSnapshot", { required: true })),
    url: nullIfEmpty(readScalar(frontmatter, "  url", { required: true })),
    bindingCreatedAt,
    bindingFingerprint: readScalar(frontmatter, "  bindingFingerprint", { required: true }),
    packageDisposition: readPackageDisposition(frontmatter),
    vertical: readScalar(frontmatter, "vertical", { required: true }),
    preset: readScalar(frontmatter, "preset", { required: true }),
    provenance,
    ...readProfile(frontmatter),
    ...readCreatedBy(frontmatter)
  };
}

export function indexPath(rootInput: HarnessLayoutInput, taskId: TaskId): string {
  return taskDocumentPath(rootInput, taskId, "INDEX.md");
}

function existsIndex(rootInput: HarnessLayoutInput, taskId: TaskId): boolean {
  try {
    return Boolean(readIndex(rootInput, taskId));
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
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

function readParent(frontmatter: string): { readonly parent?: TaskId } {
  const parent = readScalar(frontmatter, "parent");
  return parent ? { parent } : {};
}

function humanFallbackProvenance(boundAt: string): ProvenancePayload {
  return {
    runtime: "human",
    sessionId: `human-cli-${Date.parse(boundAt)}`,
    boundAt
  };
}

function parseProvenance(frontmatter: string): ReadonlyArray<ProvenancePayload> {
  const provenanceInput = readIndentedBlock(frontmatter, "provenance")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => parseFlowObject(line.slice(2).trim()));
  return Schema.decodeUnknownSync(ProvenanceListSchema)(provenanceInput);
}

function readIndentedBlock(frontmatter: string, key: string): ReadonlyArray<string> {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*:/u.test(line)) break;
    block.push(line);
  }
  return block;
}

function parseFlowObject(value: string): Record<string, string> {
  const body = value.trim().replace(/^\{\s*/u, "").replace(/\s*\}$/u, "");
  const result: Record<string, string> = {};
  for (const part of body.split(",")) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    result[key] = unquote(part.slice(separator + 1).trim());
  }
  return result;
}

function unquote(value: string): string {
  if (!value) return "";
  if (!value.startsWith("\"") || !value.endsWith("\"")) return value;
  return value
    .slice(1, -1)
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\(["\\/bfnrt])/gu, (_, code: string) => {
      switch (code) {
        case "b": return "\b";
        case "f": return "\f";
        case "n": return "\n";
        case "r": return "\r";
        case "t": return "\t";
        default: return code;
      }
    });
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sanitizeReadError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/'[^']*'/gu, "[path]") : "malformed task package";
}
