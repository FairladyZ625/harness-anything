import { normalizeRelativeDocumentPath, type TaskProjectionQueries } from "@harness-anything/kernel";

export type TaskTransitionDocumentSlot = "task.plan" | "task.closeout";

interface TransitionDocumentDescriptor {
  readonly slot: string;
  readonly path: string;
  readonly templateRef?: unknown;
  readonly locale?: unknown;
  readonly readiness?: unknown;
  readonly readinessKnownSections?: unknown;
}

function transitionDocumentAccessError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function locateTaskTransitionDocument(input: {
  readonly projection: TaskProjectionQueries;
  readonly taskId: string;
  readonly slot: TaskTransitionDocumentSlot;
}) {
  const task = input.projection.read(input.taskId);
  if (task.watermark < task.sourceRevision || !task.snapshot.task || !task.packagePath)
    throw transitionDocumentAccessError(
      "content_not_ready",
      `Task ${input.taskId} package projection is not ready for ${input.slot}.`,
    );
  const packagePath = task.packagePath,
    contractPath = `${packagePath}/task-contract.json`,
    activeContractRead = input.projection.readDocument(contractPath),
    completedArchive =
      task.snapshot.task.status === "done" && (task.snapshot.task.packageDisposition ?? "active") !== "active",
    contractRead =
      activeContractRead.document || !completedArchive
        ? activeContractRead
        : (input.projection.readDocumentHistory?.(contractPath) ?? activeContractRead);
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
      (value): value is TransitionDocumentDescriptor & { readonly slot: string; readonly path: string } =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { readonly slot?: unknown }).slot === input.slot &&
        typeof (value as { readonly path?: unknown }).path === "string",
    );
  if (!descriptor) return { packagePath, contract, descriptor, path: null };
  let documentPath: string;
  try {
    documentPath = normalizeRelativeDocumentPath(`${packagePath}/${descriptor.path}`);
  } catch {
    throw transitionDocumentAccessError("content_not_ready", `Task ${input.taskId} ${input.slot} path is invalid.`);
  }
  if (!documentPath.startsWith(`${packagePath}/`))
    throw transitionDocumentAccessError("content_not_ready", `Task ${input.taskId} ${input.slot} leaves its package.`);
  return { packagePath, contract, descriptor, path: documentPath };
}
