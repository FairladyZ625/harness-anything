// harness-test-tier: contract
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeTest from "node:test";
import { testOrdinalInPartition } from "../../node-test-runner-lib.mjs";
import { auditDurableActionAuthorization, loadAuthorizationInputs } from "../ontology-durable-action-authorization.mjs";
import { replaceSourceOnce, runGit } from "./helpers.mjs";
import { scanOntologyText } from "../ontology-closure-scan.mjs";
import { buildFlowGraph } from "../authorization-flow-graph.mjs";
import { sourceWitnesses, technicalPortEvidence } from "../authorization-source-proof.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const inputs = await loadAuthorizationInputs(repoRoot);

// Whole-file execution exceeded the isolated runner's time budget. Preserve every case
// and use the same bounded partitions as the other real-source authorization consumers.
let testOrdinal = 0;
function partitionedTest(name, fn) {
  if (testOrdinalInPartition(testOrdinal++, process.env.HARNESS_TEST_PARTITION)) nodeTest(name, fn);
}
const test = partitionedTest;

function sourceCopy(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "daemon-source-authority-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "packages"));
  for (const entry of readdirSync(path.join(repoRoot, "packages"))) {
    const target = path.join(dir, "packages", entry);
    if (["daemon", "authorization-keycloak", "application"].includes(entry)) {
      cpSync(path.join(repoRoot, "packages", entry, "src"), path.join(target, "src"), { recursive: true });
      cpSync(path.join(repoRoot, "packages", entry, "package.json"), path.join(target, "package.json"));
    } else symlinkSync(path.join(repoRoot, "packages", entry), target, "dir");
  }
  // Native entries are shared across owners; include every upstream-declared daemon script.
  cpSync(path.join(repoRoot, "packages/daemon/scripts"), path.join(dir, "packages/daemon/scripts"), {
    recursive: true,
  });
  cpSync(
    path.join(repoRoot, "packages/daemon/tsconfig.build.json"),
    path.join(dir, "packages/daemon/tsconfig.build.json"),
  );
  symlinkSync(path.join(repoRoot, "tools"), path.join(dir, "tools"), "dir");
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
  runGit(dir, ["init", "--quiet"]);
  runGit(dir, ["config", "core.excludesFile", "/dev/null"]);
  return dir;
}

function audit(sourceRoot = repoRoot) {
  return auditDurableActionAuthorization(repoRoot, inputs, { sourceRoot, only: ["todo-add"] });
}

const todoSource = inputs.constants.actionDeclarations
  .find((action) => action.kind === "todo-add")
  .ontology.sources.find((source) => source.role === "effect").candidateId;

// dec_7E44897ECDCAEF2B92EC66A260/CH1: the route's decision must reach the effect registered
// by ActionDeclaration, including a catalog runtime handed through a computed callback.
test("todo-add authorization reaches its registered catalog runtime source", () => {
  const result = audit();
  assert.deepEqual(result.findings, [], JSON.stringify(result.sourceRows.find((source) => source.id === todoSource)));
  assert.equal(result.sourceRows.find((source) => source.id === todoSource)?.ok, true);
});

test("removing the todo catalog callback leaves its registered effect unproven", (t) => {
  const dir = sourceCopy(t),
    file = "packages/daemon/src/daemon-host/repo-cell-action-dispatch.ts",
    pathName = path.join(dir, file),
    text = readFileSync(pathName, "utf8"),
    callback = "{ entity: { todo: (_contract, intent, actor, opId) => runTodoAction(cell, intent, actor, opId) } },";
  writeFileSync(pathName, replaceSourceOnce(text, callback, "{}", file));
  const result = audit(dir);
  assert.equal(result.rows.find((row) => row.id === "todo-add")?.ok, true);
  assert.equal(result.sourceRows.find((source) => source.id === todoSource)?.ok, false);
  assert.ok(result.findings.some((finding) => finding.includes(todoSource)));
});

