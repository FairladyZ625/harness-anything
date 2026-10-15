// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

interface Fixture {
  readonly root: string;
  readonly viewRoot: string;
  readonly repoId: string;
  readonly nodeId: string;
  readonly workspaceRoot: string;
}

async function makeFixture(documentCount: number): Promise<Fixture> {
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
      db.prepare("INSERT INTO document (path, workspace_revision, value_json) VALUES (?, ?, ?)").run(
        `tasks/task-scale/artifacts/doc-${index}.md`,
        0,
        JSON.stringify({ blobSha256: digest, size: body.length, mediaType: "text/markdown" }),
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
