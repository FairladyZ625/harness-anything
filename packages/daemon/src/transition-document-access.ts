import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assessTransitionDocument,
  assertTransitionDocumentReady,
  normalizeRelativeDocumentPath,
  requireTransitionDocumentKind,
  resolveHarnessLayout,
  sha256Text,
  type TaskProjection,
} from "../../kernel/src/index.ts";

export type TaskTransitionDocumentSlot = "task.plan" | "task.closeout";

export interface TaskTransitionDocument {
  readonly packagePath: string;
  readonly path: string;
  readonly body: string;
  readonly blobSha256: string;
  readonly workspaceRevision: number;
  readonly source: "canonical projection" | "submitted candidate";
}

export function readTaskTransitionDocument(input: {
  readonly projection: TaskProjection;
  readonly taskId: string;
  readonly slot: TaskTransitionDocumentSlot;
  readonly bodyOverrides?: ReadonlyMap<string, string>;
}): TaskTransitionDocument {
  const task = input.projection.read(input.taskId);
  if (task.watermark < task.sourceRevision || !task.snapshot.task || !task.packagePath)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} package projection is not ready for ${input.slot}.`,
    );
  const contractPath = `${task.packagePath}/task-contract.json`,
    contractRead = input.projection.readDocument(contractPath);
  if (contractRead.watermark < contractRead.sourceRevision || !contractRead.document)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} contract projection is not ready for ${input.slot}.`,
    );
  let contract: unknown;
  try {
    contract = JSON.parse(contractRead.document.body);
  } catch {
    throw transitionDocumentAccessError("content_not_ready", `Task ${input.taskId} contract document is invalid.`);
  }
  const row = contract && typeof contract === "object" && !Array.isArray(contract) ? contract : null,
    documents =
      row && Array.isArray((row as { readonly documents?: unknown }).documents)
        ? (row as { readonly documents: readonly unknown[] }).documents
        : [],
    descriptor = documents.find(
      (value): value is { readonly slot: string; readonly path: string } =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { readonly slot?: unknown }).slot === input.slot &&
        typeof (value as { readonly path?: unknown }).path === "string",
    );
  if (!descriptor)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} contract has no ${input.slot} document.`,
    );
  let documentPath: string;
  try {
    documentPath = normalizeRelativeDocumentPath(`${task.packagePath}/${descriptor.path}`);
  } catch {
    throw transitionDocumentAccessError("content_not_ready", `Task ${input.taskId} ${input.slot} path is invalid.`);
  }
  if (!documentPath.startsWith(`${task.packagePath}/`))
    throw transitionDocumentAccessError("content_not_ready", `Task ${input.taskId} ${input.slot} leaves its package.`);
  const documentRead = input.projection.readDocument(documentPath);
  if (documentRead.watermark < documentRead.sourceRevision || !documentRead.document)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} ${input.slot} projection is not ready at ${documentPath}.`,
    );
  const overridden = input.bodyOverrides?.get(documentPath);
  return {
    packagePath: task.packagePath,
    path: documentPath,
    body: overridden ?? documentRead.document.body,
    blobSha256: overridden === undefined ? documentRead.document.blobSha256 : sha256Text(overridden),
    workspaceRevision: documentRead.document.workspaceRevision,
    source: overridden === undefined ? "canonical projection" : "submitted candidate",
  };
}

export function assertTaskTransitionDocumentReady(input: {
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly taskId: string;
  readonly slot: TaskTransitionDocumentSlot;
  readonly transition: string;
  readonly bodyOverrides?: ReadonlyMap<string, string>;
}): TaskTransitionDocument {
  const kind = requireTransitionDocumentKind(input.transition);
  if (kind !== input.slot)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Transition ${input.transition} consumes ${kind}, not ${input.slot}.`,
    );
  const document = readTaskTransitionDocument(input);
  try {
    assertTransitionDocumentReady(kind, document.body);
  } catch (error) {
    if (error && typeof error === "object") {
      const projectedMissing = transitionMissingSections(error),
        diskBody = document.source === "canonical projection" ? readOnDiskBody(input.rootDir, document.path) : null,
        diskDiffers = diskBody !== null && diskBody !== document.body,
        actionableMissing = diskDiffers ? assessTransitionDocument(kind, diskBody).missingSections : projectedMissing,
        revision =
          document.source === "canonical projection"
            ? `canonical projection document at workspace revision ${document.workspaceRevision}`
            : `submitted candidate against canonical projection workspace revision ${document.workspaceRevision}`,
        missing = missingSectionsHint(actionableMissing),
        recovery = diskDiffers
          ? `The on-disk harness/${document.path} differs; ${missing} ${
              actionableMissing.length ? "Complete that content, then run" : "Run"
            } ha doc sync --submit --path ${document.path}, then retry.`
          : [
              `${missing}`,
              ` Edit harness/${document.path}, then run ha doc sync --submit --path ${document.path} and retry.`,
            ].join("");
      Object.assign(error, {
        documentPath: document.path,
        missingSections: actionableMissing,
        projectedMissingSections: projectedMissing,
        message: `${String((error as { readonly code?: unknown }).code ?? "content_not_ready")}: ${kind} readiness judged the ${revision} (blob sha256 ${document.blobSha256}). ${recovery}`,
      });
    }
    throw error;
  }
  return document;
}

function readOnDiskBody(rootDir: string, documentPath: string): string | null {
  const target = path.join(resolveHarnessLayout(rootDir).authoredRoot, ...documentPath.split("/"));
  return existsSync(target) && !lstatSync(target).isSymbolicLink() && lstatSync(target).isFile()
    ? readFileSync(target, "utf8")
    : null;
}

function transitionMissingSections(error: object): readonly string[] {
  return "missingSections" in error && Array.isArray(error.missingSections)
    ? error.missingSections.filter((value): value is string => typeof value === "string")
    : [];
}

function missingSectionsHint(sections: readonly string[]): string {
  return sections.length === 0
    ? "it has no missing required sections."
    : `its missing required ${sections.length === 1 ? "section is" : "sections are"}: ${sections.join(", ")}.`;
}

function transitionDocumentAccessError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
