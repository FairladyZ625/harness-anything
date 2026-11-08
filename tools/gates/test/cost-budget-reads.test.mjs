// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { combineReadShards } from "../cost-budget-read-lane.mjs";
import { planRowsRead } from "../../../packages/daemon/test/fixtures/g38-read-probe.mjs";
import {
  deriveReadInventory,
  evaluateReadCostScaling,
  BACKGROUND_READ_PATHS,
  evaluateReadMeasurements,
  validateReadCoverage,
  READ_BACKENDS,
  READ_DIMENSIONS,
  READ_MARGINS,
  readScalesFor,
  readScalesForProbe,
  measureReadCosts,
  readInventory,
  readProbeAppliesTo,
} from "../cost-budget-reads.mjs";

const inventory = [{ id: "method:repo.fixture.read" }],
  probes = { fixture: { reads: inventory.map(({ id }) => id) } };

test("G38 production read inventory has registered measurements for every protocol reader", async () => {
  const rootDir = path.resolve(import.meta.dirname, "../../.."),
    section = JSON.parse(readFileSync(path.join(rootDir, "tools/gates/cost-budget.json"), "utf8")).readCostScaling,
    { READ_PROBES } = await import("../../../packages/daemon/test/fixtures/g38-read-cost.mjs");
  validateReadCoverage(section, await readInventory(rootDir), READ_PROBES);
});
function fixture() {
  const section = {
    schema: "read-cost-scaling-budget/v1",
    readCoverage: { measured: { [inventory[0].id]: { measurements: ["fixture"] } }, notApplicable: [] },
    knownScaling: [],
  };
  const measured = Object.fromEntries(
    READ_BACKENDS.map((backend) => [
      backend,
      Object.fromEntries(
        READ_DIMENSIONS.map((dimension) => [
          dimension,
          {
            fixture: Object.fromEntries(
              Object.entries(readScalesFor(dimension)).map(([scale, size]) => [
                scale,
                {
                  size,
                  resultSize: 1,
                  counts: Object.fromEntries(Object.keys(READ_MARGINS).map((metric) => [metric, 0])),
                },
              ]),
            ),
          },
        ]),
      ),
    ]),
  );
  for (const backend of Object.values(measured))
    for (const dimension of Object.values(backend))
      for (const pair of Object.values(dimension))
        for (const value of Object.values(pair)) {
          value.firstResultSize = value.resultSize;
          value.firstCall = { ...value.counts };
        }
  return { section, inventory, probes, measured, now: new Date("2026-11-05T00:00:00Z") };
}
const exemption = {
  probe: "fixture",
  backend: "pglite",
  dimension: "runtime-sessions",
  metric: "sqlRowsRead",
  reason: "Pre-existing whole-class read",
  deletionTaskId: "task_fixture",
  expiresAt: "2026-11-12T00:00:00Z",
};

test("G38 derives read methods and multiplexed command reads from the protocol registration", () => {
  const input = {
    daemonProtocolCommands: [{ id: "first", commandClass: "repo-read", method: "repo.task.read" }],
    allDaemonProtocolMethods: [
      { method: "repo.task.read" },
      { method: "repo.gui.read", commandClass: "repo-read" },
      { method: "repo.write", commandClass: "repo-write" },
      { method: "host.registered-read" },
    ],
  };
  input.routes = [{ method: "host.registered-read", topology: { commandClass: "repo-read" } }];
  assert.deepEqual(
    deriveReadInventory(input).map(({ id }) => id),
    ["command:first", "method:host.registered-read", "method:repo.gui.read", "method:repo.task.read"],
  );
  const f = fixture();
  assert.throws(
    () => validateReadCoverage(f.section, [...inventory, { id: "method:repo.new.read" }], probes),
    /missing reads: method:repo.new.read/u,
  );
  assert.throws(
    () => validateReadCoverage(f.section, [...inventory, { id: "command:new-multiplexed-read" }], probes),
    /missing reads: command:new-multiplexed-read/u,
  );
});

