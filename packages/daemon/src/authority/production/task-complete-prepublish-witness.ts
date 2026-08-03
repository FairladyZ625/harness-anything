import { execFileSync } from "node:child_process";
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

const witnessPrefix = "ha-prepublish-witness-v1.";

export function resolveVerifiedTaskCompleteWitnesses(input: {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly taskId: string;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  readonly command: TaskCompleteTransitionCommand;
  readonly requireCodeDoc: boolean;
}): ReadonlyArray<VerifiedTaskCompleteExternalWitness> {
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
      ?? produceDocumentPublicationWitness(input),
    ...(input.requireCodeDoc
      ? [suppliedByKind.get("code-doc-reconciliation") ?? produceCodeDocWitness(input)]
      : [])
  ];
  return verifyTaskCompleteWitnessRefs({ ...input, refs });
}

export function verifyTaskCompleteWitnessRefs(input: {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly taskId: string;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  readonly command: TaskCompleteTransitionCommand;
  readonly requireCodeDoc: boolean;
  readonly refs: ReadonlyArray<TaskCompleteExternalCheckpointRef>;
  readonly snapshotMode?: "current" | "committed";
}): ReadonlyArray<VerifiedTaskCompleteExternalWitness> {
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
  verifyDocumentPublicationWitness(input, document, input.snapshotMode ?? "current");
  const codeDoc = decodedByKind.get("code-doc-reconciliation");
  if (input.requireCodeDoc) {
    if (!codeDoc || codeDoc.kind !== "code-doc-reconciliation") {
      throw new Error("AUTHORITY_TASK_COMPLETE_CODE_DOC_WITNESS_REQUIRED");
    }
    verifyCodeDocWitness(input, codeDoc, input.snapshotMode ?? "current");
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

export function produceDocumentPublicationWitness(input: {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly taskId: string;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
}): VerifiedTaskCompleteDocumentPublicationWitness {
  const covered = [...input.documents]
    .map((document) => ({ path: canonicalTaskRelativePath(document.path), body: document.body }))
    .sort((left, right) => lexicalCompare(left.path, right.path));
  if (covered.length === 0) throw new Error("AUTHORITY_TASK_COMPLETE_DOCUMENT_PUBLICATION_EMPTY");
  const repositoryPaths = taskRepositoryPaths(input, covered.map((entry) => entry.path));
  const publication = findMaterializedPublication(input.authoredRoot, repositoryPaths, covered.map((entry) => entry.body));
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
  return { ...witnessWithoutRef, ref: encodePrepublishWitnessRef(witnessWithoutRef) };
}

export function produceCodeDocWitness(input: {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly taskId: string;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  readonly command: TaskCompleteTransitionCommand;
}): VerifiedTaskCompleteCodeDocWitness {
  const codeDoc = input.documents.find((document) => document.path === CODE_DOC_RECONCILIATION_DOCUMENT);
  if (!codeDoc) {
    throw new Error(
      "AUTHORITY_TASK_COMPLETE_CODE_DOC_WITNESS_REQUIRED: run `ha task submit <task-id> --from-file submission.json`, then `ha task code-doc reconcile <task-id> --commit <full-sha> [--path <repo-relative-path>]...`, before `ha task complete`."
    );
  }
  const reconciled = resolveCommit(input.rootDir, input.command.commitRef ?? "HEAD");
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
      "AUTHORITY_TASK_COMPLETE_CODE_DOC_NOT_RECONCILED_TO_INTENT: run `ha task code-doc reconcile <task-id> --commit <full-sha> [--path <repo-relative-path>]...` after task submit and before task complete."
    );
  }
  const [repositoryPath] = taskRepositoryPaths(input, [CODE_DOC_RECONCILIATION_DOCUMENT]);
  const publication = findMaterializedPublication(input.authoredRoot, [repositoryPath!], [codeDoc.body]);
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
  return { ...witnessWithoutRef, ref: encodePrepublishWitnessRef(witnessWithoutRef) };
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

function verifyDocumentPublicationWitness(
  input: {
    readonly rootDir: string;
    readonly authoredRoot: string;
    readonly taskId: string;
    readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  },
  witness: VerifiedTaskCompleteDocumentPublicationWitness,
  snapshotMode: "current" | "committed"
): void {
  const repositoryPaths = taskRepositoryPaths(input, witness.coveredTaskRelativePaths);
  const covered = snapshotMode === "current"
    ? [...input.documents]
      .map((document) => ({ path: canonicalTaskRelativePath(document.path), body: document.body }))
      .sort((left, right) => lexicalCompare(left.path, right.path))
    : witness.coveredTaskRelativePaths.map((coveredPath, index) => ({
      path: canonicalTaskRelativePath(coveredPath),
      body: witnessGitBlobText(input.authoredRoot, witness.repositoryCommit, repositoryPaths[index]!)
    }));
  const digestValue = `sha256:${sha256Text(stableStringify(covered.map((entry) => ({
    path: entry.path,
    bodySha256: sha256Text(entry.body)
  }))))}`;
  if (stableStringify(witness.coveredTaskRelativePaths) !== stableStringify(covered.map((entry) => entry.path))
    || witness.coveredPathSetDigest !== digestValue) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_SNAPSHOT_MISMATCH:document-publication");
  }
  assertMaterializedPublication(
    input.authoredRoot,
    witness.repositoryCommit,
    repositoryPaths,
    covered.map((entry) => entry.body),
    witness.publicationOperationIds
  );
}

