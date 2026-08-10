import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stableStringify } from "@harness-anything/kernel";
import { reportCurrentRepoWriteTelemetry } from "../../runtime/repo-write-telemetry-context.ts";

const execFileAsync = promisify(execFile);

export const taskCompletePrepublishFailureSchema = "task-complete-prepublish-failure/v1" as const;
export const taskCompletePrepublishFailureCode = "task_complete_prepublish_not_materialized" as const;

export interface TaskCompletePrepublishFailureDetails {
  readonly schema: typeof taskCompletePrepublishFailureSchema;
  readonly code: typeof taskCompletePrepublishFailureCode;
  readonly files: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

export class TaskCompletePrepublishNotMaterializedError extends Error {
  readonly code = taskCompletePrepublishFailureCode;
  readonly details: TaskCompletePrepublishFailureDetails;

  constructor(files: TaskCompletePrepublishFailureDetails["files"]) {
    super(`AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:${files.map((entry) =>
      `${entry.path} (${entry.reason})`
    ).join(", ")}`);
    this.name = "TaskCompletePrepublishNotMaterializedError";
    this.details = { schema: taskCompletePrepublishFailureSchema, code: this.code, files };
  }
}

export async function findAttributedMaterializedPublication(
  rootDir: string,
  repositoryPaths: ReadonlyArray<string>,
  bodies: ReadonlyArray<string>,
  headRef = "HEAD"
): Promise<{ readonly commit: string; readonly operationIds: ReadonlyArray<string> }> {
  reportCurrentRepoWriteTelemetry("authority-publication-proof", { stage: "blob-hash" });
  const expectedBlobs: string[] = [];
  for (const body of bodies) expectedBlobs.push(await gitHashObject(rootDir, body));
  const currentBlobs = await gitBlobIds(rootDir, headRef, repositoryPaths);
  if (currentBlobs.some((actual, index) => actual !== expectedBlobs[index])) {
    throw new TaskCompletePrepublishNotMaterializedError(
      materializationMismatches(repositoryPaths, currentBlobs, expectedBlobs)
    );
  }
  const historyPromise = firstParentHistory(rootDir, repositoryPaths, headRef);
  reportCurrentRepoWriteTelemetry("authority-publication-proof", {
    stage: "history-start",
    pathCount: repositoryPaths.length
  });
  const history = await historyPromise;
  reportCurrentRepoWriteTelemetry("authority-publication-proof", {
    stage: "history-done",
    pathCount: repositoryPaths.length,
    historyEntryCount: history.length
  });
  const attributions = await findPathMaterializedPublications(
    rootDir,
    repositoryPaths,
    expectedBlobs,
    history
  );
  const missing = attributions.flatMap((attribution, index) => attribution ? [] : [repositoryPaths[index]!]);
  if (missing.length > 0) {
    throw new TaskCompletePrepublishNotMaterializedError(missing.map((repositoryPath) => ({
      path: repositoryPath,
      reason: "no canonical publication changed this path to its current content"
    })));
  }
  const attributed = attributions.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const attributedCommits = new Set(attributed.map((entry) => entry.commit));
  const representative = history.find((entry) => attributedCommits.has(entry.commit));
  if (!representative) {
    throw new TaskCompletePrepublishNotMaterializedError(repositoryPaths.map((repositoryPath) => ({
      path: repositoryPath,
      reason: "attributed publication missing from first-parent history"
    })));
  }
  return {
    commit: representative.commit,
    operationIds: [...new Set(attributed.flatMap((entry) => entry.operationIds))].sort()
  };
}

export async function assertAttributedMaterializedPublication(
  rootDir: string,
  repositoryCommit: string,
  repositoryPaths: ReadonlyArray<string>,
  bodies: ReadonlyArray<string>,
  expectedOperationIds: ReadonlyArray<string>,
  headRef = "HEAD"
): Promise<void> {
  const publication = await findAttributedMaterializedPublication(rootDir, repositoryPaths, bodies, headRef);
  if (publication.commit !== repositoryCommit) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_COMMIT_NOT_PATH_ATTRIBUTED");
  }
  if (stableStringify(publication.operationIds) !== stableStringify(expectedOperationIds)) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_OPERATION_MISMATCH");
  }
}

export async function prepublishGitBlobText(rootDir: string, commitRef: string, repositoryPath: string): Promise<string> {
  try {
    return await taskCompletePublicationGitTextRaw(rootDir, ["show", `${commitRef}:${repositoryPath}`]);
  } catch {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_BLOB_MISSING");
  }
}

export async function prepublishGitTextOrNull(rootDir: string, args: ReadonlyArray<string>): Promise<string | null> {
  try {
    return await taskCompletePublicationGitText(rootDir, args);
  } catch {
    return null;
  }
}

