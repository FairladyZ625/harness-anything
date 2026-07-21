// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LOCAL_EQUIVALENCE_NOTICE,
  buildCiJobInvocation,
  buildCiPlan,
  createReceipt,
  formatSummary,
  parseIntegrationShardMatrix,
  runCiPlan
} from "./run-ci-equivalent.mjs";
import { resolveShardParallelism } from "./shard-parallelism.mjs";

test("check:ci applies the shared QoS prefix to each manifest job", () => {
  assert.deepEqual(buildCiJobInvocation(["taskpolicy", "-c", "utility"], ["tools/run-manifest-gates.mjs"]), {
    command: "taskpolicy",
    args: ["-c", "utility", process.execPath, "tools/run-manifest-gates.mjs"]
  });
});

test("CI-equivalent plan follows a seven-shard workflow authority fixture", () => {
  const result = buildCiPlan(makeManifest(), makeWorkflow(7));

  assert.deepEqual(result.integrationShards, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    result.plan.filter(([job]) => job === "integration-shard"),
    [1, 2, 3, 4, 5, 6, 7].map((shard) => ["integration-shard", shard])
  );
});

test("workflow shard parser fails loudly when the matrix shape drifts", () => {
  const multilineMatrix = makeWorkflow(3).replace("shard: [1, 2, 3]", "shard:\n          - 1\n          - 2\n          - 3");

  assert.throws(
    () => parseIntegrationShardMatrix(makeManifest(), multilineMatrix),
    /strategy\.matrix\.shard must be an inline integer list/u
  );
  assert.throws(
    () => parseIntegrationShardMatrix(makeManifest(), "jobs:\n  boundaries:\n    steps: []\n"),
    /rewrite-ci integration-shard job is missing/u
  );
});

test("CI-equivalent plan rejects a manifest that drops the sharded job", () => {
  const manifest = makeManifest();
  manifest.gates = manifest.gates.filter((gate) => gate.id !== "test-integration");

  assert.throws(
    () => buildCiPlan(manifest, makeWorkflow(6)),
    /no gate in the manifest declares workflow job "integration-shard"/u
  );
});

test("skipped jobs are visible in the final summary and JSON receipt", () => {
  const result = buildCiPlan(makeManifest(), makeWorkflow(2));
  const receipts = result.plan.map(([job, shard]) => ({
    job: shard === undefined ? job : `${job} (${shard})`,
    exitCode: 0,
    seconds: 0
  }));
  const receipt = createReceipt(receipts, result.skipped);
  const summary = formatSummary(receipts, result.skipped);

  assert.deepEqual(receipt.skipped, [
    { job: "pr-body-lint", reason: "needs a real pull request body and cannot run locally" }
  ]);
  assert.equal(receipt.notice, LOCAL_EQUIVALENCE_NOTICE);
  assert.equal(receipt.ok, true);
  assert.match(summary, /SKIPPED pr-body-lint: needs a real pull request body/u);
  assert.match(summary, /ALL GREEN \(locally runnable jobs only; 1 skipped\)/u);
  assert.match(summary, /本地绿 ≠ 完整 CI 等价/u);
});

test("explicit shard parallelism narrows fan-out but can never spend the interactive core reservation", () => {
  assert.deepEqual(resolveShardParallelism({
    raw: "2", shardCount: 6, localSlots: 6, perShardConcurrency: 2, cpuCount: 16, reservationRaw: "4"
  }), {
    parallelism: 2,
    source: "explicit",
    requested: 2,
    usableCores: 12,
    reservedCores: 4,
    coreCap: 6,
    localSlots: 6,
    perShardConcurrency: 2
  });
  assert.equal(resolveShardParallelism({
    raw: "99", shardCount: 6, localSlots: 6, perShardConcurrency: 2, cpuCount: 16, reservationRaw: "4"
  }).parallelism, 6);
  assert.throws(() => resolveShardParallelism({
    raw: "many", shardCount: 2, localSlots: 3, perShardConcurrency: 2, cpuCount: 8, reservationRaw: ""
  }), /HARNESS_SHARD_PARALLELISM must be a positive integer/u);
});

