// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ReplicaChangeLog, ReplicaChangeRecord } from "../../application/src/index.ts";
import { validateReadDownManagedPath } from "../src/authority/read-down-managed-path.ts";
import {
  createAuthorityReplicationContentStore,
  createContentEnrichedReplicaChangeLog
} from "../src/authority/replication-content-store.ts";

test("read-down accepts immutable UTF-8 and legacy long paths but rejects disk escape", () => {
  const fixture = createFixture();
  try {
    mkdirSync(path.join(fixture.gitRoot, "历史"));
    writeFileSync(path.join(fixture.gitRoot, "历史", "设计.txt"), "immutable history\n");
    writeFileSync(path.join(fixture.gitRoot, "历史", `${"long-".repeat(38)}fact.txt`), "legacy long path\n");
    git(fixture.gitRoot, "add", ".");
    git(fixture.gitRoot, "commit", "-m", "historical paths");

    const snapshot = fixture.content.snapshot(git(fixture.gitRoot, "rev-parse", "HEAD"), 0);
    assert.deepEqual(snapshot.entries.map((entry) => entry.path), [
      "历史/设计.txt",
      `历史/${"long-".repeat(38)}fact.txt`
    ]);
  } finally {
    fixture.cleanup();
  }

  for (const unsafe of [
    "../escape", "/absolute", "C:/drive", "\\\\server\\share", "safe/\0escape", ".git/config"
  ]) {
    assert.throws(
      () => validateReadDownManagedPath(unsafe),
      /RESYNC_REQUIRED:GIT_PATH_NOT_SAFE/u,
      unsafe
    );
  }
});

test("historical operation lookup hydrates an incomplete replica change containing a CJK path", async () => {
  const fixture = createFixture();
  try {
    writeFileSync(path.join(fixture.gitRoot, "seed.md"), "seed\n");
    git(fixture.gitRoot, "add", ".");
    git(fixture.gitRoot, "commit", "-m", "seed");
    const previousCommit = git(fixture.gitRoot, "rev-parse", "HEAD");
    mkdirSync(path.join(fixture.gitRoot, "历史"));
    writeFileSync(path.join(fixture.gitRoot, "历史", "设计.txt"), "immutable history\n");
    git(fixture.gitRoot, "add", ".");
    git(fixture.gitRoot, "commit", "-m", "historical operation");
    const historical = {
      schema: "replica-change/v1",
      workspaceId: "workspace-read-down",
      revision: 1,
      opId: "op-historical-cjk",
      semanticDigest: "semantic-historical-cjk",
      commitSha: git(fixture.gitRoot, "rev-parse", "HEAD"),
      previousCommit,
      changedAt: "2026-07-23T04:00:01.000Z"
    } as unknown as ReplicaChangeRecord;
    const incompleteLog: ReplicaChangeLog = {
      append: async () => historical,
      latest: async () => historical,
      getByOperation: async (_workspaceId, opId) =>
        opId === historical.opId ? historical : undefined,
      changesAfter: async () => [historical],
      subscribe: () => () => undefined
    };

    const recovered = await createContentEnrichedReplicaChangeLog(incompleteLog, fixture.content)
      .getByOperation("workspace-read-down", "op-historical-cjk");
    assert.ok(recovered);
    assert.equal(recovered.manifest.entryCount, 2);
    assert.ok(recovered.paths.some((entry) => entry.path === "历史/设计.txt"));
  } finally {
    fixture.cleanup();
  }
});

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-read-down-history-"));
  const gitRoot = path.join(root, "canonical");
  mkdirSync(gitRoot);
  git(gitRoot, "init", "-q");
  git(gitRoot, "config", "user.name", "Authority Test");
  git(gitRoot, "config", "user.email", "authority@example.test");
  const values = new Map<string, unknown>();
  const state = {
    get: <Value>(key: string) => values.get(key) as Value | undefined,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
    entries: <Value>() => [...values.entries()] as ReadonlyArray<readonly [string, Value]>
  };
  return {
    gitRoot,
    content: createAuthorityReplicationContentStore({
      gitRoot, state, workspaceId: "workspace-read-down", epoch: "7"
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