async function findPathMaterializedPublications(
  rootDir: string,
  repositoryPaths: ReadonlyArray<string>,
  expectedBlobs: ReadonlyArray<string>,
  history: ReadonlyArray<{
    readonly commit: string;
    readonly parents: ReadonlyArray<string>;
    readonly subject: string;
  }>
): Promise<ReadonlyArray<{ readonly commit: string; readonly operationIds: ReadonlyArray<string> } | null>> {
  const attributions: Array<{ readonly commit: string; readonly operationIds: ReadonlyArray<string> } | null> =
    repositoryPaths.map(() => null);
  let remaining = repositoryPaths.length;
  for (const entry of history) {
    if (entry.parents.length !== 2) continue;
    const actualBlobs = await gitBlobIds(rootDir, entry.commit, repositoryPaths);
    const candidates = repositoryPaths.flatMap((_repositoryPath, index) =>
      attributions[index] === null && actualBlobs[index] === expectedBlobs[index] ? [index] : []
    );
    if (candidates.length === 0) continue;
    const firstParentBlobs = await gitBlobIds(rootDir, entry.parents[0]!, repositoryPaths);
    for (const index of candidates) {
      if (firstParentBlobs[index] === actualBlobs[index]) continue;
      const operationIds = await attributedPathOperationIds(
        rootDir,
        entry.parents[0]!,
        entry.parents[1]!,
        repositoryPaths[index]!,
        expectedBlobs[index]!
      );
      if (operationIds.length === 0) continue;
      attributions[index] = { commit: entry.commit, operationIds };
      remaining -= 1;
      reportCurrentRepoWriteTelemetry("authority-publication-proof", {
        stage: "path-attribution",
        pathCount: repositoryPaths.length,
        completedPathCount: repositoryPaths.length - remaining
      });
    }
    if (remaining === 0) break;
  }
  return attributions;
}

async function attributedPathOperationIds(
  rootDir: string,
  firstParent: string,
  authorityTip: string,
  repositoryPath: string,
  expectedBlob: string
): Promise<ReadonlyArray<string>> {
  const output = await taskCompletePublicationGitText(rootDir, [
    "rev-list",
    "--reverse",
    "--topo-order",
    `${firstParent}..${authorityTip}`,
    "--",
    `:(literal)${repositoryPath}`
  ]);
  const commits = output.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  const lastChangingCommit = commits.at(-1);
  if (!lastChangingCommit) return [];
  const [attributedBlob] = await gitBlobIds(rootDir, lastChangingCommit, [repositoryPath]);
  if (attributedBlob !== expectedBlob) return [];
  const subject = await taskCompletePublicationGitText(rootDir, ["show", "-s", "--format=%s", lastChangingCommit]);
  return publicationOperationIds(subject);
}

function materializationMismatches(
  repositoryPaths: ReadonlyArray<string>,
  actualBlobs: ReadonlyArray<string | null>,
  expectedBlobs: ReadonlyArray<string>
): TaskCompletePrepublishFailureDetails["files"] {
  return repositoryPaths.flatMap((repositoryPath, index) => {
    const actual = actualBlobs[index];
    if (actual === expectedBlobs[index]) return [];
    return [{
      path: repositoryPath,
      reason: actual === null ? "missing from HEAD" : "content differs from expected"
    }];
  });
}

async function firstParentHistory(rootDir: string, repositoryPaths: ReadonlyArray<string>, headRef = "HEAD"): Promise<ReadonlyArray<{
  readonly commit: string;
  readonly parents: ReadonlyArray<string>;
  readonly subject: string;
}>> {
  const output = await taskCompletePublicationGitText(rootDir, [
    "log",
    "--first-parent",
    "--full-history",
    "--format=%H%x00%P%x00%s%x00",
    headRef,
    "--",
    ...repositoryPaths.map((repositoryPath) => `:(literal)${repositoryPath}`)
  ]);
  const fields = output.split("\0");
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

async function taskCompletePublicationGitText(rootDir: string, args: ReadonlyArray<string>): Promise<string> {
  return (await taskCompletePublicationGitTextRaw(rootDir, args)).trim();
}

async function taskCompletePublicationGitTextRaw(rootDir: string, args: ReadonlyArray<string>): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    timeout: 25_000,
    killSignal: "SIGKILL"
  });
  return stdout;
}

async function gitHashObject(rootDir: string, body: string): Promise<string> {
  const child = execFile("git", ["-C", rootDir, "hash-object", "--stdin"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 25_000,
    killSignal: "SIGKILL"
  });
  child.stdin?.write(body);
  child.stdin?.end();
  const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`git hash-object failed (exit ${code}): ${stderr.trim()}`));
      else resolve({ stdout, stderr });
    });
  });
  return stdout.trim();
}

async function gitBlobIds(
  rootDir: string,
  commitRef: string,
  repositoryPaths: ReadonlyArray<string>
): Promise<ReadonlyArray<string | null>> {
  const output = await taskCompletePublicationGitText(rootDir, [
    "ls-tree",
    "-z",
    "--full-tree",
    commitRef,
    "--",
    ...repositoryPaths.map((repositoryPath) => `:(literal)${repositoryPath}`)
  ]);
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
