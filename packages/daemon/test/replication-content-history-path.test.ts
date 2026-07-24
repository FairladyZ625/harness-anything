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
  createContentEnrichedReplicaChangeLog,
  manifestDigest
} from "../src/authority/replication-content-store.ts";

test("read-down accepts immutable UTF-8 and legacy long paths but rejects disk escape", () => {
  const fixture = createFixture();
  try {
    const longPath = `历史/${"long-".repeat(38)}fact.txt`;
    mkdirSync(path.join(fixture.gitRoot, "历史"));
    writeFileSync(path.join(fixture.gitRoot, "历史", "设计.txt"), "immutable history\n");
    writeFileSync(path.join(fixture.gitRoot, longPath), "legacy long path\n");
    git(fixture.gitRoot, "add", ".");
    git(fixture.gitRoot, "commit", "-m", "historical paths");

    const commitSha = git(fixture.gitRoot, "rev-parse", "HEAD");
    const snapshot = fixture.content.snapshot(commitSha, 0);
    // Read-down exposes canonical UTF-8 byte order; callers must not inherit
    // filesystem locale or directory enumeration order.
    assert.deepEqual(snapshot.entries.map((entry) => entry.path), [
      longPath,
      "历史/设计.txt"
    ]);
    assert.equal(manifestDigest({
      workspaceId: "workspace-read-down",
      epoch: "7",
      revision: 0,
      commitSha
    }, [...snapshot.entries].reverse()), snapshot.manifestDigest);
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
    writeFileSync(path.join(fixture.gitRoot, "历史", "long-fact.txt"), "legacy path\n");
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
    assert.equal(recovered.manifest.entryCount, 3);
    assert.deepEqual(recovered.paths.map((entry) => entry.path), [
      "历史/long-fact.txt",
      "历史/设计.txt"
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("read-down retains ASCII component-collision detection", () => {
  assertPathCollision(["A/x.md", "a/y.md"]);
});

test("read-down rejects full Unicode case-folded component collisions", () => {
  for (const paths of [["Ä/x.md", "ä/y.md"], ["Straße/x.md", "STRASSE/y.md"]]) {
    assertPathCollision(paths);
  }
});

test("read-down case folding does not normalize NFC and NFD spellings", () => {
  const fixture = createFixture();
  try {
    const paths = ["café.md", "cafe\u0301.md"];
    commitTreePaths(fixture.gitRoot, paths);
    const commitSha = git(fixture.gitRoot, "rev-parse", "HEAD");
    const snapshot = fixture.content.snapshot(commitSha, 0);
    assert.deepEqual([...snapshot.entries.map((entry) => entry.path)].sort(), [...paths].sort());
  } finally {
    fixture.cleanup();
  }
});

function assertPathCollision(paths: ReadonlyArray<string>): void {
  const fixture = createFixture();
  try {
    commitTreePaths(fixture.gitRoot, paths);
    const commitSha = git(fixture.gitRoot, "rev-parse", "HEAD");
    assert.throws(
      () => fixture.content.snapshot(commitSha, 0),
      /RESYNC_REQUIRED:PORTABLE_PATH_COLLISION/u,
      paths.join(" vs ")
    );
  } finally {
    fixture.cleanup();
  }
}

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

type GitTree = Map<string, GitTree | string>;

function commitTreePaths(root: string, paths: ReadonlyArray<string>): void {
  const blobSha = gitWithInput(root, ["hash-object", "-w", "--stdin"], Buffer.from("content\n"));
  const tree: GitTree = new Map();
  for (const managedPath of paths) {
    const segments = managedPath.split("/");
    let current = tree;
    for (const segment of segments.slice(0, -1)) {
      const existing = current.get(segment);
      if (typeof existing === "string") throw new Error(`test tree file ancestor: ${managedPath}`);
      const child = existing ?? new Map<string, GitTree | string>();
      current.set(segment, child);
      current = child;
    }
    current.set(segments.at(-1)!, blobSha);
  }
  const treeSha = writeTree(tree);
  const commitSha = git(root, "commit-tree", treeSha, "-m", "plumbed paths");
  git(root, "update-ref", "HEAD", commitSha);

  function writeTree(node: GitTree): string {
    const rows = [...node.entries()]
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([name, value]) => {
        const objectId = typeof value === "string" ? value : writeTree(value);
        const metadata = typeof value === "string" ? "100644 blob" : "040000 tree";
        return Buffer.concat([Buffer.from(`${metadata} ${objectId}\t`), Buffer.from(name), Buffer.from([0])]);
      });
    return gitWithInput(root, ["mktree", "-z"], Buffer.concat(rows));
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function gitWithInput(root: string, args: ReadonlyArray<string>, input: Buffer): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();
}
