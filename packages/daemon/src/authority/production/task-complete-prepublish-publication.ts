import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  decodeAttributionEventBody,
  resolveHarnessLayout,
  sha256Text,
  stablePayloadHash,
  stableStringify,
  taskPackagePath,
  type AttributionEvent,
  type HarnessLayoutInput
} from "@harness-anything/kernel";

export function findAttributedMaterializedPublication(
  rootDir: string,
  authoredRoot: string,
  repositoryPaths: ReadonlyArray<string>,
  bodies: ReadonlyArray<string>,
  headRef = "HEAD"
): { readonly commit: string; readonly operationIds: ReadonlyArray<string> } {
  const expectedBlobs = bodies.map((body) => taskCompletePublicationGitText(authoredRoot, ["hash-object", "--stdin"], body));
  const currentBlobs = gitBlobIds(authoredRoot, headRef, repositoryPaths);
  if (currentBlobs.some((actual, index) => actual !== expectedBlobs[index])) {
    throw new Error(
      `AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:${describeMaterializationMismatches(repositoryPaths, currentBlobs, expectedBlobs)}`
    );
  }
  const attributions = repositoryPaths.map((repositoryPath, index) =>
    findPathMaterializedPublication(rootDir, authoredRoot, repositoryPath, bodies[index]!, expectedBlobs[index]!, headRef)
  );
  const missing = attributions.flatMap((attribution, index) => attribution ? [] : [repositoryPaths[index]!]);
  if (missing.length > 0) {
    throw new Error(
      `AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:${missing.map((repositoryPath) =>
        `${repositoryPath} (no canonical publication changed this path to its current content)`
      ).join(", ")}`
    );
  }
  const attributed = attributions.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const attributedCommits = new Set(attributed.map((entry) => entry.commit));
  const representative = firstParentHistory(authoredRoot, repositoryPaths, headRef)
    .find((entry) => attributedCommits.has(entry.commit));
  if (!representative) throw new Error("AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:attributed publication missing from first-parent history");
  return {
    commit: representative.commit,
    operationIds: [...new Set(attributed.flatMap((entry) => entry.operationIds))].sort()
  };
}

export function assertAttributedMaterializedPublication(
  rootDir: string,
  authoredRoot: string,
  repositoryCommit: string,
  repositoryPaths: ReadonlyArray<string>,
  bodies: ReadonlyArray<string>,
  expectedOperationIds: ReadonlyArray<string>,
  headRef = "HEAD"
): void {
  const publication = findAttributedMaterializedPublication(rootDir, authoredRoot, repositoryPaths, bodies, headRef);
  if (publication.commit !== repositoryCommit) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_COMMIT_NOT_PATH_ATTRIBUTED");
  }
  if (stableStringify(publication.operationIds) !== stableStringify(expectedOperationIds)) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_OPERATION_MISMATCH");
  }
}

