import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DocumentWrite } from "../../../ports/artifact-store-writer.ts";
import type { WriteOp } from "../../../ports/write-coordinator.ts";
import {
  type HarnessLayoutInput,
  resolveHarnessLayout,
  taskPackagePath
} from "../../../layout/index.ts";
import { decisionDocumentTargetPath, decisionWriteKinds, writeDecisionDocument } from "./decision-documents.ts";
import { taskIdForWriteOp } from "./entity.ts";
import { appendJsonLineDurably, writeFileDurably } from "../durable.ts";
import { rejectTaskWrite, rejectWrite } from "../rejection.ts";
import { resolveContentAddressedBlobPath } from "../../../persistence/blob/content-addressed-blob-store.ts";
import { assertReservedCodeDocWrite } from "./code-doc-policy.ts";
import { assertDeclaredEntityPreconditions, declaredEntityPreconditions } from "./declared-entity-preconditions.ts";
import {
  prepareRetiredAttributionFieldCleanup,
  retiredAttributionFieldCleanupTargetPath
} from "./retired-attribution-cleanup.ts";
import {
  applyCanonicalAuthoredBatch,
  canonicalAuthoredBatchPaths,
  validateCanonicalAuthoredBatch
} from "./canonical-authored-batch.ts";
import { applyWithCompensatedCasBody } from "./composite-cas-compensation.ts";
import {
  applyRecoverableDocumentTransaction,
  hasRecoverableDocumentTransaction
} from "./recoverable-document-transaction.ts";
import {
  bodySha256AtPath,
  declaredEntityCompanionWrites,
  declaredEntityDocument,
  declaredEntityPrimaryDocumentWrite,
  declaredEntityTouchedPaths,
  hasDeclaredEntityDocument
} from "./declared-entity-document.ts";
import { writeDocument } from "../../../persistence/markdown/markdown-artifact-store.ts";
import {
  applyDocumentAppendRecord,
  applyProgressAppendDelta,
  applyProgressAppendSnapshot,
  assertHardDeleteAllowed,
  decisionPayloadTaskWrites,
  documentAppendRecordWrite,
  documentStageWrite,
  documentTargetPath,
  isBatchDocumentWritePayload,
  isDocumentAppendRecordPayload,
  isModuleRegistryWritePayload,
  isProgressAppendDeltaPayload,
  isProgressAppendSnapshotPayload,
  machineArtifactJsonlAppend,
  machineArtifactWriteDescriptor,
  moduleScaffoldWrites,
  progressAppendDeltaWrite,
  progressAppendSnapshotWrite,
  readHardDeletePayload,
  resolveMachineArtifactPath,
  resolveMachineArtifactWrite,
  toDocumentWrite,
  documentWriteKinds
} from "./internal.ts";

export interface WriteTransactionPlan {
  readonly touchedPaths: (rootInput: HarnessLayoutInput) => ReadonlyArray<string>;
  readonly documentWrites: () => ReadonlyArray<DocumentWrite>;
  readonly reservedDocumentWrites?: (rootInput: HarnessLayoutInput) => ReadonlyArray<DocumentWrite>;
  readonly apply: (rootInput: HarnessLayoutInput, op: WriteOp) => DocumentWrite | null;
  readonly validate: (rootInput: HarnessLayoutInput) => void;
}

