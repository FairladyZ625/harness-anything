import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DocumentWrite } from "../ports/artifact-store-writer.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";
import type { EntityId } from "../domain/index.ts";
import { moduleKeyFromEntityId, taskEntityId } from "../domain/index.ts";
import { isContentAddressedBlobRef, readContentAddressedTextBlob, resolveContentAddressedBlobPath, type ContentAddressedBlobRef } from "./content-addressed-blob-store.ts";
import {
  createTaskPackagePath,
  type HarnessLayoutInput,
  normalizeRelativeDocumentPath,
  resolveHarnessLayout,
  taskPackagePath
} from "../layout/index.ts";
import { writeDocument } from "./markdown-artifact-store.ts";
import { decisionDocumentTargetPath, decisionWriteKinds, writeDecisionDocument } from "./write-journal-decision-documents.ts";
import { taskIdForWriteOp } from "./write-journal-entity.ts";
import { appendJsonLineDurably, writeFileDurably } from "./write-journal-durable.ts";
import { rejectTaskWrite, rejectWrite } from "./write-journal-rejection.ts";

export function applyWriteOp(rootInput: HarnessLayoutInput, op: WriteOp): DocumentWrite | null {
  if (decisionWriteKinds.has(op.kind)) {
    writeDecisionDocument(rootInput, op);
    const taskWrites = decisionPayloadTaskWrites(op.payload);
    if (taskWrites.length > 0) writeDocumentsAtomically(rootInput, taskWrites);
    return null;
  }
  if (op.kind === "module_registry_write") {
    writeModuleRegistry(rootInput, op);
    return null;
  }
  if (op.kind === "module_scaffold_write") {
    writeModuleScaffold(rootInput, op);
    return null;
  }
  if (op.kind === "machine_artifact_write") {
    const artifact = machineArtifactWrite(rootInput, op);
    writeFileDurably(artifact.targetPath, artifact.body);
    return null;
  }
  if (op.kind === "machine_artifact_append_jsonl") {
    const artifact = machineArtifactJsonlAppend(rootInput, op);
    appendJsonLineDurably(artifact.targetPath, artifact.value);
    return null;
  }
  if ((op.kind === "package_create" || op.kind === "package_supersede") && isBatchDocumentWritePayload(op.payload)) {
    writeDocumentsAtomically(rootInput, op.payload.writes);
    return null;
  }
  // ADR-0016 D2: delta-shaped progress_append reads the current on-disk file and
  // appends. Legacy full-snapshot progress_append ops fall through to the overwrite
  // path below (backward compatibility, discriminated by payload shape).
  if (op.kind === "progress_append" && isProgressAppendDeltaPayload(op.payload)) {
    return applyProgressAppendDelta(rootInput, op, op.payload);
  }
  if (op.kind === "doc_stage") {
    return null;
  }
  if (op.kind === "task_tree_stage") {
    return null;
  }
  if (!documentWriteKinds.has(op.kind)) {
    rejectWrite(`unsupported write op kind: ${op.kind}`, op.entityId);
  }
  const write = toDocumentWrite(op);
  writeDocument(rootInput, write);
  return write;
}

export function writeOpTouchedPaths(rootInput: HarnessLayoutInput, op: WriteOp): ReadonlyArray<string> {
  if (decisionWriteKinds.has(op.kind)) {
    return [
      decisionDocumentTargetPath(rootInput, op),
      ...decisionPayloadTaskWrites(op.payload).map((write) => documentTargetPath(rootInput, write))
    ];
  }
  if (op.kind === "module_registry_write") {
    return [path.join(resolveHarnessLayout(rootInput).authoredRoot, "modules.json")];
  }
  if (op.kind === "module_scaffold_write") {
    return moduleScaffoldWrites(rootInput, op).map((write) => write.targetPath);
  }
  if (op.kind === "machine_artifact_write") {
    const artifact = machineArtifactWrite(rootInput, op);
    return [
      artifact.targetPath,
      ...(artifact.bodyRef ? [resolveContentAddressedBlobPath(rootInput, artifact.bodyRef)] : [])
    ];
  }
  if (op.kind === "machine_artifact_append_jsonl") {
    const artifact = machineArtifactJsonlAppend(rootInput, op);
    return artifact.boundary === "runtime-event-ledger" ? [] : [artifact.targetPath];
  }
  if ((op.kind === "package_create" || op.kind === "package_supersede") && isBatchDocumentWritePayload(op.payload)) {
    return op.payload.writes.map((write) => documentTargetPath(rootInput, write));
  }
  if (op.kind === "package_delete_hard") {
    return [taskPackagePath(rootInput, taskIdForWriteOp(op))];
  }
  if (op.kind === "progress_append" && isProgressAppendDeltaPayload(op.payload)) {
    return [documentTargetPath(rootInput, progressAppendDeltaWrite(op, op.payload))];
  }
  if (op.kind === "doc_stage") {
    return [documentTargetPath(rootInput, documentStageWrite(op))];
  }
  if (op.kind === "task_tree_stage") {
    return [taskPackagePath(rootInput, taskIdForWriteOp(op))];
  }
  if (!documentWriteKinds.has(op.kind)) {
    rejectWrite(`unsupported write op kind: ${op.kind}`, op.entityId);
  }
  return [documentTargetPath(rootInput, toDocumentWrite(op))];
}