export function prepublishGitBlobText(rootDir: string, commitRef: string, repositoryPath: string): string {
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

export function prepublishGitTextOrNull(rootDir: string, args: ReadonlyArray<string>): string | null {
  try {
    return taskCompletePublicationGitText(rootDir, args);
  } catch {
    return null;
  }
}

function findPathMaterializedPublication(
  rootDir: string,
  authoredRoot: string,
  repositoryPath: string,
  expectedBody: string,
  expectedBlob: string,
  headRef: string
): { readonly commit: string; readonly operationIds: ReadonlyArray<string> } | null {
  for (const entry of firstParentHistory(authoredRoot, [repositoryPath], headRef)) {
    if (entry.parents.length !== 2) continue;
    const [actualBlob] = gitBlobIds(authoredRoot, entry.commit, [repositoryPath]);
    if (actualBlob !== expectedBlob) continue;
    const [firstParentBlob] = gitBlobIds(authoredRoot, entry.parents[0]!, [repositoryPath]);
    if (firstParentBlob === actualBlob) continue;
    const operationIds = attributedPathOperationIds(
      rootDir,
      authoredRoot,
      entry.parents[0]!,
      entry.parents[1]!,
      repositoryPath,
      expectedBody,
      expectedBlob
    );
    if (operationIds.length === 0) continue;
    return { commit: entry.commit, operationIds };
  }
  return null;
}

function attributedPathOperationIds(
  rootDir: string,
  authoredRoot: string,
  firstParent: string,
  authorityTip: string,
  repositoryPath: string,
  expectedBody: string,
  expectedBlob: string
): ReadonlyArray<string> {
  const commits = taskCompletePublicationGitText(authoredRoot, [
    "rev-list",
    "--reverse",
    "--topo-order",
    `${firstParent}..${authorityTip}`,
    "--",
    `:(literal)${repositoryPath}`
  ]).split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  const lastChangingCommit = commits.at(-1);
  if (!lastChangingCommit) return [];
  const [attributedBlob] = gitBlobIds(authoredRoot, lastChangingCommit, [repositoryPath]);
  if (attributedBlob !== expectedBlob) return [];
  const subject = taskCompletePublicationGitText(authoredRoot, ["show", "-s", "--format=%s", lastChangingCommit]);
  return publicationOperationIds(subject).filter((operationId) => durableAttributionConfirmsPath({
    rootDir,
    authoredRoot,
    firstParent,
    authorityTip,
    operationId,
    repositoryPath,
    expectedBody
  }));
}

function durableAttributionConfirmsPath(input: {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly firstParent: string;
  readonly authorityTip: string;
  readonly operationId: string;
  readonly repositoryPath: string;
  readonly expectedBody: string;
}): boolean {
  try {
    const rootInput = taskCompleteLayoutInput(input.rootDir, input.authoredRoot);
    const eventPath = repositoryRelativePath(
      input.authoredRoot,
      path.join(resolveHarnessLayout(rootInput).attributionEventsRoot, `${sha256Text(input.operationId)}.jsonl`)
    );
    const [authorityEventBlob] = gitBlobIds(input.authoredRoot, input.authorityTip, [eventPath]);
    const [firstParentEventBlob] = gitBlobIds(input.authoredRoot, input.firstParent, [eventPath]);
    if (!authorityEventBlob || authorityEventBlob === firstParentEventBlob) return false;
    const eventBody = taskCompletePublicationGitText(input.authoredRoot, ["show", `${input.authorityTip}:${eventPath}`]);
    const event = decodeAttributionEventBody(eventBody);
    if (event.opId !== input.operationId) return false;
    const payload = readVerifiedAttributionPayload(input.rootDir, event);
    return attributionPayloadConfirmsPath(rootInput, input.authoredRoot, event, payload, input.repositoryPath, input.expectedBody);
  } catch {
    return false;
  }
}

function readVerifiedAttributionPayload(rootDir: string, event: AttributionEvent): Record<string, unknown> {
  const absoluteRoot = path.resolve(rootDir);
  const payloadPath = path.resolve(absoluteRoot, event.payloadRef.path);
  if (!isWithinRoot(absoluteRoot, payloadPath)) throw new Error("attribution payload path escapes root");
  const body = readFileSync(payloadPath, "utf8");
  if (sha256Text(body) !== event.payloadRef.sha256) throw new Error("attribution payload bytes differ");
  const payload: unknown = JSON.parse(body);
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || stablePayloadHash(payload) !== event.payloadHash) {
    throw new Error("attribution payload hash differs");
  }
  return payload as Record<string, unknown>;
}