// CH1: a target-limited cache for one bin must cover every action using that bin.
test("a native entry cache covers both owners and rejects a detached registered source", (t) => {
  const dir = sourceCopy(t);
  const file = "packages/daemon/src/native-source-proof.ts";
  const text = `import { writeFileSync } from "node:fs";
function first() { writeFileSync("/tmp/native-proof-first", "first"); }
function second() { writeFileSync("/tmp/native-proof-second", "second"); }
first();
second();
`;
  writeFileSync(path.join(dir, file), text);
  const packageFile = path.join(dir, "packages/daemon/package.json");
  const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
  manifest.bin["native-source-proof"] = "dist/native-source-proof.js";
  writeFileSync(packageFile, JSON.stringify(manifest));
  writeFileSync(
    path.join(dir, "packages/daemon/tsconfig.build.json"),
    JSON.stringify({
      compilerOptions: { rootDir: "src", outDir: "dist" },
      include: ["src/**/*.ts"],
    }),
  );
  const sources = scanOntologyText(file, text).filter(
    (row) => row.category === "action" && row.name === "writeFileSync",
  );
  assert.equal(sources.length, 2);
  const actions = sources.map((source, index) => ({
    kind: `native-source-${index}`,
    executionClass: "admin",
    residency: { scope: "host-local", writer: "caller-process" },
    receiptSettlement: "none",
    ontology: {
      authority: "local-process",
      owner: "daemon",
      entries: { "native:bin": { file, bin: "native-source-proof" } },
      sources: [{ candidateId: source.id, route: "native:bin", role: "effect" }],
    },
  }));
  const nativeInputs = { ...inputs, descriptors: [], constants: { ...inputs.constants, actionDeclarations: actions } };
  const run = () => auditDurableActionAuthorization(repoRoot, nativeInputs, { sourceRoot: dir });
  assert.deepEqual(run().findings, []);
  writeFileSync(path.join(dir, file), replaceSourceOnce(text, "second();", "void 0;", file));
  const rejected = run();
  assert.equal(rejected.sourceRows.find((row) => row.id === sources[0].id)?.ok, true);
  assert.equal(rejected.sourceRows.find((row) => row.id === sources[1].id)?.ok, false);
  assert.ok(rejected.findings.some((finding) => finding.includes(sources[1].id)));
});

