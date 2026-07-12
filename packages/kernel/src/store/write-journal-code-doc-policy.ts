import type { DocumentWrite } from "../ports/artifact-store-writer.ts";
import type { VersionControlSystem } from "../ports/version-control-system.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";
import { normalizeRelativeDocumentPath } from "../layout/index.ts";
import { makeCodeDocGitEvidenceResolver } from "../git/code-doc-git-evidence.ts";
import { rejectWrite } from "./write-journal-rejection.ts";
import { taskIdForWriteOp } from "./write-journal-entity.ts";

export const CODE_DOC_RECONCILIATION_PATH = "code-doc-anchors.json";

interface CodeDocAnchor {
  readonly kind: "commit" | "path" | "pr";
  readonly sha?: string;
  readonly path?: string;
  readonly ref?: string;
}

interface CodeDocRecord {
  readonly id: string;
  readonly ledgerPath: string;
  readonly kind: "closeout" | "review" | "evidence" | "decision-claim";
  readonly anchors: ReadonlyArray<CodeDocAnchor>;
}

interface CodeDocDocument {
  readonly schema: "code-doc-reconciliation/v1";
  readonly taskId: string;
  readonly records: ReadonlyArray<CodeDocRecord>;
}

export function assertReservedCodeDocWrite(
  op: WriteOp,
  writes: ReadonlyArray<DocumentWrite>
): void {
  const stagedPath = op.kind === "doc_stage" ? payloadPath(op) : undefined;
  const reservedWrites = writes.filter((write) => normalizedPath(write.path, op) === CODE_DOC_RECONCILIATION_PATH);
  const stagesReservedPath = stagedPath !== undefined && normalizedPath(stagedPath, op) === CODE_DOC_RECONCILIATION_PATH;

  if ((reservedWrites.length > 0 || stagesReservedPath) && op.kind !== "code_doc_reconcile") {
    rejectWrite(remediation(taskIdForWriteOp(op)), op.entityId);
  }
  if (op.kind !== "code_doc_reconcile") return;
  if (writes.length !== 1 || reservedWrites.length !== 1) {
    rejectWrite(`code_doc_reconcile may only write ${CODE_DOC_RECONCILIATION_PATH}`, op.entityId);
  }
  parseAndValidateDocument(reservedWrites[0]!, op);
}

export function assertCodeDocGitEvidence(
  rootDir: string,
  authoredRoot: string,
  op: WriteOp,
  versionControlSystem: VersionControlSystem
): void {
  if (op.kind !== "code_doc_reconcile") return;
  const document = parseAndValidateDocument(documentWrite(op), op);
  const gitEvidence = makeCodeDocGitEvidenceResolver({ rootDir, authoredRoot }, versionControlSystem);
  for (const record of document.records) {
    for (const anchor of record.anchors) {
      if (!anchor.sha) continue;
      const resolution = gitEvidence.resolve({
        sha: anchor.sha,
        ...(anchor.kind === "path" ? { path: anchor.path! } : {})
      });
      if (!resolution.ok && resolution.reason === "commit-missing") {
        rejectWrite(`code-doc anchor commit does not exist: ${anchor.sha}`, op.entityId);
      }
      if (!resolution.ok) {
        rejectWrite(`code-doc anchor path does not exist at ${anchor.sha}: ${anchor.path}`, op.entityId);
      }
    }
  }
}

export function assertNoUncoordinatedCodeDocChange(op: WriteOp, status: string): void {
  if (op.kind !== "task_tree_stage") return;
  const dirtyReservedPath = status
    .split(/\r?\n/u)
    .map(statusPath)
    .find((entry) => entry && entry.split("/").at(-1) === CODE_DOC_RECONCILIATION_PATH);
  if (dirtyReservedPath) rejectWrite(remediation(taskIdForWriteOp(op)), op.entityId);
}

function parseAndValidateDocument(write: DocumentWrite, op: WriteOp): CodeDocDocument {
  let value: unknown;
  try {
    value = JSON.parse(write.body);
  } catch {
    rejectWrite(`${CODE_DOC_RECONCILIATION_PATH} must contain valid JSON`, op.entityId);
  }
  if (!isObject(value) || value.schema !== "code-doc-reconciliation/v1") {
    rejectWrite(`${CODE_DOC_RECONCILIATION_PATH} must use schema code-doc-reconciliation/v1`, op.entityId);
  }
  const taskId = taskIdForWriteOp(op);
  if (value.taskId !== taskId || !Array.isArray(value.records) || value.records.length === 0) {
    rejectWrite(`${CODE_DOC_RECONCILIATION_PATH} must match task ${taskId} and contain records`, op.entityId);
  }
  const ids = new Set<string>();
  const records = value.records.map((record, index) => validateRecord(record, index, ids, op));
  return { schema: "code-doc-reconciliation/v1", taskId, records };
}

