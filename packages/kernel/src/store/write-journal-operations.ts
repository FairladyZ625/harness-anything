import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  decodeEntityPathDeclaration,
  resolveEntityDocumentPath,
  type DeclaredEntityDocumentWritePayload
} from "../entity/declaration.ts";
import type { DocumentWrite } from "../ports/artifact-store-writer.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";
import {
  type HarnessLayoutInput,
  resolveHarnessLayout,
  taskPackagePath
} from "../layout/index.ts";
import { decisionDocumentTargetPath, decisionWriteKinds, writeDecisionDocument } from "./write-journal-decision-documents.ts";
import { taskIdForWriteOp } from "./write-journal-entity.ts";
import { appendJsonLineDurably, writeFileDurably } from "./write-journal-durable.ts";
import { rejectTaskWrite, rejectWrite } from "./write-journal-rejection.ts";
import {
  resolveContentAddressedBlobPath,
  writeContentAddressedBlob
} from "./content-addressed-blob-store.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { assertReservedCodeDocWrite } from "./write-journal-code-doc-policy.ts";
import {
  applyCanonicalAuthoredBatch,
  canonicalAuthoredBatchPaths,
  validateCanonicalAuthoredBatch
} from "./canonical-authored-batch.ts";
import { writeDocument } from "./markdown-artifact-store.ts";
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
} from "./write-journal-operations-internal.ts";

export interface WriteTransactionPlan {
  readonly touchedPaths: (rootInput: HarnessLayoutInput) => ReadonlyArray<string>;
  readonly documentWrites: () => ReadonlyArray<DocumentWrite>;
  readonly apply: (rootInput: HarnessLayoutInput, op: WriteOp) => DocumentWrite | null;
  readonly validate: (rootInput: HarnessLayoutInput) => void;
}

export function writeTransactionPlan(op: WriteOp): WriteTransactionPlan {
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
    return {
      touchedPaths: (rootInput) => [
        ...declaredEntityTouchedPaths(rootInput, op),
        ...companionWrites.map((write) => documentTargetPath(rootInput, write))
      ],
      documentWrites: () => companionWrites,
      apply: (rootInput) => {
        const document = declaredEntityDocument(rootInput, op);
        if (document.blobBody !== undefined && document.blobRef) {
          writeContentAddressedBlob(rootInput, document.blobBody, document.blobRef.mediaType);
        }
        writeDocumentsAtomically(rootInput, companionWrites, document);
        return null;
      },
      validate: (rootInput) => {
        declaredEntityDocument(rootInput, op);
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
  return {
    touchedPaths: (rootInput) => [documentTargetPath(rootInput, write)],
    documentWrites: () => [write],
    apply: (rootInput) => {
      writeDocument(rootInput, write);
      return write;
    },
    validate: () => {
      toDocumentWrite(op);
    }
  };
}

function hasDeclaredEntityDocument(payload: unknown): payload is DeclaredEntityDocumentWritePayload {
  return Boolean(payload && typeof payload === "object" && "entityDocument" in payload);
}

function declaredEntityCompanionWrites(payload: DeclaredEntityDocumentWritePayload): ReadonlyArray<DocumentWrite> {
  const writes = payload.companionWrites ?? [];
  if (!Array.isArray(writes) || writes.some((write) => !write || typeof write.path !== "string" || typeof write.body !== "string")) {
    rejectWrite("declared entity companionWrites must be document writes");
  }
  return writes;
}

function declaredEntityDocument(
  rootInput: HarnessLayoutInput,
  op: WriteOp
): {
  readonly targetPath: string;
  readonly body: string;
  readonly blobPath?: string;
  readonly blobRef?: DeclaredEntityDocumentWritePayload["entityDocument"]["blobRef"];
  readonly blobBody?: string;
} {
  if (!hasDeclaredEntityDocument(op.payload)) rejectWrite(`${op.kind} op requires entityDocument payload`, op.entityId);
  const document = op.payload.entityDocument;
  if (!document || typeof document !== "object" || typeof document.body !== "string" || !isStringRecord(document.identity)) {
    rejectWrite(`${op.kind} op has malformed entityDocument payload`, op.entityId);
  }
  try {
    const declaration = decodeEntityPathDeclaration(document.declaration);
    if (!op.entityId.startsWith(`entity/${declaration.kind}/`)) {
      rejectWrite(`entityDocument kind does not match write entity: ${op.entityId}`, op.entityId);
    }
    if (document.blobBody !== undefined && typeof document.blobBody !== "string") {
      rejectWrite("declared entity blobBody must be text", op.entityId);
    }
    if (document.blobBody !== undefined && !document.blobRef) {
      rejectWrite("declared entity blobBody requires blobRef", op.entityId);
    }
    if (document.blobBody !== undefined && document.blobRef
      && (document.blobRef.sha256 !== sha256Text(document.blobBody)
        || document.blobRef.size !== Buffer.byteLength(document.blobBody, "utf8"))) {
      rejectWrite("declared entity blobBody does not match blobRef", op.entityId);
    }
    return {
      targetPath: resolveEntityDocumentPath(rootInput, declaration, document.identity),
      body: document.body,
      ...(document.blobRef ? {
        blobPath: resolveContentAddressedBlobPath(rootInput, document.blobRef),
        blobRef: document.blobRef
      } : {}),
      ...(document.blobBody === undefined ? {} : { blobBody: document.blobBody })
    };
  } catch (error) {
    rejectWrite(error instanceof Error ? error.message : String(error), op.entityId);
  }
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string"));
}

export function validateWriteTransaction(rootInput: HarnessLayoutInput, op: WriteOp): void {
  const plan = writeTransactionPlan(op);
  assertReservedCodeDocWrite(op, plan.documentWrites());
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

export function materializeDeclaredEntityBlob(rootInput: HarnessLayoutInput, op: WriteOp): void {
  if (!hasDeclaredEntityDocument(op.payload)) return;
  const document = op.payload.entityDocument;
  if (document.blobBody === undefined || !document.blobRef) return;
  writeContentAddressedBlob(rootInput, document.blobBody, document.blobRef.mediaType);
}

export function claimCheckedDeclaredEntityWriteOp(op: WriteOp): WriteOp {
  if (!hasDeclaredEntityDocument(op.payload) || op.payload.entityDocument.blobBody === undefined) return op;
  const { blobBody: _blobBody, ...entityDocument } = op.payload.entityDocument;
  return { ...op, payload: { ...op.payload, entityDocument } };
}

export { isProgressAppendDeltaPayload, readHardDeletePayload } from "./write-journal-operations-internal.ts";


























































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

function declaredEntityTouchedPaths(rootInput: HarnessLayoutInput, op: WriteOp): ReadonlyArray<string> {
  const document = declaredEntityDocument(rootInput, op);
  return [document.targetPath, ...(document.blobPath ? [document.blobPath] : [])];
}