export function documentWritesForWriteOp(op: WriteOp): ReadonlyArray<DocumentWrite> {
  if (decisionWriteKinds.has(op.kind)) {
    return decisionPayloadTaskWrites(op.payload);
  }
  if (op.kind === "module_registry_write" || op.kind === "module_scaffold_write") {
    return [];
  }
  if (op.kind === "machine_artifact_write" || op.kind === "machine_artifact_append_jsonl") {
    return [];
  }
  if ((op.kind === "package_create" || op.kind === "package_supersede") && isBatchDocumentWritePayload(op.payload)) {
    return op.payload.writes;
  }
  if (op.kind === "package_delete_hard") {
    return [];
  }
  if (op.kind === "progress_append" && isProgressAppendDeltaPayload(op.payload)) {
    return [progressAppendDeltaWrite(op, op.payload)];
  }
  if (op.kind === "doc_stage") {
    return [];
  }
  if (op.kind === "task_tree_stage") {
    return [];
  }
  if (!documentWriteKinds.has(op.kind)) {
    rejectWrite(`unsupported write op kind: ${op.kind}`, op.entityId);
  }
  return [toDocumentWrite(op)];
}

export function isProgressAppendDeltaPayload(payload: unknown): payload is ProgressAppendDeltaPayload {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as { readonly path?: unknown; readonly append?: unknown };
  // An ambiguous payload carrying both `append` and `body` falls through to the
  // legacy snapshot path instead of silently ignoring `body` here.
  return typeof candidate.path === "string" && typeof candidate.append === "string" && !("body" in candidate);
}

interface ProgressAppendDeltaPayload {
  readonly path: string;
  readonly append: string;
  readonly packageSlug?: string;
}

interface BatchDocumentWritePayload {
  readonly writes: ReadonlyArray<DocumentWrite>;
}

interface ModuleRegistryWritePayload {
  readonly registry: unknown;
}

interface ModuleScaffoldWritePayload {
  readonly writes: ReadonlyArray<{ readonly path: string; readonly body: string }>;
}

interface MachineArtifactWritePayload {
  readonly boundary: MachineArtifactBoundary;
  readonly path: string;
  readonly body?: string;
  readonly bodyRef?: ContentAddressedBlobRef;
}

interface MachineArtifactAppendJsonlPayload {
  readonly boundary: MachineArtifactBoundary;
  readonly path: string;
  readonly value: unknown;
}

type MachineArtifactBoundary =
  | "runtime-event-ledger"
  | "provenance-session"
  | "docmap-derived"
  | "distill-candidate"
  | "legacy-forward"
  | "preset-evidence-registry";

const documentWriteKinds = new Set<WriteOp["kind"]>([
  "package_create",
  "transition_local",
  "progress_append",
  "doc_write",
  "fact_invalidate",
  "package_archive",
  "package_tombstone",
  "package_reopen",
  "package_supersede"
]);

function progressAppendDeltaWrite(op: WriteOp, payload: ProgressAppendDeltaPayload): DocumentWrite {
  const taskId = taskIdForWriteOp(op);
  return {
    taskId,
    path: payload.path,
    body: "",
    packageSlug: typeof payload.packageSlug === "string" ? payload.packageSlug : undefined
  };
}