export function writeTransactionPlan(op: WriteOp): WriteTransactionPlan {
  if (op.kind === "migration_retired_attribution_fields") {
    return {
      touchedPaths: (rootInput) => [retiredAttributionFieldCleanupTargetPath(rootInput, op)],
      documentWrites: () => [],
      apply: (rootInput) => {
        applyRetiredAttributionFieldCleanup(rootInput, op);
        return null;
      },
      validate: (rootInput) => validateRetiredAttributionFieldCleanup(rootInput, op)
    };
  }
  if (op.kind === "transition_local" && transitionAuditText(op.payload) !== null) {
    const indexWrite = toDocumentWrite(op);
    const auditText = transitionAuditText(op.payload)!;
    return {
      touchedPaths: (rootInput) => [
        documentTargetPath(rootInput, indexWrite),
        documentTargetPath(rootInput, { taskId: indexWrite.taskId, path: "progress.md", body: "", packageSlug: indexWrite.packageSlug })
      ],
      documentWrites: () => [indexWrite],
      apply: (rootInput) => {
        const progressWrite = forceAuditProgressWrite(rootInput, indexWrite, auditText);
        writeDocumentsAtomically(rootInput, [indexWrite, progressWrite]);
        return indexWrite;
      },
      validate: () => { toDocumentWrite(op); }
    };
  }
  if (op.kind === "doc_sync_submit" || op.kind === "script_ingest") {
    return {
      touchedPaths: (rootInput) => canonicalAuthoredBatchPaths(rootInput, op),
      documentWrites: () => [],
      apply: (rootInput) => {
        applyCanonicalAuthoredBatch(rootInput, op);
        return null;
      },
      validate: (rootInput) => validateCanonicalAuthoredBatch(rootInput, op)
    };
  }
  if (op.kind === "doc_write" && hasDeclaredEntityDocument(op.payload)) {
    const companionWrites = declaredEntityCompanionWrites(op.payload);
    const preconditions = declaredEntityPreconditions(op.payload);
    return {
      touchedPaths: (rootInput) => [
        ...declaredEntityTouchedPaths(rootInput, op),
        ...companionWrites.map((write) => documentTargetPath(rootInput, write))
      ],
      documentWrites: () => companionWrites,
      reservedDocumentWrites: (rootInput) => [
        ...optionalWrite(declaredEntityPrimaryDocumentWrite(rootInput, op)),
        ...companionWrites
      ],
      apply: (rootInput) => {
        const document = declaredEntityDocument(rootInput, op);
        const transactionWrites = [
          { targetPath: document.targetPath, body: document.body },
          ...companionWrites.map((write) => ({
            targetPath: documentTargetPath(rootInput, write),
            body: write.body
          }))
        ];
        if (!hasRecoverableDocumentTransaction(rootInput, op.opId)) {
          assertDeclaredEntityPreconditions(rootInput, preconditions, op, bodySha256AtPath);
        }
        applyWithCompensatedCasBody(
          rootInput,
          document.blobBody !== undefined && document.blobRef
            ? { body: document.blobBody, mediaType: document.blobRef.mediaType }
            : undefined,
          () => applyRecoverableDocumentTransaction(rootInput, op.opId, transactionWrites)
        );
        return null;
      },
      validate: (rootInput) => {
        declaredEntityDocument(rootInput, op);
        assertDeclaredEntityPreconditions(rootInput, preconditions, op, bodySha256AtPath);
      }
    };
  }
  if (decisionWriteKinds.has(op.kind)) {
    const taskWrites = decisionPayloadTaskWrites(op.payload);
    return {
      touchedPaths: (rootInput) => [
        decisionDocumentTargetPath(rootInput, op),
        ...taskWrites.map((write) => documentTargetPath(rootInput, write))
      ],
      documentWrites: () => taskWrites,
      apply: (rootInput) => {
        writeDecisionDocument(rootInput, op);
        if (taskWrites.length > 0) writeDocumentsAtomically(rootInput, taskWrites);
        return null;
      },
      validate: (rootInput) => {
        decisionDocumentTargetPath(rootInput, op);
      }
    };
  }

  if (op.kind === "module_registry_write") {
    return {
      touchedPaths: (rootInput) => [path.join(resolveHarnessLayout(rootInput).authoredRoot, "modules.json")],
      documentWrites: () => [],
      apply: (rootInput) => {
        writeModuleRegistry(rootInput, op);
        return null;
      },
      validate: () => {
        if (!isModuleRegistryWritePayload(op.payload)) {
          rejectWrite(`${op.kind} op requires registry payload: ${op.opId}`, op.entityId);
        }
      }
    };
  }

  if (op.kind === "module_scaffold_write") {
    return {
      touchedPaths: (rootInput) => moduleScaffoldWrites(rootInput, op).map((entry) => entry.targetPath),
      documentWrites: () => [],
      apply: (rootInput) => {
        writeModuleScaffold(rootInput, op);
        return null;
      },
      validate: (rootInput) => {
        moduleScaffoldWrites(rootInput, op);
      }
    };
  }

  if (op.kind === "machine_artifact_write") {
    return {
      touchedPaths: (rootInput) => {
        const payload = machineArtifactWriteDescriptor(op);
        const targetPath = resolveMachineArtifactPath(rootInput, payload.boundary, payload.path, op.entityId);
        return [targetPath, ...(payload.bodyRef ? [resolveContentAddressedBlobPath(rootInput, payload.bodyRef)] : [])];
      },
      documentWrites: () => [],
      apply: (rootInput) => {
        const artifact = resolveMachineArtifactWrite(rootInput, op);
        writeFileDurably(artifact.targetPath, artifact.body);
        return null;
      },
      validate: (rootInput) => {
        const payload = machineArtifactWriteDescriptor(op);
        resolveMachineArtifactPath(rootInput, payload.boundary, payload.path, op.entityId);
      }
    };
  }

  if (op.kind === "machine_artifact_append_jsonl") {
    return {
      touchedPaths: (rootInput) => {
        const artifact = machineArtifactJsonlAppend(rootInput, op);
        return artifact.boundary === "runtime-event-ledger" ? [] : [artifact.targetPath];
      },
      documentWrites: () => [],
      apply: (rootInput) => {
        const artifact = machineArtifactJsonlAppend(rootInput, op);
        appendJsonLineDurably(artifact.targetPath, artifact.value);
        return null;
      },
      validate: (rootInput) => {
        machineArtifactJsonlAppend(rootInput, op);
      }
    };
  }

  if ((op.kind === "package_create" || op.kind === "package_supersede") && isBatchDocumentWritePayload(op.payload)) {
    const payload = op.payload;
    return {
      touchedPaths: (rootInput) => payload.writes.map((write) => documentTargetPath(rootInput, write)),
      documentWrites: () => payload.writes,
      apply: (rootInput) => {
        writeDocumentsAtomically(rootInput, payload.writes);
        return null;
      },
      validate: () => {
        if (!isBatchDocumentWritePayload(payload)) {
          rejectWrite(`${op.kind} op requires writes payload: ${op.opId}`, op.entityId);
        }
      }
    };
  }

  if (op.kind === "package_delete_hard") {
    const taskId = taskIdForWriteOp(op);
    return {
      touchedPaths: (rootInput) => [taskPackagePath(rootInput, taskId)],
      documentWrites: () => [],
      apply: (rootInput) => {
        assertHardDeleteAllowed(rootInput, taskId, { allowMissing: true });
        rmSync(taskPackagePath(rootInput, taskId), { recursive: true, force: true });
        return null;
      },
      validate: (rootInput) => {
        readHardDeletePayload(op);
        assertHardDeleteAllowed(rootInput, taskId);
      }
    };
  }

  if (op.kind === "progress_append") {
    if (isProgressAppendDeltaPayload(op.payload)) {
      const payload = op.payload;
      const write = progressAppendDeltaWrite(op, payload);
      return {
        touchedPaths: (rootInput) => [documentTargetPath(rootInput, write)],
        documentWrites: () => [write],
        apply: (rootInput) => applyProgressAppendDelta(rootInput, op, payload),
        validate: () => {
          if (!isProgressAppendDeltaPayload(payload)) {
            rejectWrite(`${op.kind} op requires path and append payload: ${op.opId}`, op.entityId);
          }
        }
      };
    }
    if (isProgressAppendSnapshotPayload(op.payload)) {
      const payload = op.payload;
      const write = progressAppendSnapshotWrite(op, payload);
      return {
        touchedPaths: (rootInput) => [documentTargetPath(rootInput, write)],
        documentWrites: () => [write],
        apply: (rootInput) => applyProgressAppendSnapshot(rootInput, op, payload),
        validate: () => {
          if (!isProgressAppendSnapshotPayload(payload)) {
            rejectWrite(`${op.kind} op requires path and body payload: ${op.opId}`, op.entityId);
          }
        }
      };
    }
    return {
      touchedPaths: () => [],
      documentWrites: () => [],
      apply: () => {
        rejectWrite(`${op.kind} op requires path and append or body payload: ${op.opId}`, op.entityId);
      },
      validate: () => {
        rejectWrite(`${op.kind} op requires path and append or body payload: ${op.opId}`, op.entityId);
      }
    };
  }

  if ((op.kind === "doc_write" || op.kind === "fact_invalidate") && isDocumentAppendRecordPayload(op.payload)) {
    const payload = op.payload;
    const write = documentAppendRecordWrite(op, payload);
    return {
      touchedPaths: (rootInput) => [documentTargetPath(rootInput, write)],
      documentWrites: () => [write],
      apply: (rootInput) => applyDocumentAppendRecord(rootInput, op, payload),
      validate: () => {
        if (!isDocumentAppendRecordPayload(payload)) {
          rejectWrite(`${op.kind} op requires append record payload: ${op.opId}`, op.entityId);
        }
      }
    };
  }

  if (op.kind === "doc_stage") {
    return {
      touchedPaths: (rootInput) => [documentTargetPath(rootInput, documentStageWrite(op))],
      documentWrites: () => [],
      apply: () => null,
      validate: () => {
        documentStageWrite(op);
      }
    };
  }

  if (op.kind === "task_tree_stage") {
    return {
      touchedPaths: (rootInput) => [taskPackagePath(rootInput, taskIdForWriteOp(op))],
      documentWrites: () => [],
      apply: () => null,
      validate: () => {
        taskIdForWriteOp(op);
      }
    };
  }

  if (!documentWriteKinds.has(op.kind)) {
    rejectWrite(`unsupported write op kind: ${op.kind}`, op.entityId);
  }
  const write = toDocumentWrite(op);
  const transitionPreconditions = op.kind === "transition_local"
    && op.payload && typeof op.payload === "object" && "preconditions" in op.payload
    ? declaredEntityPreconditions(op.payload as never)
    : [];
  return {
    touchedPaths: (rootInput) => [documentTargetPath(rootInput, write)],
    documentWrites: () => [write],
    apply: (rootInput) => {
      assertDeclaredEntityPreconditions(rootInput, transitionPreconditions, op, bodySha256AtPath);
      writeDocument(rootInput, write);
      return write;
    },
    validate: (rootInput) => {
      toDocumentWrite(op);
      assertDeclaredEntityPreconditions(rootInput, transitionPreconditions, op, bodySha256AtPath);
    }
  };
}

