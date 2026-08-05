import path from "node:path";
import {
  CODE_DOC_RECONCILIATION_DOCUMENT,
  renderCodeDocReconciliationDraft,
  taskCompleteExternalCheckpointKinds,
  type TaskCompleteExternalCheckpointRef,
  type TaskCompleteTransitionCommand,
  type VerifiedTaskCompleteCodeDocWitness,
  type VerifiedTaskCompleteDocumentPublicationWitness,
  type VerifiedTaskCompleteExternalWitness
} from "@harness-anything/application";
import {
  sha256Text,
  stableStringify,
  taskPackagePath
} from "@harness-anything/kernel";
import {
  assertAttributedMaterializedPublication,
  findAttributedMaterializedPublication,
  prepublishGitBlobText,
  prepublishGitTextOrNull
} from "./task-complete-prepublish-publication.ts";
import { reportCurrentRepoWriteTelemetry } from "../../runtime/repo-write-telemetry-context.ts";

const witnessPrefix = "ha-prepublish-witness-v1.";

export async function resolveVerifiedTaskCompleteWitnesses(input: {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly taskId: string;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  readonly command: TaskCompleteTransitionCommand;
  readonly requireCodeDoc: boolean;
}): Promise<ReadonlyArray<VerifiedTaskCompleteExternalWitness>> {
  const suppliedByKind = new Map<string, TaskCompleteExternalCheckpointRef>();
  for (const witness of input.command.externalCheckpointRefs) {
    if (suppliedByKind.has(witness.kind)) {
      throw new Error(`AUTHORITY_TASK_COMPLETE_WITNESS_DUPLICATE:${witness.kind}`);
    }
    suppliedByKind.set(witness.kind, witness);
  }
  const expectedKinds = new Set<string>([
    taskCompleteExternalCheckpointKinds[0],
    ...(input.requireCodeDoc ? [taskCompleteExternalCheckpointKinds[1]] : [])
  ]);
  const unknown = [...suppliedByKind.keys()].find((kind) => !expectedKinds.has(kind));
  if (unknown) throw new Error(`AUTHORITY_TASK_COMPLETE_WITNESS_NOT_APPLICABLE:${unknown}`);
  const refs = [
    suppliedByKind.get("document-publication")
      ?? (await produceDocumentPublicationWitness(input)),
    ...(input.requireCodeDoc
      ? [suppliedByKind.get("code-doc-reconciliation") ?? (await produceCodeDocWitness(input))]
      : [])
  ];
  return await verifyTaskCompleteWitnessRefs({ ...input, refs });
}

export async function verifyTaskCompleteWitnessRefs(input: {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly taskId: string;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  readonly command: TaskCompleteTransitionCommand;
  readonly requireCodeDoc: boolean;
  readonly refs: ReadonlyArray<TaskCompleteExternalCheckpointRef>;
  readonly snapshotMode?: "current" | "committed";
}): Promise<ReadonlyArray<VerifiedTaskCompleteExternalWitness>> {
  const decodedByKind = new Map<string, VerifiedTaskCompleteExternalWitness>();
  for (const supplied of input.refs) {
    if (decodedByKind.has(supplied.kind)) throw new Error(`AUTHORITY_TASK_COMPLETE_WITNESS_DUPLICATE:${supplied.kind}`);
    const decoded = decodePrepublishWitnessRef(supplied.ref);
    if (decoded.kind !== supplied.kind) throw new Error(`AUTHORITY_TASK_COMPLETE_WITNESS_KIND_MISMATCH:${supplied.kind}`);
    decodedByKind.set(decoded.kind, decoded);
  }
  const document = decodedByKind.get("document-publication");
  if (!document || document.kind !== "document-publication") {
    throw new Error("AUTHORITY_TASK_COMPLETE_DOCUMENT_PUBLICATION_WITNESS_REQUIRED");
  }
  await verifyDocumentPublicationWitness(input, document, input.snapshotMode ?? "current");
  const codeDoc = decodedByKind.get("code-doc-reconciliation");
  if (input.requireCodeDoc) {
    if (!codeDoc || codeDoc.kind !== "code-doc-reconciliation") {
      throw new Error("AUTHORITY_TASK_COMPLETE_CODE_DOC_WITNESS_REQUIRED");
    }
    await verifyCodeDocWitness(input, codeDoc, input.snapshotMode ?? "current");
  } else if (codeDoc) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_NOT_APPLICABLE:code-doc-reconciliation");
  }
  if (decodedByKind.size !== (input.requireCodeDoc ? 2 : 1)) {
    const unknown = [...decodedByKind.keys()].find((kind) => !taskCompleteExternalCheckpointKinds.includes(
      kind as typeof taskCompleteExternalCheckpointKinds[number]
    ));
    throw new Error(`AUTHORITY_TASK_COMPLETE_WITNESS_NOT_APPLICABLE:${unknown ?? "unknown"}`);
  }
  return [document, ...(codeDoc ? [codeDoc] : [])];
}

