import path from "node:path";
import type {
  DeclaredEntityDocumentPrecondition,
  DeclaredEntityDocumentWritePayload
} from "../../../entity/declaration.ts";
import { declaredDocumentSetSha256, normalizeDeclaredDocumentSetPrefixes } from "../../../integrity/document-set-hash.ts";
import { taskPackagePath, type HarnessLayoutInput } from "../../../layout/index.ts";
import { localLayoutFileSystem } from "../../../local/local-layout-file-system.ts";
import type { WriteOp } from "../../../ports/write-coordinator.ts";
import { documentTargetPath } from "./internal.ts";
import { rejectWrite } from "../rejection.ts";

export function declaredEntityPreconditions(
  payload: DeclaredEntityDocumentWritePayload
): ReadonlyArray<DeclaredEntityDocumentPrecondition> {
  const preconditions = payload.preconditions ?? [];
  if (!Array.isArray(preconditions) || preconditions.some((entry) => !validPrecondition(entry))) {
    rejectWrite("declared entity preconditions must name a document body or document-set with an exact sha256");
  }
  return preconditions;
}

export function assertDeclaredEntityPreconditions(
  rootInput: HarnessLayoutInput,
  preconditions: ReadonlyArray<DeclaredEntityDocumentPrecondition>,
  op: WriteOp,
  readBodySha256: (targetPath: string) => string | null
): void {
  const seen = new Set<string>();
  for (const precondition of preconditions) {
    if ("pathPrefixes" in precondition) {
      const key = `${precondition.taskId}:${precondition.pathPrefixes.join("\0")}`;
      if (seen.has(key)) rejectWrite("duplicate declared entity document-set precondition", op.entityId);
      seen.add(key);
      assertTaskDocumentSetPrecondition(rootInput, precondition, op);
      continue;
    }
    const targetPath = documentTargetPath(rootInput, {
      taskId: precondition.taskId,
      path: precondition.path,
      body: ""
    });
    if (seen.has(targetPath)) rejectWrite(`duplicate declared entity precondition: ${precondition.path}`, op.entityId);
    seen.add(targetPath);
    const actual = readBodySha256(targetPath);
    if (actual !== precondition.bodySha256) {
      rejectWrite(
        `declared entity precondition changed: ${precondition.path}; expected ${precondition.bodySha256 ?? "<missing>"}, current ${actual ?? "<missing>"}`,
        op.entityId
      );
    }
  }
}

export function assertTaskDocumentSetPrecondition(
  rootInput: HarnessLayoutInput,
  precondition: {
    readonly taskId: string;
    readonly pathPrefixes: ReadonlyArray<string>;
    readonly documentSetSha256: string;
  },
  op: WriteOp
): void {
  const actual = readDocumentSetSha256(rootInput, precondition.taskId, precondition.pathPrefixes, op);
  if (actual !== precondition.documentSetSha256) {
    rejectWrite(
      `declared entity document-set precondition changed; expected ${precondition.documentSetSha256}, current ${actual}`,
      op.entityId
    );
  }
}

function validPrecondition(entry: DeclaredEntityDocumentPrecondition): boolean {
  if (!entry || typeof entry !== "object") return false;
  if ("pathPrefixes" in entry) {
    try {
      normalizeDeclaredDocumentSetPrefixes(entry.pathPrefixes);
      return /^[a-f0-9]{64}$/u.test(entry.documentSetSha256);
    } catch {
      return false;
    }
  }
  return typeof entry.path === "string" && (entry.bodySha256 === null || /^[a-f0-9]{64}$/u.test(entry.bodySha256));
}

function readDocumentSetSha256(
  rootInput: HarnessLayoutInput,
  taskId: string,
  pathPrefixes: ReadonlyArray<string>,
  op: WriteOp
): string {
  const taskRoot = taskPackagePath(rootInput, taskId);
  const documents = normalizeDeclaredDocumentSetPrefixes(pathPrefixes).flatMap((prefix) => {
    const directory = path.join(taskRoot, prefix);
    if (!localLayoutFileSystem.exists(directory)) return [];
    return readDirectoryDocuments(taskRoot, directory, op);
  });
  return declaredDocumentSetSha256(documents, pathPrefixes);
}

function readDirectoryDocuments(taskRoot: string, directory: string, op: WriteOp): ReadonlyArray<{ path: string; body: string }> {
  let entries;
  try {
    entries = localLayoutFileSystem.readDirents(directory);
  } catch {
    rejectWrite(`declared entity document-set prefix is not a directory: ${path.relative(taskRoot, directory)}`, op.entityId);
  }
  return entries.flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return readDirectoryDocuments(taskRoot, absolute, op);
    if (!entry.isFile()) rejectWrite(`declared entity document-set contains unsupported entry: ${absolute}`, op.entityId);
    return [{ path: path.relative(taskRoot, absolute).split(path.sep).join("/"), body: localLayoutFileSystem.readText(absolute) }];
  });
}