function transitionAuditText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { readonly auditText?: unknown }).auditText;
  return typeof value === "string" && value.startsWith("FORCE_STATUS_SET_AUDIT:") ? value : null;
}

function forceAuditProgressWrite(rootInput: HarnessLayoutInput, indexWrite: DocumentWrite, auditText: string): DocumentWrite {
  const probe = { taskId: indexWrite.taskId, path: "progress.md", body: "", packageSlug: indexWrite.packageSlug };
  const targetPath = documentTargetPath(rootInput, probe);
  const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "# Progress\n\n## Entries\n\n";
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  return { ...probe, body: `${existing}${separator}${auditText}\n` };
}


export function validateWriteTransaction(rootInput: HarnessLayoutInput, op: WriteOp): void {
  const plan = writeTransactionPlan(op);
  assertReservedCodeDocWrite(op, plan.reservedDocumentWrites?.(rootInput) ?? plan.documentWrites());
  plan.validate(rootInput);
}

export function applyWriteOp(rootInput: HarnessLayoutInput, op: WriteOp): DocumentWrite | null {
  return writeTransactionPlan(op).apply(rootInput, op);
}

export function writeOpTouchedPaths(rootInput: HarnessLayoutInput, op: WriteOp): ReadonlyArray<string> {
  return writeTransactionPlan(op).touchedPaths(rootInput);
}