export async function produceDocumentPublicationWitness(input: {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly taskId: string;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
}): Promise<VerifiedTaskCompleteDocumentPublicationWitness> {
  reportCurrentRepoWriteTelemetry("compile-task-witness", {
    stage: "document-produce",
    state: "start"
  });
  const covered = [...input.documents]
    .map((document) => ({ path: canonicalTaskRelativePath(document.path), body: document.body }))
    .sort((left, right) => lexicalCompare(left.path, right.path));
  if (covered.length === 0) throw new Error("AUTHORITY_TASK_COMPLETE_DOCUMENT_PUBLICATION_EMPTY");
  const repositoryPaths = taskRepositoryPaths(input, covered.map((entry) => entry.path));
  const publication = await findAttributedMaterializedPublication(input.authoredRoot, repositoryPaths, covered.map((entry) => entry.body));
  const witnessWithoutRef = {
    kind: "document-publication" as const,
    repositoryCommit: publication.commit,
    publicationOperationIds: publication.operationIds,
    coveredTaskRelativePaths: covered.map((entry) => entry.path),
    coveredPathSetDigest: `sha256:${sha256Text(stableStringify(covered.map((entry) => ({
      path: entry.path,
      bodySha256: sha256Text(entry.body)
    }))))}`
  };
  const witness = { ...witnessWithoutRef, ref: encodePrepublishWitnessRef(witnessWithoutRef) };
  reportCurrentRepoWriteTelemetry("compile-task-witness", {
    stage: "document-produce",
    state: "done"
  });
  return witness;
}

export async function produceCodeDocWitness(input: {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly taskId: string;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  readonly command: TaskCompleteTransitionCommand;
}): Promise<VerifiedTaskCompleteCodeDocWitness> {
  reportCurrentRepoWriteTelemetry("compile-task-witness", {
    stage: "code-doc-produce",
    state: "start"
  });
  const codeDoc = input.documents.find((document) => document.path === CODE_DOC_RECONCILIATION_DOCUMENT);
  if (!codeDoc) {
    throw new Error(
      "AUTHORITY_TASK_COMPLETE_CODE_DOC_WITNESS_REQUIRED: run `ha task submit <task-id> --from-file submission.json`, then `ha task code-doc reconcile <task-id> --commit <full-sha> [--path <repo-relative-path>]...`, before `ha task complete`."
    );
  }
  const reconciled = await resolveCommit(input.rootDir, input.command.commitRef ?? "HEAD");
  const normalizedPaths = normalizeCommandPaths(input.rootDir, input.command.approval?.paths ?? []);
  const prRef = input.command.approval?.prRef ?? null;
  const expected = renderCodeDocReconciliationDraft({
    taskId: input.taskId,
    documents: input.documents,
    sha: reconciled,
    paths: normalizedPaths,
    ...(prRef ? { prRef } : {})
  });
  if (expected.recordIds.length === 0 || expected.body !== codeDoc.body) {
    throw new Error(
      "AUTHORITY_TASK_COMPLETE_CODE_DOC_NOT_RECONCILED_TO_INTENT: "
      + `approval intent expects ${describeCodeDocAnchors(expected.body)}; `
      + `current code-doc ${CODE_DOC_RECONCILIATION_DOCUMENT} has ${describeCodeDocAnchors(codeDoc.body)}; `
      + "run `ha task code-doc reconcile <task-id> --commit <full-sha> [--path <repo-relative-path>]...` after task submit and before task complete."
    );
  }
  const [repositoryPath] = taskRepositoryPaths(input, [CODE_DOC_RECONCILIATION_DOCUMENT]);
  const publication = await findAttributedMaterializedPublication(input.authoredRoot, [repositoryPath!], [codeDoc.body]);
  const witnessWithoutRef = {
    kind: "code-doc-reconciliation" as const,
    repositoryCommit: publication.commit,
    publicationOperationIds: publication.operationIds,
    taskId: input.taskId,
    reconciledCommitRef: reconciled,
    normalizedPaths,
    prRef,
    codeDocBodyDigest: `sha256:${sha256Text(codeDoc.body)}`
  };
  const witness = { ...witnessWithoutRef, ref: encodePrepublishWitnessRef(witnessWithoutRef) };
  reportCurrentRepoWriteTelemetry("compile-task-witness", {
    stage: "code-doc-produce",
    state: "done"
  });
  return witness;
}