function verifyCodeDocWitness(
  input: {
    readonly rootDir: string;
    readonly authoredRoot: string;
    readonly taskId: string;
    readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
    readonly command: TaskCompleteTransitionCommand;
  },
  witness: VerifiedTaskCompleteCodeDocWitness,
  snapshotMode: "current" | "committed"
): void {
  const [repositoryPath] = taskRepositoryPaths(input, [CODE_DOC_RECONCILIATION_DOCUMENT]);
  const currentCodeDoc = input.documents.find((document) => document.path === CODE_DOC_RECONCILIATION_DOCUMENT);
  const codeDocBody = snapshotMode === "current"
    ? currentCodeDoc?.body
    : witnessGitBlobText(input.authoredRoot, witness.repositoryCommit, repositoryPath!);
  if (!codeDocBody) throw new Error("AUTHORITY_TASK_COMPLETE_CODE_DOC_WITNESS_REQUIRED");
  const reconciledCommitRef = snapshotMode === "current"
    ? resolveCommit(input.rootDir, input.command.commitRef ?? "HEAD")
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
  if ((expected && (expected.recordIds.length === 0 || expected.body !== codeDocBody))
    || witness.taskId !== input.taskId
    || witness.reconciledCommitRef !== reconciledCommitRef
    || stableStringify(witness.normalizedPaths) !== stableStringify(normalizedPaths)
    || witness.prRef !== prRef
    || witness.codeDocBodyDigest !== `sha256:${sha256Text(codeDocBody)}`
    || gitTextOrNull(input.rootDir, ["rev-parse", "--verify", "--end-of-options", `${witness.reconciledCommitRef}^{commit}`]) !== witness.reconciledCommitRef) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_SNAPSHOT_MISMATCH:code-doc-reconciliation");
  }
  assertMaterializedPublication(
    input.authoredRoot,
    witness.repositoryCommit,
    [repositoryPath!],
    [codeDocBody],
    witness.publicationOperationIds
  );
}

function encodePrepublishWitnessRef(value: Omit<VerifiedTaskCompleteExternalWitness, "ref">): string {
  return `${witnessPrefix}${Buffer.from(stableStringify(value), "utf8").toString("base64url")}`;
}

function findMaterializedPublication(
  rootDir: string,
  repositoryPaths: ReadonlyArray<string>,
  bodies: ReadonlyArray<string>
): { readonly commit: string; readonly operationIds: ReadonlyArray<string> } {
  const expectedBlobs = bodies.map((body) => witnessGitText(rootDir, ["hash-object", "--stdin"], body));
  const currentBlobs = witnessGitBlobIds(rootDir, "HEAD", repositoryPaths);
  if (currentBlobs.some((actual, index) => actual !== expectedBlobs[index])) {
    throw new Error(`AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:${repositoryPaths.join(",")}`);
  }
  for (const entry of firstParentHistory(rootDir, repositoryPaths)) {
    if (entry.parents.length !== 2) continue;
    const operationIds = canonicalPublicationOperationIds(rootDir, entry);
    if (operationIds.length === 0) continue;
    const actualBlobs = witnessGitBlobIds(rootDir, entry.commit, repositoryPaths);
    const matches = actualBlobs.every((actual, index) => actual === expectedBlobs[index]);
    if (matches) return { commit: entry.commit, operationIds };
  }
  throw new Error(`AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:${repositoryPaths.join(",")}`);
}

