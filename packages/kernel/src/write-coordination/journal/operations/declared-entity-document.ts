import path from "node:path";
import {
  decodeEntityPathDeclaration,
  resolveEntityDocumentPath,
  type DeclaredEntityDocumentWritePayload
} from "../../../entity/declaration.ts";
import { sha256Text } from "../../../integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath, taskPackagePath, type HarnessLayoutInput } from "../../../layout/index.ts";
import { localLayoutFileSystem } from "../../../local/local-layout-file-system.ts";
import type { DocumentWrite } from "../../../ports/artifact-store-writer.ts";
import type { WriteOp } from "../../../ports/write-coordinator.ts";
import { resolveContentAddressedBlobPath } from "../../../persistence/blob/content-addressed-blob-store.ts";
import { rejectWrite } from "../rejection.ts";

export function hasDeclaredEntityDocument(payload: unknown): payload is DeclaredEntityDocumentWritePayload {
  return Boolean(payload && typeof payload === "object" && "entityDocument" in payload);
}

export function declaredEntityCompanionWrites(payload: DeclaredEntityDocumentWritePayload): ReadonlyArray<DocumentWrite> {
  const writes = payload.companionWrites ?? [];
  if (!Array.isArray(writes) || writes.some((write) => !write || typeof write.path !== "string" || typeof write.body !== "string")) {
    rejectWrite("declared entity companionWrites must be document writes");
  }
  return writes;
}

export function bodySha256AtPath(targetPath: string): string | null {
  return localLayoutFileSystem.exists(targetPath) ? sha256Text(localLayoutFileSystem.readText(targetPath)) : null;
}

export function declaredEntityDocument(
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

export function declaredEntityTouchedPaths(rootInput: HarnessLayoutInput, op: WriteOp): ReadonlyArray<string> {
  const document = declaredEntityDocument(rootInput, op);
  return [document.targetPath, ...(document.blobPath ? [document.blobPath] : [])];
}

export function declaredEntityPrimaryDocumentWrite(
  rootInput: HarnessLayoutInput,
  op: WriteOp
): DocumentWrite | null {
  if (!hasDeclaredEntityDocument(op.payload)) return null;
  const taskId = op.payload.entityDocument.identity?.taskId;
  if (typeof taskId !== "string" || taskId.length === 0) return null;
  const document = declaredEntityDocument(rootInput, op);
  const relativePath = path.relative(taskPackagePath(rootInput, taskId), document.targetPath)
    .split(path.sep)
    .join("/");
  if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) return null;
  return { taskId, path: normalizeRelativeDocumentPath(relativePath), body: document.body };
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string"));
}