function describeCodeDocAnchors(body: string): string {
  try {
    const parsed = JSON.parse(body) as { readonly records?: unknown };
    if (!Array.isArray(parsed.records)) return "invalid records";
    const anchors = parsed.records.flatMap((record) => {
      if (!record || typeof record !== "object" || !("anchors" in record)) return [];
      const value = (record as { readonly anchors?: unknown }).anchors;
      return Array.isArray(value) ? value : [];
    });
    const commits = anchors.flatMap((anchor) => {
      if (!anchor || typeof anchor !== "object") return [];
      const value = (anchor as { readonly kind?: unknown; readonly sha?: unknown });
      return value.kind === "commit" && typeof value.sha === "string" ? [value.sha] : [];
    });
    const paths = anchors.flatMap((anchor) => {
      if (!anchor || typeof anchor !== "object") return [];
      const value = (anchor as { readonly kind?: unknown; readonly path?: unknown });
      return value.kind === "path" && typeof value.path === "string" ? [value.path] : [];
    });
    const prs = anchors.flatMap((anchor) => {
      if (!anchor || typeof anchor !== "object") return [];
      const value = (anchor as { readonly kind?: unknown; readonly ref?: unknown });
      return value.kind === "pr" && typeof value.ref === "string" ? [value.ref] : [];
    });
    return `records=${parsed.records.length}; commits=[${commits.join(",")}]; paths=[${paths.join(",")}]; prs=[${prs.join(",")}]`;
  } catch {
    return "invalid JSON";
  }
}

export function decodePrepublishWitnessRef(ref: string): VerifiedTaskCompleteExternalWitness {
  if (!ref.startsWith(witnessPrefix)) throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_ENCODING_INVALID:prefix");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(ref.slice(witnessPrefix.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_ENCODING_INVALID:json");
  }
  const row = witnessRecord(parsed);
  if (row.kind === "document-publication") {
    witnessExactKeys(row, ["kind", "repositoryCommit", "publicationOperationIds", "coveredTaskRelativePaths", "coveredPathSetDigest"]);
    const without = {
      kind: "document-publication" as const,
      repositoryCommit: commit(row.repositoryCommit),
      publicationOperationIds: sortedUniqueStrings(row.publicationOperationIds),
      coveredTaskRelativePaths: sortedUniqueStrings(row.coveredTaskRelativePaths).map(canonicalTaskRelativePath),
      coveredPathSetDigest: witnessDigest(row.coveredPathSetDigest)
    };
    return { ...without, ref };
  }
  if (row.kind === "code-doc-reconciliation") {
    witnessExactKeys(row, ["kind", "repositoryCommit", "publicationOperationIds", "taskId", "reconciledCommitRef", "normalizedPaths", "prRef", "codeDocBodyDigest"]);
    const without = {
      kind: "code-doc-reconciliation" as const,
      repositoryCommit: commit(row.repositoryCommit),
      publicationOperationIds: sortedUniqueStrings(row.publicationOperationIds),
      taskId: string(row.taskId),
      reconciledCommitRef: commit(row.reconciledCommitRef),
      normalizedPaths: sortedUniqueStrings(row.normalizedPaths),
      prRef: row.prRef === null ? null : string(row.prRef),
      codeDocBodyDigest: witnessDigest(row.codeDocBodyDigest)
    };
    return { ...without, ref };
  }
  throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_KIND_INVALID");
}