function validateRecord(
  value: unknown,
  index: number,
  ids: Set<string>,
  op: WriteOp
): CodeDocRecord {
  if (!isObject(value) || typeof value.id !== "string" || value.id.length === 0 || ids.has(value.id)) {
    rejectWrite(`code-doc record ${index} requires a unique id`, op.entityId);
  }
  const recordId = value.id;
  ids.add(recordId);
  if (typeof value.ledgerPath !== "string" || !isRecordKind(value.kind)) {
    rejectWrite(`code-doc record ${value.id} requires ledgerPath and a supported record kind`, op.entityId);
  }
  const ledgerPath = normalizedPath(value.ledgerPath, op);
  if (!Array.isArray(value.anchors) || value.anchors.length === 0) {
    rejectWrite(`code-doc record ${value.id} requires anchors`, op.entityId);
  }
  const anchors = value.anchors.map((anchor, anchorIndex) => validateAnchor(anchor, recordId, anchorIndex, op));
  if (!anchors.some((anchor) => anchor.kind === "commit" || anchor.kind === "path")) {
    rejectWrite(`code-doc record ${value.id} requires a commit or path anchor`, op.entityId);
  }
  return { id: value.id, ledgerPath, kind: value.kind, anchors };
}

function validateAnchor(value: unknown, recordId: string, index: number, op: WriteOp): CodeDocAnchor {
  if (!isObject(value) || (value.kind !== "commit" && value.kind !== "path" && value.kind !== "pr")) {
    rejectWrite(`code-doc record ${recordId} anchor ${index} has invalid kind`, op.entityId);
  }
  const sha = typeof value.sha === "string" ? value.sha : undefined;
  if ((value.kind === "commit" || value.kind === "path") && !isFullSha(sha)) {
    rejectWrite(`code-doc record ${recordId} anchor ${index} requires a full commit SHA`, op.entityId);
  }
  if (sha !== undefined && !isFullSha(sha)) {
    rejectWrite(`code-doc record ${recordId} anchor ${index} has invalid SHA`, op.entityId);
  }
  const anchorPath = typeof value.path === "string" ? value.path : undefined;
  const anchorRef = typeof value.ref === "string" ? value.ref : undefined;
  if (value.kind === "path" && (!anchorPath || normalizedPath(anchorPath, op) !== anchorPath)) {
    rejectWrite(`code-doc record ${recordId} path anchor requires a normalized path`, op.entityId);
  }
  if (value.kind === "pr" && (!anchorRef || anchorRef.length === 0)) {
    rejectWrite(`code-doc record ${recordId} PR anchor requires ref`, op.entityId);
  }
  return {
    kind: value.kind,
    ...(sha ? { sha } : {}),
    ...(value.kind === "path" ? { path: anchorPath! } : {}),
    ...(value.kind === "pr" ? { ref: anchorRef! } : {})
  };
}

function documentWrite(op: WriteOp): DocumentWrite {
  const payload = op.payload;
  if (!isObject(payload) || typeof payload.path !== "string" || typeof payload.body !== "string") {
    rejectWrite("code_doc_reconcile requires path and body", op.entityId);
  }
  return { taskId: taskIdForWriteOp(op), path: payload.path, body: payload.body };
}

function payloadPath(op: WriteOp): string | undefined {
  return isObject(op.payload) && typeof op.payload.path === "string" ? op.payload.path : undefined;
}

function normalizedPath(value: string, op: WriteOp): string {
  try {
    return normalizeRelativeDocumentPath(value);
  } catch (error) {
    rejectWrite(error instanceof Error ? error.message : String(error), op.entityId);
  }
}

function statusPath(line: string): string {
  if (line.length < 4) return "";
  const value = line.slice(3).trim();
  const renamed = value.lastIndexOf(" -> ");
  return (renamed >= 0 ? value.slice(renamed + 4) : value).replace(/^"|"$/gu, "");
}

function remediation(taskId: string): string {
  return `${CODE_DOC_RECONCILIATION_PATH} is a reserved machine document; do not write or stage it directly. Run ha task code-doc reconcile ${taskId} --commit <40-sha> --path <repo-relative-path> [--pr <url>]`;
}

function isFullSha(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function isRecordKind(value: unknown): value is CodeDocRecord["kind"] {
  return value === "closeout" || value === "review" || value === "evidence" || value === "decision-claim";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