test("G38 requires matching production probes and rejects blank or duplicate inapplicability", () => {
  const f = fixture();
  f.section.readCoverage.measured[inventory[0].id].measurements = ["not-a-probe"];
  assert.throws(() => validateReadCoverage(f.section, inventory, probes), /matching production measurement/u);
  f.section.readCoverage.measured = {};
  f.section.readCoverage.notApplicable = [{ reads: [inventory[0].id], reason: " " }];
  assert.throws(() => validateReadCoverage(f.section, inventory, {}), /reason is required/u);
  f.section.readCoverage.notApplicable[0].reason = "Only reads process configuration";
  assert.deepEqual(validateReadCoverage(f.section, inventory, {}), []);
  f.section.readCoverage.notApplicable.push(f.section.readCoverage.notApplicable[0]);
  assert.throws(() => validateReadCoverage(f.section, inventory, {}), /duplicates read/u);
});

test("G38 relation visibility applies only to the permission-aware PostgreSQL projection", async () => {
  const { READ_PROBES } = await import("../../../packages/daemon/test/fixtures/g38-read-cost.mjs"),
    probe = READ_PROBES["relation-page-low-visibility"];
  assert.equal(readProbeAppliesTo(probe, "pglite", "relation-visibility"), true);
  assert.equal(readProbeAppliesTo(probe, "sqlite", "relation-visibility"), false);
  assert.equal(readProbeAppliesTo(probe, "pglite", "relations"), false);
});

test("G38 judges the full backend × dimension × probe matrix without silently dropping a measurement", () => {
  const f = fixture();
  assert.equal(evaluateReadMeasurements(f).ok, true);
  delete f.measured.pglite.relations;
  assert.throws(() => evaluateReadMeasurements(f), /missing read measurement pglite\/relations/u);
});

test("G38 whole-class positive control is red with a fixed result k", (t) => {
  const f = fixture();
  f.measured.pglite["runtime-sessions"].fixture.small.counts.sqlRowsRead = 200;
  f.measured.pglite["runtime-sessions"].fixture.large.counts.sqlRowsRead = 2000;
  const result = evaluateReadMeasurements(f);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /200 at 200 grew to 2000 at 2000.*no knownScaling/u);
  t.diagnostic(result.errors.join("\n"));
});

test("G38 does not accept different result sizes as a history-independent read measurement", () => {
  const f = fixture();
  f.measured.sqlite.dispatches.fixture.large.resultSize = 2;
  assert.throws(() => evaluateReadMeasurements(f), /result size k changed/u);
});

test("G38 catches growing bytes even if SQL returns one row", () => {
  const f = fixture();
  f.measured.sqlite["event-bytes"].fixture.large.counts.sqlResultBytes = 2000;
  assert.equal(evaluateReadMeasurements(f).ok, false);
});

test("G38 exemptions bind an exact backend/dimension/metric and expire or become stale", () => {
  const f = fixture();
  f.measured.pglite["runtime-sessions"].fixture.large.counts.sqlRowsRead = 2000;
  f.section.knownScaling = [{ ...exemption }];
  assert.equal(evaluateReadMeasurements(f).ok, true);
  f.measured.sqlite["runtime-sessions"].fixture.large.counts.sqlRowsRead = 2000;
  assert.equal(evaluateReadMeasurements(f).ok, false);
  f.measured.sqlite["runtime-sessions"].fixture.large.counts.sqlRowsRead = 0;
  f.section.knownScaling[0].expiresAt = "2026-11-04T00:00:00Z";
  assert.match(evaluateReadMeasurements(f).errors.join("\n"), /expired/u);
  f.section.knownScaling[0] = { ...exemption };
  f.measured.pglite["runtime-sessions"].fixture.large.counts.sqlRowsRead = 0;
  assert.match(evaluateReadMeasurements(f).errors.join("\n"), /stale/u);
});

test("G38 rejects incomplete exemption provenance, duplicate exemptions and invalid counts", () => {
  for (const field of ["probe", "backend", "dimension", "metric", "reason", "deletionTaskId", "expiresAt"]) {
    const f = fixture();
    f.section.knownScaling = [{ ...exemption, [field]: "" }];
    assert.throws(() => evaluateReadMeasurements(f), /knownScaling/u, field);
  }
  const f = fixture();
  f.section.knownScaling = [exemption, exemption];
  assert.throws(() => evaluateReadMeasurements(f), /duplicate knownScaling/u);
  f.section.knownScaling = [];
  f.measured.sqlite.relations.fixture.small.counts.sqlRowsRead = -1;
  assert.throws(() => evaluateReadMeasurements(f), /invalid read measurement/u);
});