async function verifyDocumentPublicationWitness(
  input: {
    readonly rootDir: string;
    readonly authoredRoot: string;
    readonly taskId: string;
    readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  },
  witness: VerifiedTaskCompleteDocumentPublicationWitness,
  snapshotMode: "current" | "committed"
): Promise<void> {
  reportCurrentRepoWriteTelemetry("compile-task-witness", {
    stage: "document-verify",
    state: "start"
  });
  const repositoryPaths = taskRepositoryPaths(input, witness.coveredTaskRelativePaths);
  let covered: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  if (snapshotMode === "current") {
    covered = [...input.documents]
      .map((document) => ({ path: canonicalTaskRelativePath(document.path), body: document.body }))
      .sort((left, right) => lexicalCompare(left.path, right.path));
  } else {
    covered = [];
    for (const [index, coveredPath] of witness.coveredTaskRelativePaths.entries()) {
      covered = [...covered, {
        path: canonicalTaskRelativePath(coveredPath),
        body: await prepublishGitBlobText(input.authoredRoot, witness.repositoryCommit, repositoryPaths[index]!)
      }];
    }
  }
  const digestValue = `sha256:${sha256Text(stableStringify(covered.map((entry) => ({
    path: entry.path,
    bodySha256: sha256Text(entry.body)
  }))))}`;
  if (stableStringify(witness.coveredTaskRelativePaths) !== stableStringify(covered.map((entry) => entry.path))
    || witness.coveredPathSetDigest !== digestValue) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_SNAPSHOT_MISMATCH:document-publication");
  }
  await assertAttributedMaterializedPublication(
    input.authoredRoot,
    witness.repositoryCommit,
    repositoryPaths,
    covered.map((entry) => entry.body),
    witness.publicationOperationIds,
    snapshotMode === "committed" ? witness.repositoryCommit : "HEAD"
  );
  reportCurrentRepoWriteTelemetry("compile-task-witness", {
    stage: "document-verify",
    state: "done"
  });
}

async function verifyCodeDocWitness(
  input: {
    readonly rootDir: string;
    readonly authoredRoot: string;
    readonly taskId: string;
    readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
    readonly command: TaskCompleteTransitionCommand;
  },
  witness: VerifiedTaskCompleteCodeDocWitness,
  snapshotMode: "current" | "committed"
): Promise<void> {
  reportCurrentRepoWriteTelemetry("compile-task-witness", {
    stage: "code-doc-verify",
    state: "start"
  });
  const [repositoryPath] = taskRepositoryPaths(input, [CODE_DOC_RECONCILIATION_DOCUMENT]);
  const currentCodeDoc = input.documents.find((document) => document.path === CODE_DOC_RECONCILIATION_DOCUMENT);
  const codeDocBody = snapshotMode === "current"
    ? currentCodeDoc?.body
    : await prepublishGitBlobText(input.authoredRoot, witness.repositoryCommit, repositoryPath!);
  if (!codeDocBody) throw new Error("AUTHORITY_TASK_COMPLETE_CODE_DOC_WITNESS_REQUIRED");
  const reconciledCommitRef = snapshotMode === "current"
    ? await resolveCommit(input.rootDir, input.command.commitRef ?? "HEAD")
    : witness.reconciledCommitRef;
  const normalizedPaths = normalizeCommandPaths(input.rootDir, input.command.approval?.paths ?? []);
  const prRef = input.command.approval?.prRef ?? null;
  const expected = snapshotMode === "current" ? renderCodeDocReconciliationDraft({
    taskId: input.taskId,
    documents: input.documents,
    sha: reconciledCommitRef,
    paths: normalizedPaths,
    ...(prRef ? { prRef } : {})
  }) : null;
  const revParseResult = await prepublishGitTextOrNull(input.rootDir, ["rev-parse", "--verify", "--end-of-options", `${witness.reconciledCommitRef}^{commit}`]);
  if ((expected && (expected.recordIds.length === 0 || expected.body !== codeDocBody))
    || witness.taskId !== input.taskId
    || witness.reconciledCommitRef !== reconciledCommitRef
    || stableStringify(witness.normalizedPaths) !== stableStringify(normalizedPaths)
    || witness.prRef !== prRef
    || witness.codeDocBodyDigest !== `sha256:${sha256Text(codeDocBody)}`
    || revParseResult !== witness.reconciledCommitRef) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_SNAPSHOT_MISMATCH:code-doc-reconciliation");
  }
  await assertAttributedMaterializedPublication(
    input.authoredRoot,
    witness.repositoryCommit,
    [repositoryPath!],
    [codeDocBody],
    witness.publicationOperationIds,
    snapshotMode === "committed" ? witness.repositoryCommit : "HEAD"
  );
  reportCurrentRepoWriteTelemetry("compile-task-witness", {
    stage: "code-doc-verify",
    state: "done"
  });
}

