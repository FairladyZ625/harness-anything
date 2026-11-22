// harness-test-tier: contract
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHarnessLayout, sha256Text, type TaskProjectionQueries } from "@harness-anything/kernel";
import { BASE_BACKUP_ARCHIVE_ROOT } from "@harness-anything/storage";
import type { ReplicaGeneration } from "../src/fleet-sync/fleet/replica-generation.ts";
import { materializeFleetMirrorView, type FleetMirrorView } from "../src/daemon-host/fleet-edge-mirror.ts";

interface SyntheticDoc {
  path: string;
  blobSha256: string;
  size: number;
  mediaType: string;
  policyId: string | null;
}

interface SyntheticTask {
  taskId: string;
  status: string;
  packagePath: string;
  packageDisposition: "active";
}

function captureAuthoredReads<T>(authoredRoot: string, fn: () => T): { result: T; readPaths: string[] } {
  const normalizedRoot = path.resolve(authoredRoot) + path.sep;
  const readPaths: string[] = [];
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function trackedReadFileSync(filePath: fs.PathOrFileDescriptor, ...rest: unknown[]) {
    if (typeof filePath === "string") {
      const resolved = path.resolve(filePath);
      if (resolved.startsWith(normalizedRoot)) {
        readPaths.push(resolved.slice(normalizedRoot.length).split(path.sep).join("/"));
      }
    }
    return (originalReadFileSync as (...args: unknown[]) => unknown).call(this, filePath, ...rest) as ReturnType<
      typeof fs.readFileSync
    >;
  } as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    return { result: fn(), readPaths };
  } finally {
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }
}

function writeObjectBlob(replicaRoot: string, ledgerGeneration: number, body: string): { sha: string; size: number } {
  const bytes = Buffer.from(body);
  const sha = sha256Text(body);
  const objectFile = path.join(
    replicaRoot,
    BASE_BACKUP_ARCHIVE_ROOT,
    "store",
    "generations",
    String(ledgerGeneration),
    "objects",
    "sha256",
    sha.slice(0, 2),
    sha.slice(2),
  );
  mkdirSync(path.dirname(objectFile), { recursive: true });
  writeFileSync(objectFile, bytes);
  return { sha, size: bytes.length };
}