test("default shard parallelism spends the whole core budget and shrinks as the reservation grows", () => {
  assert.equal(resolveShardParallelism({
    raw: "", shardCount: 6, localSlots: 6, perShardConcurrency: 2, cpuCount: 16, reservationRaw: "4"
  }).parallelism, 6);
  assert.equal(resolveShardParallelism({
    raw: "", shardCount: 6, localSlots: 6, perShardConcurrency: 2, cpuCount: 16, reservationRaw: "12"
  }).parallelism, 2);
  assert.equal(resolveShardParallelism({
    raw: "", shardCount: 6, localSlots: 2, perShardConcurrency: 2, cpuCount: 16, reservationRaw: "0"
  }).parallelism, 2, "an explicit slot budget still bounds fan-out");
});

test("machine load never shrinks the declared core budget", () => {
  const busy = resolveShardParallelism({
    raw: "", shardCount: 6, localSlots: 6, perShardConcurrency: 2, cpuCount: 16, reservationRaw: "4"
  });
  assert.equal(busy.source, "core-budget");
  assert.equal(busy.parallelism, 6, "self-inflicted load must not self-throttle the runner");
});

test("parallelism two overlaps two shard child processes and preserves a failing exit code", async (context) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-shard-parallelism-"));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const plan = [["integration-shard", 1], ["integration-shard", 2]];
  const resolution = resolveShardParallelism({
    raw: "2", shardCount: 2, localSlots: 3, perShardConcurrency: 2, cpuCount: 8, reservationRaw: ""
  });
  const receipts = await runCiPlan(
    plan,
    resolution.parallelism,
    (_job, shard) => runFixtureShard(fixtureRoot, shard),
    () => {}
  );

  assert.equal(resolution.source, "explicit");
  assert.equal(resolution.parallelism, 2);
  assert.deepEqual(receipts.map(({ job, exitCode }) => ({ job, exitCode })), [
    { job: "integration-shard (1)", exitCode: 0 },
    { job: "integration-shard (2)", exitCode: 7 }
  ]);
  assert.equal(createReceipt(receipts, []).ok, false);
});

function runFixtureShard(root, shard) {
  const peer = shard === 1 ? 2 : 1;
  const expectedExitCode = shard === 2 ? 7 : 0;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(import.meta.dirname, "test-fixtures/shard-parallelism/worker.mjs"),
      root, String(shard), String(peer), String(expectedExitCode)
    ], { stdio: "ignore" });
    child.once("error", () => resolve({ job: `integration-shard (${shard})`, exitCode: 1, seconds: 0 }));
    child.once("close", (code) => resolve({
      job: `integration-shard (${shard})`,
      exitCode: code ?? 1,
      seconds: Math.round((Date.now() - started) / 1000)
    }));
  });
}

function makeManifest() {
  return {
    enforcementConstants: [
      {
        id: "ci-integration-shard-sequence",
        description: "Integration shard ids are owned by the pull-request workflow matrix.",
        valueType: "positive-integer-sequence",
        authority: {
          kind: "workflow-matrix",
          path: ".github/workflows/rewrite-ci.yml",
          job: "integration-shard",
          matrixKey: "shard"
        },
        consumers: ["tools/run-ci-equivalent.mjs", "tools/integration-test-shards.mjs"],
        literalAudit: "forbid-derived-count-and-sequence"
      }
    ],
    gates: [
      {
        id: "test-integration",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["integration-shard"] } }
      },
      {
        id: "check-boundaries",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } }
      },
      {
        id: "check-pr-body",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["pr-body-lint"] } }
      }
    ]
  };
}

function makeWorkflow(shardCount) {
  const shards = Array.from({ length: shardCount }, (_, index) => index + 1);
  return [
    "name: rewrite-ci",
    "jobs:",
    "  integration-shard:",
    "    strategy:",
    "      fail-fast: false",
    "      matrix:",
    `        shard: [${shards.join(", ")}]`,
    "    steps: []",
    "  boundaries:",
    "    steps: []",
    ""
  ].join("\n");
}