function encodePrepublishWitnessRef(value: Omit<VerifiedTaskCompleteExternalWitness, "ref">): string {
  return `${witnessPrefix}${Buffer.from(stableStringify(value), "utf8").toString("base64url")}`;
}

function taskRepositoryPaths(
  input: { readonly rootDir: string; readonly authoredRoot: string; readonly taskId: string },
  taskRelativePaths: ReadonlyArray<string>
): ReadonlyArray<string> {
  const taskRoot = taskPackagePath({
    rootDir: input.rootDir,
    layoutOverrides: { authoredRoot: path.relative(input.rootDir, input.authoredRoot) }
  }, input.taskId);
  return taskRelativePaths.map((relativePath) => {
    const repositoryPath = path.relative(input.authoredRoot, path.join(taskRoot, relativePath)).split(path.sep).join("/");
    if (!repositoryPath || repositoryPath.startsWith("../") || path.isAbsolute(repositoryPath)) {
      throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_PATH_ESCAPE");
    }
    return repositoryPath;
  });
}

function normalizeCommandPaths(rootDir: string, values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values.map((value) => {
    const absolute = path.resolve(rootDir, value);
    const relative = path.relative(rootDir, absolute).split(path.sep).join("/");
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new Error(`AUTHORITY_TASK_COMPLETE_CODE_DOC_PATH_INVALID:${value}`);
    }
    return relative;
  }))].sort();
}

function canonicalTaskRelativePath(value: string): string {
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized) || normalized !== value) {
    throw new Error(`AUTHORITY_TASK_COMPLETE_WITNESS_PATH_INVALID:${value}`);
  }
  return normalized;
}

async function resolveCommit(rootDir: string, ref: string): Promise<string> {
  const resolved = await prepublishGitTextOrNull(rootDir, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!resolved || !/^[0-9a-f]{40}$/u.test(resolved)) throw new Error(`AUTHORITY_TASK_COMPLETE_COMMIT_REF_INVALID:${ref}`);
  return resolved;
}

function witnessRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_ENCODING_INVALID:record");
  return value as Record<string, unknown>;
}

function witnessExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`AUTHORITY_TASK_COMPLETE_WITNESS_ENCODING_INVALID:keys:${Object.keys(value).sort().join(",")}`);
  }
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value) throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_ENCODING_INVALID:string");
  return value;
}

function commit(value: unknown): string {
  const result = string(value);
  if (!/^[0-9a-f]{40}$/u.test(result)) throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_ENCODING_INVALID:commit");
  return result;
}

function witnessDigest(value: unknown): string {
  const result = string(value);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_ENCODING_INVALID:digest");
  return result;
}

function sortedUniqueStrings(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_ENCODING_INVALID:string-array");
  const values = value.map(string);
  if (new Set(values).size !== values.length || [...values].sort().some((entry, index) => entry !== values[index])) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_ENCODING_INVALID:string-array-order");
  }
  return values;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
