import { execFileSync } from "node:child_process";
import { stableStringify } from "@harness-anything/kernel";

export function findAttributedMaterializedPublication(
  rootDir: string,
  repositoryPaths: ReadonlyArray<string>,
  bodies: ReadonlyArray<string>,
  headRef = "HEAD"
): { readonly commit: string; readonly operationIds: ReadonlyArray<string> } {
  const expectedBlobs = bodies.map((body) => taskCompletePublicationGitText(rootDir, ["hash-object", "--stdin"], body));
  const currentBlobs = gitBlobIds(rootDir, headRef, repositoryPaths);
  if (currentBlobs.some((actual, index) => actual !== expectedBlobs[index])) {
    throw new Error(
      `AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:${describeMaterializationMismatches(repositoryPaths, currentBlobs, expectedBlobs)}`
    );
  }
  const attributions = repositoryPaths.map((repositoryPath, index) =>
    findPathMaterializedPublication(rootDir, repositoryPath, expectedBlobs[index]!, headRef)
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
  const representative = firstParentHistory(rootDir, repositoryPaths, headRef)
    .find((entry) => attributedCommits.has(entry.commit));
  if (!representative) throw new Error("AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:attributed publication missing from first-parent history");
  return {
    commit: representative.commit,
    operationIds: [...new Set(attributed.flatMap((entry) => entry.operationIds))].sort()
  };
}

export function assertAttributedMaterializedPublication(
  rootDir: string,
  repositoryCommit: string,
  repositoryPaths: ReadonlyArray<string>,
  bodies: ReadonlyArray<string>,
  expectedOperationIds: ReadonlyArray<string>,
  headRef = "HEAD"
): void {
  const publication = findAttributedMaterializedPublication(rootDir, repositoryPaths, bodies, headRef);
  if (publication.commit !== repositoryCommit) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_COMMIT_NOT_PATH_ATTRIBUTED");
  }
  if (stableStringify(publication.operationIds) !== stableStringify(expectedOperationIds)) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_OPERATION_MISMATCH");
  }
}

export function assertCommittedMaterializedPublication(
  rootDir: string,
  repositoryCommit: string,
  repositoryPaths: ReadonlyArray<string>,
  bodies: ReadonlyArray<string>,
  expectedOperationIds: ReadonlyArray<string>
): void {
  try {
    assertAttributedMaterializedPublication(
      rootDir,
      repositoryCommit,
      repositoryPaths,
      bodies,
      expectedOperationIds,
      repositoryCommit
    );
  } catch {
    // Already-committed transitions may contain the pre-attribution witness shape.
    // The fallback is replay-only; every current/new completion uses strict path
    // attribution before it can commit.
    assertLegacyMaterializedPublication(rootDir, repositoryCommit, repositoryPaths, bodies, expectedOperationIds);
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
  repositoryPath: string,
  expectedBlob: string,
  headRef: string
): { readonly commit: string; readonly operationIds: ReadonlyArray<string> } | null {
  for (const entry of firstParentHistory(rootDir, [repositoryPath], headRef)) {
    if (entry.parents.length !== 2) continue;
    const [actualBlob] = gitBlobIds(rootDir, entry.commit, [repositoryPath]);
    if (actualBlob !== expectedBlob) continue;
    const [firstParentBlob] = gitBlobIds(rootDir, entry.parents[0]!, [repositoryPath]);
    if (firstParentBlob === actualBlob) continue;
    const operationIds = attributedPathOperationIds(rootDir, entry.parents[0]!, entry.parents[1]!, repositoryPath, expectedBlob);
    if (operationIds.length === 0) continue;
    return { commit: entry.commit, operationIds };
  }
  return null;
}

function attributedPathOperationIds(
  rootDir: string,
  firstParent: string,
  authorityTip: string,
  repositoryPath: string,
  expectedBlob: string
): ReadonlyArray<string> {
  const commits = taskCompletePublicationGitText(rootDir, [
    "rev-list",
    "--reverse",
    "--topo-order",
    `${firstParent}..${authorityTip}`,
    "--",
    `:(literal)${repositoryPath}`
  ]).split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  const lastChangingCommit = commits.at(-1);
  if (!lastChangingCommit) return [];
  const [attributedBlob] = gitBlobIds(rootDir, lastChangingCommit, [repositoryPath]);
  if (attributedBlob !== expectedBlob) return [];
  const subject = taskCompletePublicationGitText(rootDir, ["show", "-s", "--format=%s", lastChangingCommit]);
  return publicationOperationIds(subject);
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

function assertLegacyMaterializedPublication(
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
  const expectedBlobs = bodies.map((body) => taskCompletePublicationGitText(rootDir, ["hash-object", "--stdin"], body));
  const actualBlobs = gitBlobIds(rootDir, repositoryCommit, repositoryPaths);
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
    : publicationOperationIds(taskCompletePublicationGitText(rootDir, ["show", "-s", "--format=%s", entry.parents[1]!]));
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
