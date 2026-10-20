// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateEmptyCanonicalGeneration,
  makeTaskProjection,
  openSqliteEventStore,
  sha256Bytes,
  sqliteLedgerPath,
} from "@harness-anything/kernel";
import { installCostProbe, resetCostProbe, snapshotCostProbe } from "./fixtures/g1-cost-probe.mjs";
import { startBaseBackup } from "../src/fleet/basebackup.ts";
import { installReplicaGeneration, readReplicaGeneration } from "../src/fleet/replica-generation.ts";
import { readEdgeRuntimeRepository } from "../src/fleet-edge-runtime-read.ts";
import {
  applyFleetMirrorCut,
  fleetMirrorTaskPaths,
  locateFleetMirrorView,
  scanFleetMirrorWorktree,
} from "../src/fleet-edge-mirror.ts";

interface Fixture {
  readonly root: string;
  readonly viewRoot: string;
  readonly repoId: string;
  readonly nodeId: string;
  readonly workspaceRoot: string;
}

async function makeFixture(documentCount: number, packageLookup = false): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-runtime-scale-")),
    repo = path.join(root, "repo"),
    repoId = "scale-repo",
    nodeId = "scale-node",
    viewRoot = path.join(root, "edge"),
    viewDir = path.join(viewRoot, "repos", repoId, "views", nodeId);
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: scale\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Scale Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "scale@example.invalid"]);
  execFileSync("git", ["-C", repo, "add", "harness"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  activateEmptyCanonicalGeneration({ repoId, rootInput: repo });
  const ledger = openSqliteEventStore({ repoId, rootInput: repo });
  ledger.close();
  const projection = makeTaskProjection({
    rootDir: repo,
    eventStore: {
      readHead: () => null,
      readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }),
      readContentBlob: () => null,
    },
  });
  projection.catchUp();
  const projectionPath = projection.path;
  projection.close();
  const transfer = await startBaseBackup({
      ledgerPath: sqliteLedgerPath(repo),
      projectionPath,
      directory: path.join(root, "transfer"),
    }),
    archive = await transfer.complete;
  await installReplicaGeneration({
    root: viewDir,
    archive: archive.file,
    metadata: archive.metadata,
    sha256: archive.sha256,
    size: archive.size,
    quotaBytes: 64 * 1024 * 1024,
  });
  const generation = readReplicaGeneration(viewDir)!;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(generation.projectionPath);
  try {
    for (let index = 0; index < documentCount; index += 1) {
      const body = Buffer.from(`# document ${index}\n`),
        digest = sha256Bytes(body);
      const objectDir = path.join(
        generation.rootDir,
        ".harness",
        "store",
        "generations",
        String(generation.metadata.ledgerGeneration),
        "objects",
        "sha256",
        digest.slice(0, 2),
      );
      mkdirSync(objectDir, { recursive: true });
      writeFileSync(path.join(objectDir, digest.slice(2)), body);
      const logicalPath = packageLookup
        ? index === 0
          ? "tasks/task-scale/INDEX.md"
          : `tasks/unrelated/artifacts/doc-${index}.md`
        : `tasks/task-scale/artifacts/doc-${index}.md`;
      db.prepare("INSERT INTO document (path, workspace_revision, value_json) VALUES (?, ?, ?)").run(
        logicalPath,
        0,
        JSON.stringify({
          blobSha256: digest,
          size: body.length,
          mediaType: "text/markdown",
        }),
      );
    }
  } finally {
    db.close();
  }
  writeFileSync(
    path.join(viewDir, "current.json"),
    JSON.stringify({
      id: generation.id,
      metadata: {
        ...generation.metadata,
        readerProfile: { personId: "person-scale", nodeId },
      },
    }),
  );
  return { root, viewRoot, repoId, nodeId, workspaceRoot: repo };
}

function readPackageRows(fixture: Fixture): { readonly rows: number; readonly paths: readonly string[] } {
  resetCostProbe();
  const view = locateFleetMirrorView(fixture.viewRoot, fixture.repoId, fixture.nodeId, {
    entriesPrefix: "tasks/task-scale",
  });
  assert.ok(view);
  return { rows: snapshotCostProbe().sqlRowsRead, paths: fleetMirrorTaskPaths(view, "task-scale") };
}