// CH1: a detached owner route cannot borrow its implementation's reachable source.
test("a missing queued owner decision leaves its declared effect unproven", (t) => {
  const dir = sourceCopy(t),
    file = "packages/daemon/src/daemon-host/repo-cell-command-run.ts",
    target = path.join(dir, file),
    original = readFileSync(target, "utf8");
  writeFileSync(
    target,
    replaceSourceOnce(
      original,
      "queuedDecision = await authorizeAtCurrentCut()!;",
      "queuedDecision = undefined!;",
      file,
    ),
  );
  const result = audit(dir);
  assert.equal(result.rows.find((row) => row.id === "todo-add")?.ok, false);
  assert.equal(result.sourceRows.find((row) => row.id === todoSource)?.ok, false);
  assert.ok(result.findings.some((finding) => finding.includes(todoSource)));
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: local maintenance ports prove their actual
// implementation declaration; they cannot borrow a different port or a canonical business owner.
test("local maintenance sources require exact technical ports and cannot claim a canonical owner", () => {
  const local = inputs.constants.actionDeclarations.find((action) => action.kind === "daemon-local-state");
  const run = (action, binding) =>
    auditDurableActionAuthorization(
      repoRoot,
      {
        ...inputs,
        constants: {
          ...inputs.constants,
          actionDeclarations: inputs.constants.actionDeclarations.map((row) =>
            row.kind === action.kind ? { ...action, ontology: { ...action.ontology, sources: [binding] } } : row,
          ),
        },
      },
      { only: [action.kind] },
    );
  const canonical = inputs.constants.actionDeclarations.find((action) => action.kind === "task-transition");
  for (const symbol of [
    "decision-annotations.ts#openDecisionAnnotationStore.export:",
    "squad-coordinator-publication.ts#makeSquadPublicationController.publishState:",
    "squad-coordinator.ts#makeSquadCoordinator.continueLeader:",
    "squad-run-state.ts#cancelRejectedSquadChildren:",
  ]) {
    const source = local.ontology.sources.find((row) => row.candidateId.includes(symbol));
    assert.ok(source, symbol);
    assert.equal(source.role, "technical-port");
    assert.equal(run(local, source).sourceRows[0].ok, true, symbol);
    const wrongPort = source.port.endsWith(".enqueue")
      ? source.port.replace(".enqueue", ".write")
      : "packages/daemon/src/daemon-host/runtime-spawner.ts#makeRuntimeSpawner.spawn";
    assert.equal(run(local, { ...source, port: wrongPort }).sourceRows[0].ok, false, symbol);
    assert.equal(run(canonical, { ...source, route: canonical.kind }).sourceRows[0].ok, false, symbol);
  }
});

// CH1: OS credential lookup is a local typed driver; the RuntimeSession event still needs
// the runtime-run owner's canonical decision, including re-entry with an internal action frame.
test("local credential lookup cannot authorize the RuntimeSession append", () => {
  const kinds = ["runtime-run", "daemon-local-state"],
    sessionSource = inputs.constants.actionDeclarations
      .find((action) => action.kind === "runtime-run")
      .ontology.sources.find((source) =>
        source.candidateId.includes("entity-action-runtime-session.ts#commitRuntimeSessionBundle.appended:"),
      ),
    lookupSource = inputs.constants.actionDeclarations
      .find((action) => action.kind === "daemon-local-state")
      .ontology.sources.find((source) =>
        source.candidateId.includes("agent-runtime-credential-port.ts#credentialPort.resolve:"),
      );
  assert.equal(sessionSource.role, "effect");
  assert.equal(lookupSource.role, "technical-port");
  const accepted = auditDurableActionAuthorization(repoRoot, inputs, { only: kinds });
  assert.deepEqual(accepted.findings, []);
  assert.equal(accepted.sourceRows.find((row) => row.id === sessionSource.candidateId)?.ok, true);
  assert.equal(accepted.sourceRows.find((row) => row.id === lookupSource.candidateId)?.authority, "technical-port");
  // A lookup certificate must not transfer to a different physical call, even when
  // both source identities are registered and the real runtime owner is authorized.
  const borrowed = auditDurableActionAuthorization(
    repoRoot,
    {
      ...inputs,
      constants: {
        ...inputs.constants,
        actionDeclarations: inputs.constants.actionDeclarations.map((action) =>
          action.kind === "daemon-local-state"
            ? {
                ...action,
                ontology: {
                  ...action.ontology,
                  sources: [lookupSource, { ...lookupSource, candidateId: sessionSource.candidateId }],
                },
              }
            : action,
        ),
      },
    },
    { only: ["daemon-local-state"] },
  );
  assert.equal(borrowed.sourceRows.find((row) => row.id === sessionSource.candidateId)?.ok, false);
  assert.equal(borrowed.sourceRows.find((row) => row.id === lookupSource.candidateId)?.ok, true);
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: exact source ownership belongs beside real authority controls.
test("daemon source declarations preserve actual driver and business owners", () => {
  const sourceById = new Map(
    inputs.constants.actionDeclarations.flatMap(({ kind, ontology }) =>
      (ontology?.sources ?? []).map((source) => [source.candidateId, { kind, ...source }]),
    ),
  );
  for (const [candidateId, kind, route, role, port] of [
    [
      "action:packages/daemon:packages/daemon/src/daemon-host/squad-coordinator-publication.ts#makeSquadPublicationController.publishState:ea198c0ae8e28c5df56304a635c8ee6b",
      "daemon-local-state",
      "daemon-local-state",
      "technical-port",
      "packages/daemon/src/daemon-host/squad-coordinator-publication.ts#makeSquadPublicationController.input.runtimeSpawner.cancel",
    ],
    [
      "action:packages/daemon:packages/daemon/src/daemon-host/squad-coordinator.ts#makeSquadCoordinator.continueLeader:38b1bb3e40bdc47cc1a7037af6cda8e2",
      "daemon-local-state",
      "daemon-local-state",
      "technical-port",
      "packages/daemon/src/daemon-host/squad-coordinator.ts#makeSquadCoordinator.cancel",
    ],
    [
      "action:packages/daemon:packages/daemon/src/daemon-host/squad-run-state.ts#cancelRejectedSquadChildren:f2d2fea1c2a61b39b32d718b5ad786f1",
      "daemon-local-state",
      "daemon-local-state",
      "technical-port",
      "packages/daemon/src/daemon-host/squad-run-state.ts#SquadOrphanCancellation.cancel",
    ],
    [
      "action:packages/daemon:packages/daemon/src/daemon-host/task-review-dispatch.ts#dispatchDecisionReview.spawned:924e97bd48641448595ff43500f7824d",
      "decision-dispatch-review",
      "decision-dispatch-review",
      "effect",
    ],
    [
      "action:packages/daemon:packages/daemon/src/daemon-host/schedule-scheduler.ts#makeScheduleScheduler.tick:03f7df144e0da4b8d8de43d116dd75a0",
      "daemon-local-state",
      "daemon-local-state",
      "technical-port",
      "packages/daemon/src/daemon-host/schedule-scheduler.ts#ScheduleTarget.execute",
    ],
    [
      "action:packages/daemon:packages/daemon/src/daemon-host/schedule-scheduler.ts#makeScheduleScheduler.targetFor.execute:fedd751c9cee14e8e02fbafe0cb48ac1",
      "daemon-local-state",
      "daemon-local-state",
      "technical-port",
      "packages/daemon/src/daemon-host/repo-cell-types.ts#RepoCell.run",
    ],
    [
      "action:packages/daemon:packages/daemon/src/daemon-host/decision-point-executor.ts#openDecisionPointExecutor.settle.apply:79a44954c303732a0c96fdbd6afe2c74",
      "daemon-local-state",
      "daemon-local-state",
      "technical-port",
      "packages/daemon/src/daemon-host/decision-point-executor.ts#openDecisionPointExecutor.settle",
    ],
    [
      "action:packages/application:packages/application/src/commands/fact-archive-document.ts#archiveAllFacts:f62e63de0d5257051d2b5b71ac126b0d",
      "fact-archive",
      "fact-archive",
      "effect",
    ],
    [
      "action:packages/application:packages/application/src/commands/entity-action-catalog-executor.ts#makeEntityActionCatalogExecutor.repinAll:f62e63de0d5257051d2b5b71ac126b0d",
      "decision-repin",
      "decision-repin",
      "effect",
    ],
    [
      "action:packages/application:packages/application/src/commands/task-witness-action.ts#runTaskWitnessAction.appended:45d7f1624d843b4db4ce2ba40a15919d",
      "task-witness-rerun",
      "task-witness-rerun",
      "effect",
    ],
    [
      "action:packages/daemon:packages/daemon/src/daemon-host/task-return-dispatch.ts#cancelSubmittingWorker:7e5c4e3cbedb7ebe77094b9412b7f1fc",
      "daemon-local-state",
      "daemon-local-state",
      "technical-port",
      "packages/daemon/src/daemon-host/runtime-spawner.ts#makeRuntimeSpawner.cancel",
    ],
    [
      "action:packages/daemon:packages/daemon/src/daemon-host/task-review-dispatch.ts#spawnCutReviewDispatch.prepareAndLaunch:9030b04c8201332d5d65d14f2b188188",
      "daemon-local-state",
      "daemon-local-state",
      "technical-port",
      "packages/daemon/src/daemon-host/runtime-spawner.ts#makeRuntimeSpawner.spawn",
    ],
    [
      "action:packages/daemon:packages/daemon/src/daemon-host/repo-cell-open.ts#openRepoWriterCell.runtimeSpawner.onStalledReviewer.receipt:af1ef00d694c4f9a1c4bf9b3fece145f",
      "daemon-local-state",
      "daemon-local-state",
      "technical-port",
      "packages/daemon/src/daemon-host/repo-cell-types.ts#RepoCell.run",
    ],
    [
      "action:packages/daemon:packages/daemon/src/daemon-host/schedule-action-runtime.ts#settleScheduledRuntime:779d3e75837bcb7e247b063079c97d14",
      "daemon-local-state",
      "daemon-local-state",
      "technical-port",
      "packages/daemon/src/daemon-host/schedule-action-runtime.ts#settleScheduledRuntime.run",
    ],
    [
      "action:packages/daemon:packages/daemon/src/daemon-host/schedule-action-runtime.ts#settleScheduledRuntime.receipt:8e4e1b9e6fd99e7638e92e7c9796f069",
      "daemon-local-state",
      "daemon-local-state",
      "technical-port",
      "packages/daemon/src/daemon-host/schedule-action-runtime.ts#settleScheduledRuntime.run",
    ],
  ]) {
    assert.deepEqual(
      sourceById.get(candidateId),
      { candidateId, kind, route, role, ...(port ? { port } : {}) },
      candidateId,
    );
  }
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: queue/automatic drivers cannot borrow rework authority.
test("return continuation queue and automatic spawner use their actual technical ports", () => {
  const local = inputs.constants.actionDeclarations.find((action) => action.kind === "daemon-local-state");
  const canonical = inputs.constants.actionDeclarations.find((action) => action.kind === "task-rework");
  const rows = [
    [
      "dispatchContinuation.completed:48dbce6d60b54b29628f5a708899f3eb",
      "packages/daemon/src/daemon-host/repo-cell-types.ts#RepoCellContinuationWrite",
    ],
    [
      "dispatchContinuation.spawned:0945e48785ee4398118a84514b3a6fbf",
      "packages/daemon/src/daemon-host/repo-cell-types.ts#RepoCellContinuationWrite",
    ],
    [
      "dispatchContinuation.spawned:004f209ef618210157675205bc97597d",
      "packages/daemon/src/daemon-host/runtime-spawner.ts#makeRuntimeSpawner.spawn",
    ],
  ];
  const sources = rows.map(([suffix, port]) => {
    const source = local.ontology.sources.find((source) => source.candidateId.endsWith(suffix));
    assert.ok(source, suffix);
    assert.equal(source.route, local.kind);
    assert.equal(source.role, "technical-port");
    assert.equal(source.port, port);
    return source;
  });
  const graph = buildFlowGraph(repoRoot);
  const witnesses = sourceWitnesses(graph, sources);
  for (const source of sources) {
    const node = witnesses.get(source.candidateId);
    assert.ok(node, source.candidateId);
    assert.ok(technicalPortEvidence(graph, node, source, local, inputs.descriptors), source.candidateId);
    assert.equal(
      technicalPortEvidence(
        graph,
        node,
        { ...source, port: "packages/daemon/src/daemon-host/runtime-spawner.ts#makeRuntimeSpawner.cancel" },
        local,
        inputs.descriptors,
      ),
      null,
    );
    assert.equal(
      technicalPortEvidence(graph, node, { ...source, route: canonical.kind }, canonical, inputs.descriptors),
      null,
    );
  }
  const transition = inputs.constants.actionDeclarations.find((action) => action.kind === "task-transition");
  const serviceSource = transition.ontology.sources.find((source) =>
    source.candidateId.includes("runTaskActionCatalogRuntime:"),
  );
  assert.equal(serviceSource?.role, "effect", "the actual canonical service execution retains its business owner");
});

// dec_7E44897ECDCAEF2B92EC66A260/CH1: the collector supplies its own publisher.
// Its unreachable ambient fallback cannot challenge the queued witness source.
const witnessSource = inputs.constants.actionDeclarations
  .find((action) => action.kind === "task-witness-rerun")
  .ontology.sources.find((source) => source.role === "effect").candidateId;
test("the witness collector supplied port preserves its registered queued authority", () => {
  const result = auditDurableActionAuthorization(repoRoot, inputs, { only: ["task-witness-rerun"] });
  assert.deepEqual(result.findings, [], JSON.stringify(result.sourceRows));
  assert.equal(result.sourceRows.find((source) => source.id === witnessSource)?.ok, true);
});
test("a detached witness catalog callback cannot borrow the collector publisher", (t) => {
  const dir = sourceCopy(t),
    file = "packages/daemon/src/daemon-host/repo-cell-action-dispatch.ts";
  const target = path.join(dir, file),
    text = readFileSync(target, "utf8");
  writeFileSync(
    target,
    replaceSourceOnce(
      text,
      "return runTaskWitnessAction(cell, catalogAction, catalogBinding);",
      'return {outcome: "no_changes", opId: "detached-witness"};',
      file,
    ),
  );
  const result = auditDurableActionAuthorization(repoRoot, inputs, { sourceRoot: dir, only: ["task-witness-rerun"] });
  assert.equal(result.rows.find((row) => row.id === "task-witness-rerun")?.ok, true);
  assert.equal(result.sourceRows.find((source) => source.id === witnessSource)?.ok, false);
  assert.ok(result.findings.some((finding) => finding.includes(witnessSource)));
});

test("manual task review reaches the authorized launch after preparing outside the writer", () => {
  const result = auditDurableActionAuthorization(repoRoot, inputs, { only: ["task-dispatch-review"] });
  assert.deepEqual(result.findings, []);
  assert.equal(result.rows.find(({ id }) => id === "task-dispatch-review")?.ok, true);
  assert.equal(result.sourceRows.find(({ kind }) => kind === "task-dispatch-review")?.ok, true);
});