function makeSyntheticMirrorFixture(taskCount: number, filesPerTask: number) {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "ha-mirror-inc-"));
  const workspaceRoot = path.join(tmpRoot, "workspace");
  const replicaRoot = path.join(tmpRoot, "replica");
  const layout = resolveHarnessLayout(workspaceRoot);
  mkdirSync(layout.authoredRoot, { recursive: true });
  mkdirSync(layout.localRoot, { recursive: true });
  writeFileSync(layout.settingsLocalPath, JSON.stringify({ nodeTaskMaterializationPolicy: "in_flight" }));

  const tasks = new Map<string, SyntheticTask>();
  const docsByPrefix = new Map<string, SyntheticDoc[]>();
  const docsByPath = new Map<string, SyntheticDoc>();
  const markerEntries: Record<string, string> = {};

  for (let i = 0; i < taskCount; i++) {
    const taskId = `task_${String(i).padStart(6, "0")}`;
    const pkgPath = `tasks/${taskId}`;
    tasks.set(taskId, { taskId, status: "active", packagePath: pkgPath, packageDisposition: "active" });
    mkdirSync(path.join(layout.authoredRoot, pkgPath), { recursive: true });
    const list: SyntheticDoc[] = [];
    for (let j = 0; j < filesPerTask; j++) {
      const logical = `${pkgPath}/doc_${j}.md`;
      const body = `# ${taskId} doc ${j}\nSynthetic body ${i}-${j}\n`;
      const sha = sha256Text(body);
      const buf = Buffer.from(body);
      writeFileSync(path.join(layout.authoredRoot, logical), buf);
      const doc: SyntheticDoc = {
        path: logical,
        blobSha256: sha,
        size: buf.length,
        mediaType: "text/markdown",
        policyId: null,
      };
      list.push(doc);
      docsByPath.set(logical, doc);
      markerEntries[logical] = sha;
    }
    docsByPrefix.set(`${pkgPath}/`, list);
  }

  const markerPath = path.join(layout.localRoot, "fleet-materialized.json");
  writeFileSync(markerPath, JSON.stringify({ revision: 100, generation: 1, entries: markerEntries }));

  let revision = 100;
  const projection = {
    readDocuments: (prefix: string, opts?: { excludeTaskPackages?: boolean }) => {
      if (opts?.excludeTaskPackages) {
        return {
          status: "ready",
          watermark: revision,
          sourceRevision: revision,
          documents: [],
          page: { nextPath: null },
        };
      }
      return {
        status: "ready",
        watermark: revision,
        sourceRevision: revision,
        documents: docsByPrefix.get(prefix) ?? [],
        page: { nextPath: null },
      };
    },
    readTaskIndex: (filter?: { status?: string; taskIds?: readonly string[] }) => {
      if (filter?.status) {
        return { rows: [...tasks.values()].filter((row) => row.status === filter.status) };
      }
      if (filter?.taskIds) {
        const set = new Set(filter.taskIds);
        return { rows: [...tasks.values()].filter((row) => set.has(row.taskId)) };
      }
      return { rows: [...tasks.values()] };
    },
    readTaskRelationsBySources: () => ({ rows: [] }),
    taskIdForDocumentPath: (logical: string) => {
      const folder = logical.split("/")[1];
      return folder && tasks.has(folder) ? folder : null;
    },
    readDocument: (logical: string) => ({ document: docsByPath.get(logical) ?? null }),
  } as unknown as TaskProjectionQueries;

  const makeView = (rev: number): FleetMirrorView => ({
    repoId: "synthetic-repo",
    viewId: "node-edge",
    viewDir: replicaRoot,
    revision: rev,
    schemaGeneration: 1,
    headDigest: `sha256:rev-${rev}`,
    manifestDigest: `sha256:1:${rev}`,
    ledgerGeneration: 1,
    readerProfile: null,
    authorizationShapeDigest: "",
    entries: new Map(),
  });

  const generation = {
    rootDir: replicaRoot,
    projectionPath: path.join(replicaRoot, "projection.sqlite"),
    ledgerPath: path.join(replicaRoot, "ledger.sqlite"),
    metadata: { ledgerGeneration: 1, projectionSchema: 1, position: { history: "h1", sequence: 100, revision: 100 } },
  } as unknown as ReplicaGeneration;

  const updateDoc = (taskId: string, docIndex: number, newBody: string) => {
    const pkgPath = `tasks/${taskId}`;
    const logical = `${pkgPath}/doc_${docIndex}.md`;
    const { sha, size } = writeObjectBlob(replicaRoot, 1, newBody);
    const updated: SyntheticDoc = { path: logical, blobSha256: sha, size, mediaType: "text/markdown", policyId: null };
    docsByPath.set(logical, updated);
    const list = docsByPrefix.get(`${pkgPath}/`) ?? [];
    const idx = list.findIndex((d) => d.path === logical);
    if (idx >= 0) list[idx] = updated;
    else list.push(updated);
    docsByPrefix.set(`${pkgPath}/`, list);
    return logical;
  };

  const addTask = (taskId: string, body: string) => {
    const pkgPath = `tasks/${taskId}`;
    tasks.set(taskId, { taskId, status: "active", packagePath: pkgPath, packageDisposition: "active" });
    return updateDoc(taskId, 0, body);
  };

  const setTaskStatus = (taskId: string, status: string) => {
    const existing = tasks.get(taskId);
    if (existing) existing.status = status;
  };

  const advanceRevision = () => ++revision;

  return {
    tmpRoot,
    workspaceRoot,
    replicaRoot,
    layout,
    projection,
    generation,
    makeView,
    updateDoc,
    addTask,
    setTaskStatus,
    advanceRevision,
  };
}

