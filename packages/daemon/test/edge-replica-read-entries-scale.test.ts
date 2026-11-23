// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sha256Bytes } from "@harness-anything/kernel";
import {
  activateEmptyCanonicalGeneration,
  makeTaskProjection,
  sqliteLedgerPath,
  startBaseBackup,
} from "@harness-anything/storage";
import { seedSettingsEvent } from "./repo-settings.fixture.ts";
import { writeFleetEdgeConfig, type FleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import { edgeReplicaDoctor } from "../src/daemon-host/edge-replica-doctor.ts";
import { readEdgeRepository, waitForMinimumCut, withEdgeReadModel } from "../src/daemon-host/fleet-edge-task-read.ts";
import {
  installReplicaGeneration,
  readReplicaGeneration,
  replicaGenerationReaders,
} from "../src/fleet-sync/fleet/replica-generation.ts";
import type { RepoCellBinding } from "../src/daemon-host/repo-cell-types.ts";
import { makeRepoReadRuntime } from "../src/daemon-host/repo-read-runtime.ts";
import { readEdgeRuntimeResult } from "../src/daemon-host/runtime-result-read.ts";
import { installCostProbe, resetCostProbe, snapshotCostProbe } from "./fixtures/g1-cost-probe.mjs";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

interface EdgeScaleFixture {
  readonly root: string;
  readonly userRoot: string;
  readonly viewRoot: string;
  readonly viewDir: string;
  readonly repoId: string;
  readonly nodeId: string;
  readonly workspaceRoot: string;
  readonly principalId: string;
  readonly config: FleetEdgeConfig;
  readonly runtimeResultRef: string;
  readonly taskDocPath: string;
}

const DOC_BODY = "# Scale notes\n";
const RUNTIME_RESULT_BODY = "runtime result payload";

async function makeFixture(documentCount: number): Promise<EdgeScaleFixture> {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-entries-scale-")),
    userRoot = path.join(root, "user"),
    repo = path.join(root, "repo"),
    repoId = "scale-repo",
    nodeId = "scale-node",
    principalId = "person-scale",
    viewRoot = path.join(root, "edge"),
    viewDir = path.join(viewRoot, "repos", repoId, "views", nodeId),
    taskDocPath = "context/notes.md";
  mkdirSync(path.join(repo, "harness/context"), { recursive: true });
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: scale\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(path.join(repo, "harness", taskDocPath), DOC_BODY);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Scale Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "scale@example.invalid"]);
  execFileSync("git", ["-C", repo, "add", "harness"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  activateEmptyCanonicalGeneration({ repoId, rootInput: repo });
  const eventStore = seedSettingsEvent({ repoId, rootDir: repo, keepOpen: true })!;
  const runtimeResultBytes = Buffer.from(RUNTIME_RESULT_BODY, "utf8");
  const runtimeResultSha = sha256Bytes(runtimeResultBytes);

  const projection = makeTaskProjection({
    rootDir: repo,
    eventStore,
  });
  projection.catchUp();
  const projectionPath = projection.path;
  projection.close();
  await eventStore.drain();

  const transfer = await startBaseBackup({
    ledgerPath: sqliteLedgerPath(repo),
    projectionPath,
    directory: path.join(root, "transfer"),
  });
  const archive = await transfer.complete;
  await installReplicaGeneration({
    root: viewDir,
    archive: archive.file,
    metadata: archive.metadata,
    sha256: archive.sha256,
    size: archive.size,
    quotaBytes: 64 * 1024 * 1024,
  });
  const generation = readReplicaGeneration(viewDir)!;
  const runtimeObjectDir = path.join(
    generation.rootDir,
    ".harness",
    "store",
    "generations",
    String(generation.metadata.ledgerGeneration),
    "objects",
    "sha256",
    runtimeResultSha.slice(0, 2),
  );
  mkdirSync(runtimeObjectDir, { recursive: true });
  writeFileSync(path.join(runtimeObjectDir, runtimeResultSha.slice(2)), runtimeResultBytes);
  const db = new DatabaseSync(generation.projectionPath);
  try {
    for (let index = 0; index < documentCount; index += 1) {
      const logicalPath = index === 0 ? taskDocPath : `tasks/unrelated/artifacts/doc-${index}.md`,
        body = Buffer.from(index === 0 ? DOC_BODY : `# document ${index}\n`, "utf8"),
        digest = sha256Bytes(body),
        objectDir = path.join(
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
        logicalPath,
        0,
        JSON.stringify({
          blobSha256: digest,
          size: body.length,
          mediaType: "text/markdown",
          policyId: "canonical-prose",
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
        readerProfile: { personId: principalId, nodeId },
      },
    }),
  );
  const config: FleetEdgeConfig = {
    schema: "fleet-edge-config/v1",
    repoId,
    host: "127.0.0.1",
    port: 0,
    caPath: path.join(root, "tls.crt"),
    nodeId,
    credential: "secret",
    viewRoot,
    quotaBytes: 64 * 1024 * 1024,
  };
  writeFleetEdgeConfig(userRoot, repoId, config);
  return {
    root,
    userRoot,
    viewRoot,
    viewDir,
    repoId,
    nodeId,
    workspaceRoot: repo,
    principalId,
    config,
    runtimeResultRef: `artifact:runtime-result/sha256/${runtimeResultSha}`,
    taskDocPath,
  };
}

function measureSqlRows(action: () => unknown): { readonly rows: number; readonly result: unknown } {
  resetCostProbe();
  const result = action();
  return { rows: snapshotCostProbe().sqlRowsRead, result };
}

test("non-entry edge replica reads do not scan mirror entries, while negative control and doc previews do", async (t) => {
  installCostProbe();
  const small = await makeFixture(2);
  const large = await makeFixture(80);
  t.after(() => {
    removeTempRepository(small.root);
    removeTempRepository(large.root);
  });

  const bindingFor = (fixture: EdgeScaleFixture): RepoCellBinding => ({
    actor: { principal: { personId: fixture.principalId }, executor: null },
    source: "local",
  });
  const openRuntime = (fixture: EdgeScaleFixture) =>
    makeRepoReadRuntime({
      repoId: fixture.repoId,
      rootDir: fixture.workspaceRoot,
      mode: "remote-edge",
      edgeConfig: () => fixture.config,
    });

  const smallRuntime = openRuntime(small);
  const largeRuntime = openRuntime(large);
  t.after(async () => {
    await smallRuntime.close();
    await largeRuntime.close();
  });

  const nonEntryReads: readonly {
    readonly name: string;
    readonly run: (fixture: EdgeScaleFixture, runtime: ReturnType<typeof makeRepoReadRuntime>) => unknown;
  }[] = [
    {
      name: "repo.tasks.list",
      run: (f, r) => r.read("repo.tasks.list", {}, bindingFor(f)),
    },
    {
      name: "repo.decisions.list",
      run: (f, r) => r.read("repo.decisions.list", {}, bindingFor(f)),
    },
    {
      name: "repo.workspace.summary.read",
      run: (f, r) => r.read("repo.workspace.summary.read", {}, bindingFor(f)),
    },
    {
      name: "repo.agentRuntime.events.read",
      run: (f, r) =>
        r.read(
          "repo.agentRuntime.events.read",
          { runtimeSessionId: "runtime-missing", afterCursor: "lifecycle:0" },
          bindingFor(f),
        ),
    },
    {
      name: "repo.task.read(task-list)",
      run: (f, r) => r.run({ kind: "task-list" }, bindingFor(f)),
    },
    {
      name: "repo.task.read(decision-list)",
      run: (f, r) => r.run({ kind: "decision-list" }, bindingFor(f)),
    },
    {
      name: "observe.tail(events)",
      run: (f, r) => r.observeTail({ kind: "events", direction: "history" }, undefined, bindingFor(f)),
    },
    {
      name: "explainBasis",
      run: (f, r) => r.explainBasis({}, bindingFor(f)),
    },
    {
      name: "readNodeAutoClaimAssignments",
      run: (f, r) => r.readNodeAutoClaimAssignments(bindingFor(f)),
    },
    {
      name: "edgeReplicaDoctor",
      run: (f) => edgeReplicaDoctor(f.workspaceRoot, f.repoId, undefined, f.userRoot),
    },
    {
      name: "readEdgeRuntimeResult",
      run: (f) => readEdgeRuntimeResult(f.viewRoot, f.repoId, f.nodeId, f.runtimeResultRef),
    },
  ];

  for (const probe of nonEntryReads) {
    const smallMeasure = measureSqlRows(() => probe.run(small, smallRuntime));
    const largeMeasure = measureSqlRows(() => probe.run(large, largeRuntime));
    const delta = largeMeasure.rows - smallMeasure.rows;
    t.diagnostic(
      JSON.stringify({
        read: probe.name,
        smallRows: smallMeasure.rows,
        largeRows: largeMeasure.rows,
        delta,
      }),
    );
    assert.ok(
      delta <= 2,
      `${probe.name} SQL row access grew with mirror document count (2 -> 80): ${smallMeasure.rows} -> ${largeMeasure.rows}`,
    );
  }

  assert.equal(
    readEdgeRuntimeResult(large.viewRoot, large.repoId, large.nodeId, large.runtimeResultRef),
    RUNTIME_RESULT_BODY,
  );
  assert.equal(edgeReplicaDoctor(large.workspaceRoot, large.repoId, undefined, large.userRoot).currentCut?.revision, 1);

  // Default withEdgeReadModel must not load mirror entries into view.entries.
  const defaultEntriesSmall = measureSqlRows(() =>
    withEdgeReadModel(
      { viewRoot: small.viewRoot, repoId: small.repoId, nodeId: small.nodeId, principalId: small.principalId },
      (_projection, _frame, view) => view.entries.size,
    ),
  );
  const defaultEntriesLarge = measureSqlRows(() =>
    withEdgeReadModel(
      { viewRoot: large.viewRoot, repoId: large.repoId, nodeId: large.nodeId, principalId: large.principalId },
      (_projection, _frame, view) => view.entries.size,
    ),
  );
  assert.equal(defaultEntriesSmall.result, 0);
  assert.equal(defaultEntriesLarge.result, 0);
  assert.ok(defaultEntriesLarge.rows - defaultEntriesSmall.rows <= 2);

  // readEdgeRepository & waitForMinimumCut must also avoid mirror-entry scans.
  resetCostProbe();
  await readEdgeRepository(
    {
      viewRoot: small.viewRoot,
      repoId: small.repoId,
      nodeId: small.nodeId,
      minCut: { revision: 1, headDigest: "" },
      action: { kind: "task-list" },
    },
    async () => undefined,
    async () => ({ outcome: "applied" }),
  );
  const repoReadSmall = snapshotCostProbe().sqlRowsRead;
  resetCostProbe();
  await readEdgeRepository(
    {
      viewRoot: large.viewRoot,
      repoId: large.repoId,
      nodeId: large.nodeId,
      minCut: { revision: 1, headDigest: "" },
      action: { kind: "task-list" },
    },
    async () => undefined,
    async () => ({ outcome: "applied" }),
  );
  const repoReadLarge = snapshotCostProbe().sqlRowsRead;
  assert.ok(repoReadLarge - repoReadSmall <= 2);
  assert.equal(
    await waitForMinimumCut({
      viewRoot: large.viewRoot,
      repoId: large.repoId,
      nodeId: large.nodeId,
      minCut: { revision: 1, headDigest: "" },
      action: { kind: "task-list" },
    }),
    true,
  );

  // Negative control: reverting includeEntries to true immediately fails the O(1) scan & empty-entries gate.
  const eagerSmall = measureSqlRows(() =>
    withEdgeReadModel(
      {
        viewRoot: small.viewRoot,
        repoId: small.repoId,
        nodeId: small.nodeId,
        principalId: small.principalId,
        includeEntries: true,
      },
      (_projection, _frame, view) => view.entries.size,
    ),
  );
  const eagerLarge = measureSqlRows(() =>
    withEdgeReadModel(
      {
        viewRoot: large.viewRoot,
        repoId: large.repoId,
        nodeId: large.nodeId,
        principalId: large.principalId,
        includeEntries: true,
      },
      (_projection, _frame, view) => view.entries.size,
    ),
  );
  assert.equal(eagerSmall.result, 3);
  assert.equal(eagerLarge.result, 81);
  assert.ok(
    eagerLarge.rows - eagerSmall.rows >= 78,
    `negative control expected O(N) scan with includeEntries:true, got ${eagerSmall.rows} -> ${eagerLarge.rows}`,
  );
  assert.throws(
    () => assert.ok(eagerLarge.rows - eagerSmall.rows <= 2),
    { name: "AssertionError" },
    "negative control: eager includeEntries:true must fail the O(1) mirror scan gate",
  );

  // Document workspace previews (doc-status / doc-dry-run) must still populate view.entries and behave identically.
  const docStatus = (await largeRuntime.run(
    { kind: "doc-status", paths: [large.taskDocPath] },
    bindingFor(large),
  )) as unknown as {
    readonly outcome: string;
    readonly evidence: string;
    readonly rows: readonly { path: string; state: string }[];
  };
  assert.equal(docStatus.outcome, "applied");
  const statusRows = (
    JSON.parse(docStatus.evidence.replace(/^doc-scan:/u, "")) as {
      readonly rows: readonly { path: string; state: string }[];
    }
  ).rows;
  assert.deepEqual(
    statusRows.map(({ path: p, state }) => [p, state]),
    [[large.taskDocPath, "clean"]],
  );
  assert.deepEqual(
    docStatus.rows.map(({ path: p, state }) => [p, state]),
    [[large.taskDocPath, "clean"]],
  );

  writeFileSync(path.join(large.workspaceRoot, "harness", large.taskDocPath), `${DOC_BODY}\nEdited locally.\n`);
  const docDryRun = (await largeRuntime.run(
    { kind: "doc-dry-run", paths: [large.taskDocPath] },
    bindingFor(large),
  )) as unknown as {
    readonly outcome: string;
    readonly evidence: string;
    readonly rows: readonly { path: string; state: string }[];
  };
  assert.equal(docDryRun.outcome, "applied");
  const dryRows = (
    JSON.parse(docDryRun.evidence.replace(/^doc-scan:/u, "")) as {
      readonly rows: readonly { path: string; state: string }[];
    }
  ).rows;
  assert.deepEqual(
    dryRows.map(({ path: p, state }) => [p, state]),
    [[large.taskDocPath, "eligible"]],
  );
  assert.deepEqual(
    docDryRun.rows.map(({ path: p, state }) => [p, state]),
    [[large.taskDocPath, "eligible"]],
  );

  // Close runtimes and confirm generation pins are cleanly released so old generations can be unlinked on Windows.
  await smallRuntime.close();
  await largeRuntime.close();
  const before = readReplicaGeneration(large.viewDir)!;
  const pointer = path.join(large.viewDir, "current.json");
  const next = { ...JSON.parse(readFileSync(pointer, "utf8")), id: "replacement-gen" };
  cpSync(before.rootDir, path.join(large.viewDir, "generations", next.id), { recursive: true });
  writeFileSync(pointer, JSON.stringify(next));
  replicaGenerationReaders(large.viewDir).collect();
  assert.equal(
    existsSync(before.rootDir),
    false,
    "superseded replica generation must be unlinked cleanly after edge reads complete",
  );
});