function attributionPayloadConfirmsPath(
  rootInput: HarnessLayoutInput,
  authoredRoot: string,
  event: AttributionEvent,
  payload: Record<string, unknown>,
  repositoryPath: string,
  expectedBody: string
): boolean {
  const expectedBodySha256 = sha256Text(expectedBody);
  if (event.kind === "doc_sync_submit" || event.kind === "script_ingest") {
    return payloadWrites(payload).some((write) => write.path === repositoryPath && writeBodyMatches(write, expectedBodySha256));
  }
  const batchWrites = [
    ...payloadWrites(payload),
    ...recordWrites(payload.taskWrites)
  ];
  if (batchWrites.some((write) => taskDocumentWriteMatches(rootInput, authoredRoot, write, repositoryPath, expectedBodySha256))) {
    return true;
  }
  const taskId = taskIdFromAttributionEvent(event);
  const pathValue = typeof payload.path === "string" ? payload.path : null;
  if (!taskId || !pathValue) return false;
  const packageRoot = taskPackagePath(rootInput, taskId);
  const targetPath = repositoryRelativePath(authoredRoot, path.join(packageRoot, pathValue));
  if (targetPath !== repositoryPath) return false;
  return writeBodyMatches(payload, expectedBodySha256) || typeof payload.append === "string" || payload.appendRecord !== undefined;
}

function taskDocumentWriteMatches(
  rootInput: HarnessLayoutInput,
  authoredRoot: string,
  write: Record<string, unknown>,
  repositoryPath: string,
  expectedBodySha256: string
): boolean {
  if (typeof write.taskId !== "string" || typeof write.path !== "string") return false;
  const packageRoot = taskPackagePath(rootInput, write.taskId);
  const targetPath = repositoryRelativePath(authoredRoot, path.join(packageRoot, write.path));
  return targetPath === repositoryPath && writeBodyMatches(write, expectedBodySha256);
}

function payloadWrites(payload: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> {
  return recordWrites(payload.writes);
}

function recordWrites(value: unknown): ReadonlyArray<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function writeBodyMatches(write: Record<string, unknown>, expectedBodySha256: string): boolean {
  return (typeof write.body === "string" && sha256Text(write.body) === expectedBodySha256)
    || write.bodySha256 === expectedBodySha256;
}

function taskIdFromAttributionEvent(event: AttributionEvent): string | null {
  const match = /^task\/(.+)$/u.exec(event.entityId);
  return match?.[1] ?? null;
}

function taskCompleteLayoutInput(rootDir: string, authoredRoot: string): HarnessLayoutInput {
  const relativeAuthoredRoot = path.relative(rootDir, authoredRoot).split(path.sep).join("/") || ".";
  if (relativeAuthoredRoot.startsWith("../") || path.isAbsolute(relativeAuthoredRoot)) {
    throw new Error("authored root escapes repository");
  }
  return {
    rootDir,
    layoutOverrides: { authoredRoot: relativeAuthoredRoot }
  };
}

function repositoryRelativePath(repositoryRoot: string, absolutePath: string): string {
  const relative = path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("path escapes repository");
  return relative;
}

function isWithinRoot(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function describeMaterializationMismatches(
  repositoryPaths: ReadonlyArray<string>,
  actualBlobs: ReadonlyArray<string | null>,
  expectedBlobs: ReadonlyArray<string>
): string {
  return repositoryPaths.flatMap((repositoryPath, index) => {
    const actual = actualBlobs[index];
    if (actual === expectedBlobs[index]) return [];
    return [actual === null
      ? `${repositoryPath} (missing from HEAD)`
      : `${repositoryPath} (content differs from expected)`];
  }).join(", ");
}

function firstParentHistory(rootDir: string, repositoryPaths: ReadonlyArray<string>, headRef = "HEAD"): ReadonlyArray<{
  readonly commit: string;
  readonly parents: ReadonlyArray<string>;
  readonly subject: string;
}> {
  const fields = taskCompletePublicationGitText(rootDir, [
    "log",
    "--first-parent",
    "--full-history",
    "--format=%H%x00%P%x00%s%x00",
    headRef,
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

function taskCompletePublicationGitText(rootDir: string, args: ReadonlyArray<string>, input?: string): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  }).trim();
}

function gitBlobIds(
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