function applyProgressAppendDelta(rootInput: HarnessLayoutInput, op: WriteOp, payload: ProgressAppendDeltaPayload): DocumentWrite {
  const targetPath = documentTargetPath(rootInput, progressAppendDeltaWrite(op, payload));
  const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const write: DocumentWrite = {
    taskId: taskIdForWriteOp(op),
    path: payload.path,
    body: `${existing}${separator}${payload.append}\n`,
    packageSlug: typeof payload.packageSlug === "string" ? payload.packageSlug : undefined
  };
  writeDocument(rootInput, write);
  return write;
}

function isBatchDocumentWritePayload(payload: unknown): payload is BatchDocumentWritePayload {
  if (!payload || typeof payload !== "object" || !("writes" in payload)) return false;
  return Array.isArray((payload as { readonly writes?: unknown }).writes);
}

function decisionPayloadTaskWrites(payload: unknown): ReadonlyArray<DocumentWrite> {
  if (!payload || typeof payload !== "object") return [];
  const taskWrites = (payload as { readonly taskWrites?: unknown }).taskWrites;
  if (!Array.isArray(taskWrites)) return [];
  return taskWrites.filter(isDocumentWrite);
}

function isDocumentWrite(value: unknown): value is DocumentWrite {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { readonly taskId?: unknown; readonly path?: unknown; readonly body?: unknown; readonly packageSlug?: unknown };
  return typeof candidate.taskId === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.body === "string" &&
    (candidate.packageSlug === undefined || typeof candidate.packageSlug === "string");
}

function writeDocumentsAtomically(rootInput: HarnessLayoutInput, writes: ReadonlyArray<DocumentWrite>): void {
  if (writes.length === 0) rejectWrite("batch document write requires at least one write");
  const entries = writes.map((write) => ({
    write,
    targetPath: documentTargetPath(rootInput, write)
  }));
  const targetPaths = new Set<string>();
  for (const entry of entries) {
    if (targetPaths.has(entry.targetPath)) rejectTaskWrite(`duplicate batch write target: ${entry.write.path}`, entry.write.taskId);
    targetPaths.add(entry.targetPath);
  }

  const backups = entries.map((entry) => ({
    targetPath: entry.targetPath,
    existed: existsSync(entry.targetPath),
    body: existsSync(entry.targetPath) ? readFileSync(entry.targetPath, "utf8") : null
  }));

  try {
    for (const entry of entries) writeDocument(rootInput, entry.write);
  } catch (error) {
    for (const backup of backups.reverse()) {
      if (backup.existed && backup.body !== null) {
        mkdirSync(path.dirname(backup.targetPath), { recursive: true });
        writeFileSync(backup.targetPath, backup.body, "utf8");
      } else {
        rmSync(backup.targetPath, { force: true });
      }
    }
    throw error;
  }
}

function documentTargetPath(rootInput: HarnessLayoutInput, write: DocumentWrite): string {
  const safePath = normalizeWriteDocumentPath(write.path, taskEntityId(write.taskId));
  const rootPath = existsSync(taskPackagePath(rootInput, write.taskId))
    ? taskPackagePath(rootInput, write.taskId)
    : createTaskPackagePath(rootInput, write.taskId, write.packageSlug);
  return path.join(rootPath, safePath);
}

function writeModuleRegistry(rootInput: HarnessLayoutInput, op: WriteOp): void {
  if (!isModuleRegistryWritePayload(op.payload)) {
    rejectWrite(`${op.kind} op requires registry payload: ${op.opId}`, op.entityId);
  }
  const targetPath = path.join(resolveHarnessLayout(rootInput).authoredRoot, "modules.json");
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileDurably(targetPath, `${JSON.stringify(op.payload.registry, null, 2)}\n`);
}

function isModuleRegistryWritePayload(payload: unknown): payload is ModuleRegistryWritePayload {
  return Boolean(payload && typeof payload === "object" && "registry" in payload);
}

function writeModuleScaffold(rootInput: HarnessLayoutInput, op: WriteOp): void {
  const writes = moduleScaffoldWrites(rootInput, op);
  for (const write of writes) {
    mkdirSync(path.dirname(write.targetPath), { recursive: true });
    writeFileDurably(write.targetPath, write.body.endsWith("\n") ? write.body : `${write.body}\n`);
  }
}

