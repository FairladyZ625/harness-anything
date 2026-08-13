// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stableStringify } from "@harness-anything/kernel";
import {
  assertAttributedMaterializedPublication,
  findAttributedMaterializedPublication,
  TaskCompletePrepublishNotMaterializedError
} from "../src/authority/production/task-complete-prepublish-publication.ts";

test("single-pass publication proof matches the baseline attribution outcomes", async (context) => {
  const fixture = parityRepository();
  const successPaths = [fixture.renamedPath, fixture.restoredPath];
  const successBodies = [fixture.renamedBody, fixture.restoredBody];
  try {
    await context.test("attribution succeeds with the same canonical commit and operation IDs", async () => {
      await assertSameOutcome(
        () => legacyFindAttributedMaterializedPublication(fixture.rootDir, successPaths, successBodies),
        () => findAttributedMaterializedPublication(fixture.rootDir, successPaths, successBodies)
      );
    });

    await context.test("a path whose publication changed only its mode remains unattributed", async () => {
      await assertSameOutcome(
        () => legacyFindAttributedMaterializedPublication(
          fixture.rootDir,
          [fixture.modeOnlyPath],
          [fixture.modeOnlyBody]
        ),
        () => findAttributedMaterializedPublication(
          fixture.rootDir,
          [fixture.modeOnlyPath],
          [fixture.modeOnlyBody]
        )
      );
    });

    await context.test("an inconsistent attributed commit is rejected identically", async () => {
      await assertSameOutcome(
        () => legacyAssertAttributedMaterializedPublication(
          fixture.rootDir,
          fixture.initialCommit,
          successPaths,
          successBodies,
          fixture.operationIds
        ),
        () => assertAttributedMaterializedPublication(
          fixture.rootDir,
          fixture.initialCommit,
          successPaths,
          successBodies,
          fixture.operationIds
        )
      );
    });

    await context.test("inconsistent operation IDs are rejected identically", async () => {
      await assertSameOutcome(
        () => legacyAssertAttributedMaterializedPublication(
          fixture.rootDir,
          fixture.restoredMerge,
          successPaths,
          successBodies,
          ["op_inconsistent"]
        ),
        () => assertAttributedMaterializedPublication(
          fixture.rootDir,
          fixture.restoredMerge,
          successPaths,
          successBodies,
          ["op_inconsistent"]
        )
      );
    });
  } finally {
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

function parityRepository() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-prepublish-publication-parity-"));
  const taskRoot = "tasks/task_01KZXJJQ2864Q3S37B8J199R1D-parity";
  const draftPath = `${taskRoot}/draft.md`;
  const renamedPath = `${taskRoot}/renamed.md`;
  const modeOnlyPath = `${taskRoot}/mode-only.md`;
  const restoredPath = `${taskRoot}/restored-after-delete.md`;
  const renamedBody = "# Renamed publication\n";
  const modeOnlyBody = "# Mode-only publication\n";
  const restoredBody = "# Restored publication\n";
  mkdirSync(path.join(rootDir, taskRoot), { recursive: true });
  git(rootDir, "init", "-q", "-b", "main");
  git(rootDir, "config", "user.name", "Harness Test");
  git(rootDir, "config", "user.email", "harness@example.test");
  writeFileSync(path.join(rootDir, draftPath), renamedBody);
  writeFileSync(path.join(rootDir, modeOnlyPath), modeOnlyBody);
  writeFileSync(path.join(rootDir, restoredPath), "# Before historical deletion\n");
  git(rootDir, "add", ".");
  git(rootDir, "commit", "-q", "-m", "test: seed parity documents");
  const initialCommit = git(rootDir, "rev-parse", "HEAD");

  git(rootDir, "checkout", "-q", "-b", "first-publication");
  git(rootDir, "mv", draftPath, renamedPath);
  chmodSync(path.join(rootDir, modeOnlyPath), 0o755);
  rmSync(path.join(rootDir, restoredPath));
  git(rootDir, "add", "-A");
  git(rootDir, "commit", "-q", "-m", "test: rename mode and delete publication [op_batch_one]");
  git(rootDir, "checkout", "-q", "main");
  git(rootDir, "merge", "-q", "--no-ff", "first-publication", "-m", "materialize first parity publication");

  git(rootDir, "checkout", "-q", "-b", "restored-publication");
  writeFileSync(path.join(rootDir, restoredPath), restoredBody);
  git(rootDir, "add", restoredPath);
  git(rootDir, "commit", "-q", "-m", "test: restore deleted publication [op_restore]");
  git(rootDir, "checkout", "-q", "main");
  git(rootDir, "merge", "-q", "--no-ff", "restored-publication", "-m", "materialize restored parity publication");
  const restoredMerge = git(rootDir, "rev-parse", "HEAD");

  return {
    rootDir,
    initialCommit,
    restoredMerge,
    renamedPath,
    renamedBody,
    modeOnlyPath,
    modeOnlyBody,
    restoredPath,
    restoredBody,
    operationIds: ["op_batch_one", "op_restore"]
  };
}

async function assertSameOutcome<Value>(
  baseline: () => Promise<Value>,
  singlePass: () => Promise<Value>
): Promise<void> {
  assert.deepEqual(await capture(singlePass), await capture(baseline));
}

async function capture<Value>(operation: () => Promise<Value>): Promise<unknown> {
  try {
    return { status: "fulfilled", value: await operation() };
  } catch (error) {
    return {
      status: "rejected",
      error: error instanceof TaskCompletePrepublishNotMaterializedError
        ? { name: error.name, message: error.message, code: error.code, details: error.details }
        : error instanceof Error
          ? { name: error.name, message: error.message }
          : String(error)
    };
  }
}

async function legacyAssertAttributedMaterializedPublication(
  rootDir: string,
  repositoryCommit: string,
  repositoryPaths: ReadonlyArray<string>,
  bodies: ReadonlyArray<string>,
  expectedOperationIds: ReadonlyArray<string>
): Promise<void> {
  const publication = await legacyFindAttributedMaterializedPublication(rootDir, repositoryPaths, bodies);
  if (publication.commit !== repositoryCommit) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_COMMIT_NOT_PATH_ATTRIBUTED");
  }
  if (stableStringify(publication.operationIds) !== stableStringify(expectedOperationIds)) {
    throw new Error("AUTHORITY_TASK_COMPLETE_WITNESS_OPERATION_MISMATCH");
  }
}

async function legacyFindAttributedMaterializedPublication(
  rootDir: string,
  repositoryPaths: ReadonlyArray<string>,
  bodies: ReadonlyArray<string>
): Promise<{ readonly commit: string; readonly operationIds: ReadonlyArray<string> }> {
  const expectedBlobs = bodies.map((body) => gitWithInput(rootDir, body, "hash-object", "--stdin"));
  const currentBlobs = legacyBlobIds(rootDir, "HEAD", repositoryPaths);
  if (currentBlobs.some((actual, index) => actual !== expectedBlobs[index])) {
    throw new TaskCompletePrepublishNotMaterializedError(repositoryPaths.flatMap((repositoryPath, index) => {
      const actual = currentBlobs[index];
      return actual === expectedBlobs[index] ? [] : [{
        path: repositoryPath,
        reason: actual === null ? "missing from HEAD" : "content differs from expected"
      }];
    }));
  }
  const history = legacyFirstParentHistory(rootDir, repositoryPaths);
  const attributions: Array<{ readonly commit: string; readonly operationIds: ReadonlyArray<string> } | null> =
    repositoryPaths.map(() => null);
  for (const entry of history) {
    if (entry.parents.length !== 2) continue;
    const actualBlobs = legacyBlobIds(rootDir, entry.commit, repositoryPaths);
    const candidates = repositoryPaths.flatMap((_repositoryPath, index) =>
      attributions[index] === null && actualBlobs[index] === expectedBlobs[index] ? [index] : []
    );
    if (candidates.length === 0) continue;
    const firstParentBlobs = legacyBlobIds(rootDir, entry.parents[0]!, repositoryPaths);
    for (const index of candidates) {
      if (firstParentBlobs[index] === actualBlobs[index]) continue;
      const operationIds = legacyAttributedPathOperationIds(
        rootDir,
        entry.parents[0]!,
        entry.parents[1]!,
        repositoryPaths[index]!,
        expectedBlobs[index]!
      );
      if (operationIds.length > 0) attributions[index] = { commit: entry.commit, operationIds };
    }
  }
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

function legacyFirstParentHistory(rootDir: string, repositoryPaths: ReadonlyArray<string>): ReadonlyArray<{
  readonly commit: string;
  readonly parents: ReadonlyArray<string>;
}> {
  const fields = git(rootDir,
    "log",
    "--first-parent",
    "--full-history",
    "--format=%H%x00%P%x00%s%x00",
    "HEAD",
    "--",
    ...repositoryPaths.map((repositoryPath) => `:(literal)${repositoryPath}`)
  ).split("\0");
  const rows: Array<{ commit: string; parents: ReadonlyArray<string> }> = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const commit = fields[index]!.trim();
    if (commit) rows.push({
      commit,
      parents: fields[index + 1]!.trim().split(" ").filter(Boolean)
    });
  }
  return rows;
}

function legacyAttributedPathOperationIds(
  rootDir: string,
  firstParent: string,
  authorityTip: string,
  repositoryPath: string,
  expectedBlob: string
): ReadonlyArray<string> {
  const commits = git(rootDir,
    "rev-list",
    "--reverse",
    "--topo-order",
    `${firstParent}..${authorityTip}`,
    "--",
    `:(literal)${repositoryPath}`
  ).split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  const lastChangingCommit = commits.at(-1);
  if (!lastChangingCommit) return [];
  if (legacyBlobIds(rootDir, lastChangingCommit, [repositoryPath])[0] !== expectedBlob) return [];
  return publicationOperationIds(git(rootDir, "show", "-s", "--format=%s", lastChangingCommit));
}

function legacyBlobIds(
  rootDir: string,
  commitRef: string,
  repositoryPaths: ReadonlyArray<string>
): ReadonlyArray<string | null> {
  const byPath = new Map<string, string>();
  for (const row of git(rootDir,
    "ls-tree",
    "-z",
    "--full-tree",
    commitRef,
    "--",
    ...repositoryPaths.map((repositoryPath) => `:(literal)${repositoryPath}`)
  ).split("\0")) {
    const separator = row.indexOf("\t");
    if (separator < 0) continue;
    const [, type, objectId] = row.slice(0, separator).split(" ");
    if (type === "blob" && objectId) byPath.set(row.slice(separator + 1), objectId);
  }
  return repositoryPaths.map((repositoryPath) => byPath.get(repositoryPath) ?? null);
}

function publicationOperationIds(subject: string): ReadonlyArray<string> {
  const match = /\[([^\]]+)\]$/u.exec(subject);
  return match?.[1]
    ? [...new Set(match[1].split(",").map((entry) => entry.trim()).filter(Boolean))].sort()
    : [];
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function gitWithInput(rootDir: string, input: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}