test("G38 bounds only the exact exempt probe and restores full scales when its exemption is removed", () => {
  const f = fixture();
  f.section.knownScaling = [{ ...exemption, measurementScales: { small: 5, large: 50 } }];
  const pair = f.measured.pglite["runtime-sessions"].fixture;
  pair.small.size = 5;
  pair.large.size = 50;
  pair.large.counts.sqlRowsRead = 45;
  assert.equal(evaluateReadMeasurements(f).ok, true);
  assert.deepEqual(readScalesForProbe(f.section, "fixture", "sqlite", "runtime-sessions"), { small: 200, large: 2000 });
  pair.large.counts.fileReadBytes = 1000;
  assert.match(evaluateReadMeasurements(f).errors.join("\n"), /fileReadBytes.*no knownScaling/u);
  f.section.knownScaling[0].expiresAt = "2026-11-04T00:00:00Z";
  assert.match(evaluateReadMeasurements(f).errors.join("\n"), /expired/u);
  f.section.knownScaling = [];
  assert.throws(() => evaluateReadMeasurements(f), /committed 10x scales/u);
});

test("G38 refuses inconsistent, non-10x and source-audit exemption bounds", () => {
  for (const measurementScales of [
    { small: 0, large: 0 },
    { small: 5, large: 25 },
    { small: 2000, large: 20000 },
  ]) {
    const f = fixture();
    f.section.knownScaling = [{ ...exemption, measurementScales }];
    assert.throws(() => evaluateReadMeasurements(f), /invalid knownScaling measurementScales/u);
  }
  const f = fixture();
  f.section.knownScaling = [
    { ...exemption, measurementScales: { small: 5, large: 50 } },
    { ...exemption, metric: "sqlResultBytes" },
  ];
  assert.throws(() => evaluateReadMeasurements(f), /inconsistent or invalid/u);
  f.section.knownScaling = [{ ...exemption, dimension: "source-events", measurementScales: { small: 5, large: 50 } }];
  assert.throws(() => readScalesForProbe(f.section, "fixture", "pglite", "source-events"), /invalid/u);
});

test("G38 measures bounded scans separately while keeping every other probe at full history", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-g38-scale-groups-"));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    delete globalThis.__g38FixtureOpens;
  });
  mkdirSync(path.join(rootDir, "packages/daemon/test/fixtures"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "packages/daemon/test/fixtures/g38-read-cost.mjs"),
    `globalThis.__g38FixtureOpens=[];
     export const READ_PROBES={bounded:{},regular:{}};
     export async function measureReadScale(backend,dimension,size,{probeIds}) {
       globalThis.__g38FixtureOpens.push(backend+"/"+dimension+"/"+size);
       return Object.fromEntries(probeIds.map(id=>[id,{size,resultSize:1}]));
     }`,
  );
  // 20/200 shares the 200 middle scale with the full 200/2000 pair, the shape
  // pglite/task-outputs uses (340/3400 vs 3400/34000): one fixture can serve both.
  const section = {
    knownScaling: [{ ...exemption, probe: "bounded", measurementScales: { small: 20, large: 200 } }],
  };
  const { measured } = await measureReadCosts(rootDir, {
    dimensions: ["runtime-sessions"],
    backends: ["sqlite", "pglite"],
    section,
  });
  for (const backend of READ_BACKENDS) {
    const pairs = measured[backend]["runtime-sessions"];
    assert.deepEqual([pairs.regular.small.size, pairs.regular.large.size], [200, 2000]);
    assert.deepEqual(
      [pairs.bounded.small.size, pairs.bounded.large.size],
      backend === "pglite" ? [20, 200] : [200, 2000],
    );
  }
  const opens = globalThis.__g38FixtureOpens;
  assert.equal(new Set(opens).size, opens.length, "each backend/dimension/size fixture is built once");
  assert.equal(opens.length, 5, "sqlite builds 200/2000 once; pglite builds 20/200/2000 once");
});