function assertMaterializedPublication(
  rootDir: string,
  repositoryCommit: string,
  repositoryPaths: ReadonlyArray<string>,
  bodies: ReadonlyArray<string>,
  expectedOperationIds: ReadonlyArray<string>
): void {
  const entry = firstParentHistory(rootDir, repositoryPaths)
    .find((candidate) => candidate.commit === repositoryCommit);
  if (!entry || entry.parents.length !== 2) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_COMMIT_NOT_MATERIALIZED_FIRST_PARENT");
  }
  const operationIds = canonicalPublicationOperationIds(rootDir, entry);
  if (operationIds.length === 0 || stableStringify(operationIds) !== stableStringify(expectedOperationIds)) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_OPERATION_MISMATCH");
  }
  const expectedBlobs = bodies.map((body) => witnessGitText(rootDir, ["hash-object", "--stdin"], body));
  const actualBlobs = witnessGitBlobIds(rootDir, repositoryCommit, repositoryPaths);
  const matches = actualBlobs.every((actual, index) => actual === expectedBlobs[index]);
  if (!matches) throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_BLOB_MISMATCH");
}

function canonicalPublicationOperationIds(
  rootDir: string,
  entry: { readonly parents: ReadonlyArray<string>; readonly subject: string }
): ReadonlyArray<string> {
  const firstParentIds = publicationOperationIds(entry.subject);
  return firstParentIds.length > 0
    ? firstParentIds
    : publicationOperationIds(witnessGitText(rootDir, ["show", "-s", "--format=%s", entry.parents[1]!]));
}

function firstParentHistory(rootDir: string, repositoryPaths: ReadonlyArray<string>): ReadonlyArray<{
  readonly commit: string;
  readonly parents: ReadonlyArray<string>;
  readonly subject: string;
}> {
  const fields = witnessGitText(rootDir, [
    "log",
    "--first-parent",
    "--full-history",
    "--format=%H%x00%P%x00%s%x00",
    "HEAD",
    "--",
    ...repositoryPaths.map((repositoryPath) => `:(literal)${repositoryPath}`)
  ]).split("\0");
  const rows: Array<{ commit: string; parents: ReadonlyArray<string>; subject: string }> = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const commit = fields[index]!.trim();
    if (!commit) continue;
    rows.push({
      commit,
      parents: fields[index + 1]!.trim().split(" ").filter(Boolean),
      subject: fields[index + 2]!.trim()
    });
  }
  return rows;
}

function publicationOperationIds(subject: string): ReadonlyArray<string> {
  const match = /\[([^\]]+)\]$/u.exec(subject);
  return match?.[1]
    ? [...new Set(match[1].split(",").map((entry) => entry.trim()).filter(Boolean))].sort()
    : [];
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

function resolveCommit(rootDir: string, ref: string): string {
  const resolved = gitTextOrNull(rootDir, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!resolved || !/^[0-9a-f]{40}$/u.test(resolved)) throw new Error(`AUTHORITY_TASK_COMPLETE_COMMIT_REF_INVALID:${ref}`);
  return resolved;
}

function witnessGitText(rootDir: string, args: ReadonlyArray<string>, input?: string): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  }).trim();
}

function witnessGitBlobText(rootDir: string, commitRef: string, repositoryPath: string): string {
  try {
    return execFileSync("git", ["-C", rootDir, "show", `${commitRef}:${repositoryPath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    });
  } catch {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_BLOB_MISSING");
  }
}

function witnessGitBlobIds(
  rootDir: string,
  commitRef: string,
  repositoryPaths: ReadonlyArray<string>
): ReadonlyArray<string | null> {
  const output = execFileSync("git", [
    "-C",
    rootDir,
    "ls-tree",
    "-z",
    "--full-tree",
    commitRef,
    "--",
    ...repositoryPaths.map((repositoryPath) => `:(literal)${repositoryPath}`)
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  const byPath = new Map<string, string>();
  for (const row of output.split("\0")) {
    if (!row) continue;
    const separator = row.indexOf("\t");
    if (separator < 0) continue;
    const [mode, type, objectId] = row.slice(0, separator).split(" ");
    if (mode && type === "blob" && objectId) byPath.set(row.slice(separator + 1), objectId);
  }
  return repositoryPaths.map((repositoryPath) => byPath.get(repositoryPath) ?? null);
}

function gitTextOrNull(rootDir: string, args: ReadonlyArray<string>): string | null {
  try {
    return witnessGitText(rootDir, args);
  } catch {
    return null;
  }
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