function readRows(fixture: Fixture): number {
  resetCostProbe();
  readEdgeRuntimeRepository(
    {
      viewRoot: fixture.viewRoot,
      repoId: fixture.repoId,
      nodeId: fixture.nodeId,
      workspaceRoot: fixture.workspaceRoot,
      principalId: "person-scale",
    },
    "repo.tasks.runtimeContext.read",
    { taskId: "task-scale" },
  );
  return snapshotCostProbe().sqlRowsRead;
}

test("edge runtime task reads keep SQL row access independent of mirror document count", async (t) => {
  installCostProbe();
  const small = await makeFixture(2);
  const large = await makeFixture(20);
  t.after(() => {
    rmSync(small.root, { recursive: true, force: true });
    rmSync(large.root, { recursive: true, force: true });
  });
  const smallRows = readRows(small);
  const largeRows = readRows(large);
  t.diagnostic(JSON.stringify({ smallDocuments: 2, largeDocuments: 20, smallRows, largeRows }));
  assert.ok(largeRows - smallRows <= 2, `row access grew with mirror size: ${smallRows} -> ${largeRows}`);
});

test("dispatched task-package lookup keeps SQL row access independent of unrelated documents", async (t) => {
  installCostProbe();
  const small = await makeFixture(2, true);
  const large = await makeFixture(20, true);
  t.after(() => {
    rmSync(small.root, { recursive: true, force: true });
    rmSync(large.root, { recursive: true, force: true });
  });
  const smallRead = readPackageRows(small);
  const largeRead = readPackageRows(large);
  t.diagnostic(
    JSON.stringify({
      smallDocuments: 2,
      largeDocuments: 20,
      smallRows: smallRead.rows,
      largeRows: largeRead.rows,
      smallPaths: smallRead.paths,
      largePaths: largeRead.paths,
    }),
  );
  assert.deepEqual(smallRead.paths, ["tasks/task-scale/INDEX.md"]);
  assert.deepEqual(largeRead.paths, smallRead.paths);
  assert.ok(
    largeRead.rows - smallRead.rows <= 2,
    `package lookup grew with unrelated documents: ${smallRead.rows} -> ${largeRead.rows}`,
  );
});

test("legacy materialization marker without a base does not classify center differences as local edits", async (t) => {
  const fixture = await makeFixture(1);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const localPath = path.join(fixture.workspaceRoot, "harness/tasks/task-scale/artifacts/doc-0.md");
  mkdirSync(path.dirname(localPath), { recursive: true });
  writeFileSync(localPath, "legacy local bytes\n");
  const localOnlyPath = path.join(fixture.workspaceRoot, "harness/tasks/task-scale/artifacts/local-only.md");
  writeFileSync(localOnlyPath, "edge-only bytes\n");
  mkdirSync(path.join(fixture.workspaceRoot, ".harness"), { recursive: true });
  writeFileSync(path.join(fixture.workspaceRoot, ".harness/fleet-materialized.json"), JSON.stringify({ revision: 1 }));
  const view = locateFleetMirrorView(fixture.viewRoot, fixture.repoId, fixture.nodeId);
  assert.ok(view);
  const scan = scanFleetMirrorWorktree(view, fixture.workspaceRoot);
  t.diagnostic(
    JSON.stringify({ changes: scan.changes.map(({ path: logical }) => logical), cleanPaths: scan.cleanPaths }),
  );
  assert.deepEqual(
    scan.changes.map(({ path: logical }) => logical),
    ["tasks/task-scale/artifacts/local-only.md"],
  );
  assert.deepEqual(scan.cleanPaths, ["tasks/task-scale/artifacts/doc-0.md"]);
  const applied = applyFleetMirrorCut(fixture.viewRoot, fixture.repoId, fixture.workspaceRoot, "pull");
  assert.deepEqual(applied.dirtyPaths, []);
  assert.equal(readFileSync(localPath, "utf8"), "# document 0\n");
});

test("an unmarked worktree does not report unmaterialized center documents as deletions", async (t) => {
  const fixture = await makeFixture(1);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const view = locateFleetMirrorView(fixture.viewRoot, fixture.repoId, fixture.nodeId);
  assert.ok(view);
  const scan = scanFleetMirrorWorktree(view, fixture.workspaceRoot);
  assert.deepEqual(scan.deletedPaths, []);
});