function machineArtifactWrite(rootInput: HarnessLayoutInput, op: WriteOp): { readonly targetPath: string; readonly body: string; readonly bodyRef?: ContentAddressedBlobRef } {
  const payload = op.payload;
  if (!isMachineArtifactWritePayload(payload)) {
    rejectWrite(`${op.kind} op requires boundary, path, and exactly one of body/bodyRef payload: ${op.opId}`, op.entityId);
  }
  return {
    targetPath: resolveMachineArtifactPath(rootInput, payload.boundary, payload.path, op.entityId),
    body: payload.body ?? readContentAddressedTextBlob(rootInput, payload.bodyRef!),
    ...(payload.bodyRef ? { bodyRef: payload.bodyRef } : {})
  };
}

function machineArtifactJsonlAppend(rootInput: HarnessLayoutInput, op: WriteOp): { readonly boundary: MachineArtifactBoundary; readonly targetPath: string; readonly value: Record<string, unknown> } {
  const payload = op.payload;
  if (!isMachineArtifactAppendJsonlPayload(payload)) {
    rejectWrite(`${op.kind} op requires boundary, path, and JSON object value payload: ${op.opId}`, op.entityId);
  }
  return {
    boundary: payload.boundary,
    targetPath: resolveMachineArtifactPath(rootInput, payload.boundary, payload.path, op.entityId),
    value: payload.value
  };
}

function isMachineArtifactWritePayload(payload: unknown): payload is MachineArtifactWritePayload {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as { readonly boundary?: unknown; readonly path?: unknown; readonly body?: unknown; readonly bodyRef?: unknown };
  const hasBody = typeof candidate.body === "string";
  const hasBodyRef = isContentAddressedBlobRef(candidate.bodyRef);
  return isMachineArtifactBoundary(candidate.boundary) &&
    typeof candidate.path === "string" &&
    hasBody !== hasBodyRef;
}

function isMachineArtifactAppendJsonlPayload(payload: unknown): payload is MachineArtifactAppendJsonlPayload & { readonly value: Record<string, unknown> } {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    isMachineArtifactBoundary((payload as { readonly boundary?: unknown }).boundary) &&
    typeof (payload as { readonly path?: unknown }).path === "string" &&
    isJsonRecord((payload as { readonly value?: unknown }).value)
  );
}

function isMachineArtifactBoundary(value: unknown): value is MachineArtifactBoundary {
  return value === "runtime-event-ledger" ||
    value === "provenance-session" ||
    value === "docmap-derived" ||
    value === "distill-candidate" ||
    value === "legacy-forward" ||
    value === "preset-evidence-registry";
}

function resolveMachineArtifactPath(
  rootInput: HarnessLayoutInput,
  boundary: MachineArtifactBoundary,
  relativePath: string,
  entityId?: EntityId
): string {
  const layout = resolveHarnessLayout(rootInput);
  const normalized = normalizePortableRootRelativePath(relativePath, entityId);
  const targetPath = path.resolve(layout.rootDir, normalized);
  if (!isInside(layout.rootDir, targetPath)) rejectWrite(`machine artifact path escapes root: ${relativePath}`, entityId);

  const authoredRelative = path.relative(layout.rootDir, layout.authoredRoot).split(path.sep).join("/");
  const generatedRelative = path.relative(layout.rootDir, layout.generatedRoot).split(path.sep).join("/");
  const tasksRelative = path.relative(layout.rootDir, layout.tasksRoot).split(path.sep).join("/");

  const allowed = boundary === "runtime-event-ledger"
    ? normalized.startsWith(`${generatedRelative}/runtime-events/`) && normalized.endsWith(".jsonl")
    : boundary === "provenance-session"
      ? normalized.startsWith(`${authoredRelative}/sessions/`) && normalized.endsWith(".md")
    : boundary === "docmap-derived"
      ? normalized === `${authoredRelative}/docmap.json`
      : boundary === "distill-candidate"
        ? normalized.startsWith(`${generatedRelative}/distill/`) && normalized.endsWith(".json")
        : boundary === "preset-evidence-registry"
          ? normalized.startsWith(`${tasksRelative}/`) && normalized.endsWith("/artifacts/.machine-evidence.registry.json")
          : isLegacyForwardPath(layout, normalized, authoredRelative);

  if (!allowed) rejectWrite(`machine artifact path is outside ${boundary} boundary: ${relativePath}`, entityId);
  return targetPath;
}