test("anti-regression gate: incremental mirror cut never scans unrelated tasks on empty change, single update, add, or revoke", () => {
  const f = makeSyntheticMirrorFixture(200, 3);
  try {
    // 1. Empty changedPaths with no diff -> 0 readFileSync on any tasks/task_* file.
    const empty = captureAuthoredReads(f.layout.authoredRoot, () =>
      materializeFleetMirrorView(f.workspaceRoot, f.makeView(100), f.projection, f.generation, { changedPaths: [] }),
    );
    assert.deepEqual(empty.result.dirtyPaths, []);
    assert.deepEqual(empty.result.settlements, []);
    assert.deepEqual(empty.readPaths, [], "changedPaths=[] with no diff must perform 0 readFileSync on tasks/task_*");

    // 2. Single task document update -> only that 1 file is read/updated; 0 reads on other 199 tasks.
    const updatedPath = f.updateDoc("task_000001", 0, "# task_000001 doc 0 updated\n");
    const rev1 = f.advanceRevision();
    const singleUpdate = captureAuthoredReads(f.layout.authoredRoot, () =>
      materializeFleetMirrorView(f.workspaceRoot, f.makeView(rev1), f.projection, f.generation, {
        changedPaths: [updatedPath],
      }),
    );
    assert.deepEqual(singleUpdate.result.dirtyPaths, []);
    assert.deepEqual(singleUpdate.readPaths, [updatedPath], "single-task update must only read that changed file");
    assert.equal(readFileSync(path.join(f.layout.authoredRoot, updatedPath), "utf8"), "# task_000001 doc 0 updated\n");

    // 3. New task added via lifecycle event with changedPaths=[] -> diff captures new task, 0 reads on unrelated tasks.
    const newPath = f.addTask("task_999999", "# newly active task\n");
    const rev2 = f.advanceRevision();
    const added = captureAuthoredReads(f.layout.authoredRoot, () =>
      materializeFleetMirrorView(f.workspaceRoot, f.makeView(rev2), f.projection, f.generation, { changedPaths: [] }),
    );
    assert.deepEqual(added.result.dirtyPaths, []);
    assert.deepEqual(added.readPaths, [], "newly added missing file needs 0 readFileSync on unrelated tasks");
    assert.equal(readFileSync(path.join(f.layout.authoredRoot, newPath), "utf8"), "# newly active task\n");

    // 4. Single task transitions to done under in_flight policy with changedPaths=[] -> only that task's 3 files are read & revoked.
    f.setTaskStatus("task_000002", "done");
    const rev3 = f.advanceRevision();
    const revoked = captureAuthoredReads(f.layout.authoredRoot, () =>
      materializeFleetMirrorView(f.workspaceRoot, f.makeView(rev3), f.projection, f.generation, { changedPaths: [] }),
    );
    assert.deepEqual(revoked.result.dirtyPaths, []);
    assert.deepEqual(
      revoked.readPaths.sort(),
      ["tasks/task_000002/doc_0.md", "tasks/task_000002/doc_1.md", "tasks/task_000002/doc_2.md"],
      "revoking a done task must only read that task's files, never unrelated tasks",
    );
    assert.equal(existsSync(path.join(f.layout.authoredRoot, "tasks/task_000002")), false);
    assert.ok(existsSync(path.join(f.layout.authoredRoot, "tasks/task_000003/doc_0.md")));

    // 5. Same-byte-length local tamper on a task document updated by center -> surfaces dirtyPaths and preserves local edit.
    const targetPath = "tasks/task_000004/doc_0.md";
    const originalContent = readFileSync(path.join(f.layout.authoredRoot, targetPath), "utf8");
    const tamperedSameLength = "X" + originalContent.slice(1);
    assert.equal(Buffer.byteLength(tamperedSameLength), Buffer.byteLength(originalContent));
    writeFileSync(path.join(f.layout.authoredRoot, targetPath), tamperedSameLength);

    f.updateDoc("task_000004", 0, "# center new content for task_000004\n");
    const rev4 = f.advanceRevision();
    const conflict = captureAuthoredReads(f.layout.authoredRoot, () =>
      materializeFleetMirrorView(f.workspaceRoot, f.makeView(rev4), f.projection, f.generation, { changedPaths: [] }),
    );
    assert.deepEqual(conflict.result.dirtyPaths, [targetPath], "same-byte-length local tamper must trigger dirtyPaths");
    assert.deepEqual(conflict.readPaths, [targetPath], "conflict check must still only touch the changed file");
    assert.equal(readFileSync(path.join(f.layout.authoredRoot, targetPath), "utf8"), tamperedSameLength);
  } finally {
    rmSync(f.tmpRoot, { recursive: true, force: true });
  }
});

test("anti-regression gate: 10,000-file synthetic mirror incremental confirmation stays O(delta) with 0 unrelated disk reads or hashes", () => {
  const f = makeSyntheticMirrorFixture(2000, 5); // 10,000 files
  const measureHashes = <T>(fn: () => T): { result: T; hashCalls: number } => {
    let hashCalls = 0;
    const originalDigest = crypto.Hash.prototype.digest;
    crypto.Hash.prototype.digest = function countedDigest(...args: Parameters<typeof originalDigest>) {
      hashCalls += 1;
      return originalDigest.apply(this, args);
    } as typeof originalDigest;
    try {
      return { result: fn(), hashCalls };
    } finally {
      crypto.Hash.prototype.digest = originalDigest;
    }
  };
  try {
    // 1. Empty replica-confirmed on 10,000-file tree -> 0 readFileSync, 0 sha256 calls.
    const empty = measureHashes(() =>
      captureAuthoredReads(f.layout.authoredRoot, () =>
        materializeFleetMirrorView(f.workspaceRoot, f.makeView(100), f.projection, f.generation, { changedPaths: [] }),
      ),
    );
    assert.deepEqual(empty.result.result.dirtyPaths, []);
    assert.deepEqual(
      empty.result.readPaths,
      [],
      "10k-file empty confirmation must perform 0 readFileSync on tasks/task_*",
    );
    assert.equal(empty.hashCalls, 0, "10k-file empty confirmation must perform 0 sha256 hashes");

    // 2. Single-task document update on 10,000-file tree -> exactly 1 readFileSync, 1 sha256 call.
    const updatedPath = f.updateDoc("task_000001", 0, "# updated single file on 10k tree\n");
    const rev1 = f.advanceRevision();
    const single = measureHashes(() =>
      captureAuthoredReads(f.layout.authoredRoot, () =>
        materializeFleetMirrorView(f.workspaceRoot, f.makeView(rev1), f.projection, f.generation, {
          changedPaths: [updatedPath],
        }),
      ),
    );
    assert.deepEqual(single.result.result.dirtyPaths, []);
    assert.deepEqual(
      single.result.readPaths,
      [updatedPath],
      "10k-file single update must read only the 1 changed file",
    );
    assert.equal(single.hashCalls, 1, "10k-file single update must hash only the 1 changed file");
  } finally {
    rmSync(f.tmpRoot, { recursive: true, force: true });
  }
});