test("PG scan accounting sees rows hidden by aggregates, filters and repeated loops", () => {
  const plan = {
    "Node Type": "Aggregate",
    "Actual Rows": 1,
    Plans: [
      { "Node Type": "Seq Scan", "Actual Rows": 1, "Rows Removed by Filter": 1999, "Actual Loops": 1 },
      { "Node Type": "Index Scan", "Actual Rows": 2, "Rows Removed by Index Recheck": 1, "Actual Loops": 3 },
    ],
  };
  assert.equal(planRowsRead(plan), 2009);
  assert.equal(planRowsRead({ "Node Type": "Result", "Actual Rows": 1 }), 0);
  assert.equal(
    planRowsRead({ "Node Type": "Index Scan", "Actual Rows": 0.33, "Rows Removed by Filter": 0.66, "Actual Loops": 3 }),
    3,
  );
});

test("G38 rejects a cold scan even when the warm cache is flat", () => {
  const f = fixture();
  f.measured.sqlite["runtime-sessions"].fixture.large.firstCall.sqlRowsRead = 2000;
  assert.match(evaluateReadMeasurements(f).errors.join("\n"), /firstCall.*2000/u);
});

test("G38 source audits enforce linear input slope and an absolute per-input ceiling", () => {
  const f = fixture();
  f.probes = {
    fixture: {
      reads: probes.fixture.reads,
      sourceAudit: { maxPerInput: Object.fromEntries(Object.keys(READ_MARGINS).map((key) => [key, 10])) },
    },
  };
  for (const backend of READ_BACKENDS)
    for (const scale of ["small", "large"]) {
      const value = f.measured[backend]["source-events"].fixture[scale];
      value.inputSize = value.size;
      value.counts.sqlRowsRead = value.size * 2;
      value.firstCall.sqlRowsRead = value.size * 2;
    }
  assert.equal(evaluateReadMeasurements(f).ok, true);
  f.measured.pglite["source-events"].fixture.large.counts.sqlRowsRead = 5000;
  assert.match(evaluateReadMeasurements(f).errors.join("\n"), /source audit.*linear slope/u);
  f.measured.pglite["source-events"].fixture.small.counts.sqlRowsRead = 3000;
  f.measured.pglite["source-events"].fixture.large.counts.sqlRowsRead = 30000;
  assert.match(evaluateReadMeasurements(f).errors.join("\n"), /per-input ceiling/u);
});

test("G38 shard join rejects missing, duplicate and unknown backend/dimension slices", () => {
  const f = fixture();
  const shards = READ_BACKENDS.flatMap((backend) =>
    READ_DIMENSIONS.map((dimension) => ({
      schema: "g38-read-shard/v1",
      measured: { [backend]: { [dimension]: f.measured[backend][dimension] } },
    })),
  );
  assert.deepEqual(combineReadShards(shards), f.measured);
  assert.throws(() => combineReadShards(shards.slice(1)), /missing G38 shard/u);
  assert.throws(() => combineReadShards([...shards, shards[0]]), /duplicate G38 shard/u);
  assert.throws(
    () => combineReadShards([{ schema: "g38-read-shard/v1", measured: { other: {} } }]),
    /unknown G38 backend/u,
  );
});

test("G38 conditional summary accepts PGlite-only shards but still requires every PGlite dimension", () => {
  const f = fixture();
  const shards = READ_DIMENSIONS.map((dimension) => ({
    schema: "g38-read-shard/v1",
    measured: { pglite: { [dimension]: f.measured.pglite[dimension] } },
  }));
  const measured = combineReadShards(shards, ["pglite"]);
  assert.deepEqual(Object.keys(measured), ["pglite"]);
  assert.equal(evaluateReadMeasurements({ ...f, measured, backends: ["pglite"] }).ok, true);
  assert.throws(() => combineReadShards(shards.slice(1), ["pglite"]), /missing G38 shard pglite/u);
  assert.throws(() => combineReadShards(shards), /missing G38 shard sqlite/u);
});