function normalizePortableRootRelativePath(relativePath: string, entityId?: EntityId): string {
  const normalized = path.posix.normalize(relativePath.replace(/\\/gu, "/"));
  if (normalized.length === 0 || normalized === "." || normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
    rejectWrite(`machine artifact path must be root-relative: ${relativePath}`, entityId);
  }
  return normalized;
}

function isLegacyForwardPath(layout: ReturnType<typeof resolveHarnessLayout>, normalized: string, authoredRelative: string): boolean {
  if (!normalized.startsWith(`${authoredRelative}/`)) return false;
  const blockedRoots = [
    path.relative(layout.rootDir, layout.legacyRoot),
    path.relative(layout.rootDir, layout.tasksRoot),
    path.relative(layout.rootDir, layout.decisionsRoot),
    path.relative(layout.rootDir, layout.sessionsRoot)
  ].map((entry) => entry.split(path.sep).join("/"));
  return !blockedRoots.some((blockedRoot) => normalized === blockedRoot || normalized.startsWith(`${blockedRoot}/`));
}

function isInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function moduleScaffoldWrites(rootInput: HarnessLayoutInput, op: WriteOp): ReadonlyArray<{ readonly targetPath: string; readonly body: string }> {
  const moduleKey = moduleKeyFromEntityId(op.entityId);
  if (!moduleKey) rejectWrite(`module write op requires module entity: ${op.entityId}`, op.entityId);
  if (!isModuleScaffoldWritePayload(op.payload)) {
    rejectWrite(`${op.kind} op requires scaffold writes payload: ${op.opId}`, op.entityId);
  }
  const moduleRoot = path.join(resolveHarnessLayout(rootInput).authoredRoot, "modules", moduleKey);
  return op.payload.writes.map((write) => {
    const safePath = normalizeWriteDocumentPath(write.path, op.entityId);
    const targetPath = path.join(moduleRoot, safePath);
    if (!targetPath.startsWith(`${moduleRoot}${path.sep}`) && targetPath !== moduleRoot) {
      rejectWrite(`module scaffold path escapes module root: ${write.path}`, op.entityId);
    }
    return { targetPath, body: write.body };
  });
}

function isModuleScaffoldWritePayload(payload: unknown): payload is ModuleScaffoldWritePayload {
  if (!payload || typeof payload !== "object" || !("writes" in payload)) return false;
  const writes = (payload as { readonly writes?: unknown }).writes;
  return Array.isArray(writes) && writes.every((write) => Boolean(
    write &&
    typeof write === "object" &&
    typeof (write as { readonly path?: unknown }).path === "string" &&
    typeof (write as { readonly body?: unknown }).body === "string"
  ));
}

function toDocumentWrite(op: WriteOp): DocumentWrite {
  const payload = op.payload as Partial<DocumentWrite> | undefined;
  if (!payload || typeof payload.path !== "string" || typeof payload.body !== "string") {
    rejectWrite(`${op.kind} op requires path and body payload: ${op.opId}`, op.entityId);
  }
  return {
    taskId: taskIdForWriteOp(op),
    path: payload.path,
    body: payload.body,
    packageSlug: typeof payload.packageSlug === "string" ? payload.packageSlug : undefined
  };
}

function documentStageWrite(op: WriteOp): DocumentWrite {
  const payload = op.payload as { readonly path?: unknown; readonly packageSlug?: unknown } | undefined;
  if (!payload || typeof payload.path !== "string") {
    rejectWrite(`${op.kind} op requires path payload: ${op.opId}`, op.entityId);
  }
  return {
    taskId: taskIdForWriteOp(op),
    path: payload.path,
    body: "",
    packageSlug: typeof payload.packageSlug === "string" ? payload.packageSlug : undefined
  };
}

function normalizeWriteDocumentPath(documentPath: string, entityId?: EntityId): string {
  try {
    return normalizeRelativeDocumentPath(documentPath);
  } catch (error) {
    rejectWrite(error instanceof Error ? error.message : String(error), entityId);
  }
}