export function documentWritesForWriteOp(op: WriteOp): ReadonlyArray<DocumentWrite> {
  return writeTransactionPlan(op).documentWrites();
}

function optionalWrite(write: DocumentWrite | null): ReadonlyArray<DocumentWrite> {
  return write ? [write] : [];
}

export { isProgressAppendDeltaPayload, readHardDeletePayload } from "./internal.ts";


























































function writeDocumentsAtomically(
  rootInput: HarnessLayoutInput,
  writes: ReadonlyArray<DocumentWrite>,
  declaredEntity?: { readonly targetPath: string; readonly body: string }
): void {
  if (writes.length === 0 && !declaredEntity) rejectWrite("batch document write requires at least one write");
  const entries = writes.map((write) => ({
    write,
    targetPath: documentTargetPath(rootInput, write)
  }));
  const targetPaths = new Set<string>();
  for (const entry of entries) {
    if (targetPaths.has(entry.targetPath)) rejectTaskWrite(`duplicate batch write target: ${entry.write.path}`, entry.write.taskId);
    targetPaths.add(entry.targetPath);
  }
  if (declaredEntity && targetPaths.has(declaredEntity.targetPath)) rejectWrite("declared entity transaction has duplicate targets");

  const targets = [...(declaredEntity ? [declaredEntity.targetPath] : []), ...entries.map((entry) => entry.targetPath)];
  const backups = targets.map((targetPath) => ({
    targetPath,
    existed: existsSync(targetPath),
    body: existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null
  }));

  try {
    if (declaredEntity) writeFileDurably(declaredEntity.targetPath, declaredEntity.body);
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

function validateRetiredAttributionFieldCleanup(rootInput: HarnessLayoutInput, op: WriteOp): void {
  const targetPath = retiredAttributionFieldCleanupTargetPath(rootInput, op);
  if (!existsSync(targetPath)) rejectWrite(`retired attribution cleanup target does not exist: ${targetPath}`, op.entityId);
  prepareRetiredAttributionFieldCleanup(targetPath, readFileSync(targetPath, "utf8"), op);
}

function applyRetiredAttributionFieldCleanup(rootInput: HarnessLayoutInput, op: WriteOp): void {
  const targetPath = retiredAttributionFieldCleanupTargetPath(rootInput, op);
  if (!existsSync(targetPath)) rejectWrite(`retired attribution cleanup target does not exist: ${targetPath}`, op.entityId);
  const prepared = prepareRetiredAttributionFieldCleanup(targetPath, readFileSync(targetPath, "utf8"), op);
  if (prepared.alreadyApplied) return;
  writeFileDurably(targetPath, prepared.body);
}









function writeModuleRegistry(rootInput: HarnessLayoutInput, op: WriteOp): void {
  if (!isModuleRegistryWritePayload(op.payload)) {
    rejectWrite(`${op.kind} op requires registry payload: ${op.opId}`, op.entityId);
  }
  const targetPath = path.join(resolveHarnessLayout(rootInput).authoredRoot, "modules.json");
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileDurably(targetPath, `${JSON.stringify(op.payload.registry, null, 2)}\n`);
}






function writeModuleScaffold(rootInput: HarnessLayoutInput, op: WriteOp): void {
  const writes = moduleScaffoldWrites(rootInput, op);
  for (const write of writes) {
    mkdirSync(path.dirname(write.targetPath), { recursive: true });
    writeFileDurably(write.targetPath, write.body.endsWith("\n") ? write.body : `${write.body}\n`);
  }
}
export type MachineArtifactBoundary =
  | "runtime-event-ledger"
  | "provenance-session"
  | "distill-candidate"
  | "legacy-forward"
  | "preset-evidence-registry";