test("G38 CI retains the legacy budget and joins every Node26 backend/collection shard", () => {
  const workflow = parse(readFileSync(new URL("../../../.github/workflows/rewrite-ci.yml", import.meta.url), "utf8"));
  const jobs = workflow.jobs;
  const reads = jobs["cost-budget-reads"],
    sqliteReads = jobs["cost-budget-reads-sqlite"],
    summary = jobs["cost-budget-read-summary"];
  const quick = jobs["quick-gates"];
  assert.ok(quick.steps.some((step) => step.env?.G38_PHASE === "legacy"));
  assert.deepEqual(reads.strategy.matrix.backend, ["pglite"]);
  assert.deepEqual(reads.strategy.matrix.dimension, [...READ_DIMENSIONS]);
  assert.equal(reads.strategy["fail-fast"], false);
  assert.ok(reads.steps.some((step) => step.with?.["node-version"] === 26));
  assert.ok(
    reads.steps.some((step) => step.run === "npm ci"),
    "Node26 read shards build their own native modules",
  );
  assert.ok(
    summary.steps.some((step) => step.with?.["node-version"] === 24),
    "The metadata-only join uses the matching shared dependency artifact",
  );
  assert.ok(
    reads.steps.some(
      (step) =>
        step.run === "node tools/gates/cost-budget.mjs" && step.env?.G38_PHASE === "read" && !step["continue-on-error"],
    ),
  );
  assert.deepEqual(sqliteReads.strategy.matrix.dimension, [...READ_DIMENSIONS]);
  assert.equal(sqliteReads.steps.find((step) => step.run === "npm ci") !== undefined, true);
  assert.ok(
    sqliteReads.steps.some(
      (step) => step.run === "node tools/gates/cost-budget.mjs" && step.env?.G38_BACKEND === "sqlite",
    ),
  );
  assert.ok(summary.needs.includes("cost-budget-reads"));
  assert.equal(
    summary.steps.find((step) => step.env?.G38_PHASE === "read-summary").env.G38_REQUIRED_BACKENDS,
    "${{ github.event_name == 'pull_request' && needs.install.outputs.costBudgetReads == 'false' && 'pglite' || 'pglite,sqlite' }}",
  );
  assert.ok(
    summary.steps.some(
      (step) =>
        step.run === "node tools/gates/cost-budget.mjs" &&
        step.env?.G38_PHASE === "read-summary" &&
        !step["continue-on-error"],
    ),
  );
  const manifest = JSON.parse(readFileSync(new URL("../../gate-manifest.json", import.meta.url), "utf8"));
  const gate = manifest.gates.find((entry) => entry.id === "cost-budget");
  for (const id of ["cost-budget-reads", "cost-budget-reads-sqlite", "cost-budget-read-summary"])
    assert.ok(gate.executionSurfaces.rewriteCi.pullRequestJobs.includes(id));
});

test("G38 entrypoint rejects a protocol registration without a measurement before opening a backend", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-g38-unregistered-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const relative of ["tools/gates", "packages/daemon/src/protocol", "packages/daemon/test/fixtures"])
    mkdirSync(path.join(rootDir, relative), { recursive: true });
  writeFileSync(
    path.join(rootDir, "packages/daemon/src/protocol/daemon-protocol-commands.ts"),
    'export const daemonProtocolCommands=[]; export const allDaemonProtocolMethods=[{method:"repo.new.read",commandClass:"repo-read"}];\n',
  );
  writeFileSync(
    path.join(rootDir, "packages/daemon/src/rpc-command-routing.ts"),
    "export const daemonRpcRoutingDeclarations=()=>[];\n",
  );
  writeFileSync(
    path.join(rootDir, "packages/daemon/test/fixtures/g38-read-cost.mjs"),
    'export const READ_PROBES={}; export const measureReadScale=()=>{throw new Error("backend must not open")};\n',
  );
  writeFileSync(
    path.join(rootDir, "tools/gates/cost-budget.json"),
    JSON.stringify({
      readCostScaling: {
        schema: "read-cost-scaling-budget/v1",
        knownScaling: [],
        readCoverage: {
          measured: {},
          notApplicable: [
            {
              reads: BACKGROUND_READ_PATHS.map((name) => `background:${name}`),
              reason: "Fixture declares no background reads",
            },
          ],
        },
      },
    }),
  );
  await assert.rejects(
    () => evaluateReadCostScaling({ rootDir, backends: ["sqlite"] }),
    /readCoverage is missing reads: method:repo.new.read/u,
  );
});
