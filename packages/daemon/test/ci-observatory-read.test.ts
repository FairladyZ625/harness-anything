// harness-test-tier: contract
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readCiObservatory } from "../src/ci-observatory-read.ts";
import { pullAndIngestCiObservations, selectCiObservationRuns } from "../src/ci-observation-actions.ts";
import type { CiRunObservationEventV1 } from "../../kernel/src/index.ts";

const actor = { principal: { personId: "person-observatory" }, executor: null } as const;

function event(
  revision: number,
  run: Partial<CiRunObservationEventV1["payload"]["run"]>,
  tests: CiRunObservationEventV1["payload"]["tests"],
  gates: CiRunObservationEventV1["payload"]["gates"] = [],
): CiRunObservationEventV1 {
  return {
    schema: "ci-run-observation/v1",
    eventId: `event-observatory-${revision}`,
    workspaceRevision: revision,
    opId: `op-observatory-${revision}`,
    type: "ci_run_observed",
    actor,
    source: "local",
    occurredAt: `2026-08-2${revision}T00:00:00.000Z`,
    payload: {
      run: {
        runId: `run-${revision}`,
        sha: `sha-${revision}`,
        branch: "main",
        prNumber: null,
        job: "integration-shard",
        wallclockMs: revision * 100,
        runner: "ubuntu",
        ...run,
      },
      tests,
      gates,
    },
  };
}

test("CI observatory aggregates filtered runs, retries, percentiles, shards, gates, and quarantine", () => {
  const rootDir = mkdtempSync(path.join(process.cwd(), ".tmp-ci-observatory-"));
  mkdirSync(path.join(rootDir, "tools"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "tools/test-quarantine.json"),
    JSON.stringify({
      schema: "harness-test-quarantine/v1",
      tests: [{ test: "flaky test", ownerTask: "task_owner1", quarantinedAt: "2026-08-01" }],
    }),
  );
  const observations = [
    event(
      3,
      { runId: "run-2", branch: "mergify/merge-queue/main/pr-3", job: "typecheck", wallclockMs: 500 },
      [
        {
          file: "suite.ts",
          name: "flaky test",
          tier: "contract",
          shard: 2,
          durationMs: 300,
          status: "passed",
          retry: 0,
        },
      ],
      [{ gate: "G32", pass: false, metrics: { durationMs: 20 } }],
    ),
    event(
      2,
      { runId: "run-2", wallclockMs: 300 },
      [
        {
          file: "suite.ts",
          name: "flaky test",
          tier: "integration",
          shard: 2,
          durationMs: 100,
          status: "failed",
          retry: 0,
        },
        {
          file: "suite.ts",
          name: "flaky test",
          tier: "integration",
          shard: 2,
          durationMs: 200,
          status: "passed",
          retry: 1,
        },
        {
          file: "suite.ts",
          name: "slow test",
          tier: "integration",
          shard: 3,
          durationMs: 50,
          status: "passed",
          retry: 0,
        },
      ],
      [{ gate: "G32", pass: true, metrics: { durationMs: 12, count: 3 } }],
    ),
    event(1, { branch: "feature/ignored" }, [
      { file: "ignored.ts", name: "ignored", tier: "fast", shard: 1, durationMs: 99, status: "failed", retry: 0 },
    ]),
  ];
  try {
    const result = readCiObservatory({
      rootDir,
      projection: {
        readCiRunObservations: () => ({ status: "ready", events: observations, watermark: 3, sourceRevision: 3 }),
      } as never,
      now: "2026-08-27T00:00:00.000Z",
      window: 10,
    });
    assert.equal(result.runs.length, 2);
    assert.equal(result.flakes[0]?.test, "flaky test");
    assert.equal(result.flakes[0]?.flakes, 1);
    assert.equal(result.flakes[0]?.attempts, 2);
    assert.equal(result.flakes[0]?.p50Ms, 200);
    assert.equal(result.flakes[0]?.p95Ms, 300);
    assert.equal(result.flakes[0]?.ownerTask, "task_owner1");
    assert.equal(result.flakes[0]?.quarantineDays, 26);
    assert.deepEqual(result.shardDurations, [
      { shard: 2, durationMs: 600 },
      { shard: 3, durationMs: 50 },
    ]);
    const durationTrend = result.gateTrends.find((trend) => trend.metric === "durationMs");
    assert.ok(durationTrend);
    assert.deepEqual(
      durationTrend.points.map((point) => point.value),
      [12, 20],
    );
    assert.equal(result.l0MedianMs, 800);
    assert.equal(result.runs[0]?.pass, false);
    assert.equal(result.runs[1]?.pass, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CI observatory rejects out-of-range windows before reading the projection", () => {
  assert.throws(() => readCiObservatory({ rootDir: process.cwd(), projection: {} as never, window: 0 }), /1\.\.100/u);
});

test("CI observatory fails closed on malformed quarantine ownership", () => {
  const rootDir = mkdtempSync(path.join(process.cwd(), ".tmp-ci-observatory-invalid-"));
  mkdirSync(path.join(rootDir, "tools"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "tools/test-quarantine.json"),
    JSON.stringify({
      schema: "harness-test-quarantine/v1",
      tests: [{ test: "x", ownerTask: "", quarantinedAt: "2026-08-01" }],
    }),
  );
  try {
    assert.throws(
      () =>
        readCiObservatory({
          rootDir,
          projection: {
            readCiRunObservations: () => ({ status: "ready", events: [], watermark: 0, sourceRevision: 0 }),
          } as never,
        }),
      /ownerTask/u,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CI observation pull selects the newest main and merge-queue runs globally", () => {
  assert.deepEqual(
    selectCiObservationRuns(
      [
        { databaseId: 1, headBranch: "feature/ignored", createdAt: "2026-08-27T03:00:00Z" },
        { databaseId: 2, headBranch: "main", createdAt: "2026-08-27T01:00:00Z" },
        { databaseId: 3, headBranch: "mergify/merge-queue/main/pr-4", createdAt: "2026-08-27T02:00:00Z" },
        { databaseId: 4, headBranch: "main", createdAt: "2026-08-27T00:00:00Z" },
      ],
      2,
    ),
    [
      { databaseId: 3, headBranch: "mergify/merge-queue/main/pr-4", createdAt: "2026-08-27T02:00:00Z" },
      { databaseId: 2, headBranch: "main", createdAt: "2026-08-27T01:00:00Z" },
    ],
  );
});

test("CI observatory window retains every job from the selected workflow run", () => {
  const rootDir = mkdtempSync(path.join(process.cwd(), ".tmp-ci-observatory-window-"));
  mkdirSync(path.join(rootDir, "tools"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "tools/test-quarantine.json"),
    JSON.stringify({ schema: "harness-test-quarantine/v1", tests: [] }),
  );
  try {
    const result = readCiObservatory({
      rootDir,
      projection: {
        readCiRunObservations: () => ({
          status: "ready",
          events: [
            event(3, { runId: "new", job: "typecheck" }, []),
            event(2, { runId: "new", job: "fast-contract" }, []),
            event(1, { runId: "old" }, []),
          ],
          watermark: 3,
          sourceRevision: 3,
        }),
      } as never,
      window: 1,
    });
    assert.deepEqual(
      result.runs.map((run) => run.job),
      ["typecheck", "fast-contract"],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CI observation pull writes canonical events once per run and job", async () => {
  const rootDir = mkdtempSync(path.join(process.cwd(), ".tmp-ci-observation-pull-"));
  const events = new Map<string, CiRunObservationEventV1>();
  let revision = 0;
  const cell = {
    rootDir,
    now: () => "2026-08-27T04:00:00.000Z",
    cellCodedError: (_code: string, message: string) => new Error(message),
    store: {
      readHead: () => (revision === 0 ? null : { revision }),
      readEvent: (opId: string) => events.get(opId),
      append: ({ event: observed }: { event: CiRunObservationEventV1 }) => {
        revision += 1;
        events.set(observed.opId, observed);
        return { revision };
      },
    },
    projection: {
      apply: () => undefined,
      readCiRunObservations: () => ({ watermark: revision }),
    },
  };
  const runGh = ((_command: string, args: readonly string[]) => {
    if (args[1] === "list") {
      const workflow = args[3];
      return JSON.stringify(
        workflow === "rewrite-ci.yml"
          ? [{ databaseId: 101, headBranch: "main", createdAt: "2026-08-27T03:00:00Z" }]
          : [{ databaseId: 102, headBranch: "mergify/merge-queue/main/pr-2", createdAt: "2026-08-27T02:00:00Z" }],
      );
    }
    const runId = String(args[2]),
      outputDir = String(args[args.indexOf("--dir") + 1]);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      path.join(outputDir, "observation.json"),
      JSON.stringify({
        schema: "ci-run-artifact/v1",
        run: {
          runId,
          sha: `sha-${runId}`,
          branch: runId === "101" ? "main" : "mergify/merge-queue/main/pr-2",
          prNumber: null,
          job: `job-${runId}`,
          wallclockMs: 20,
          runner: "ubuntu",
        },
        tests: [],
        gates: [],
      }),
    );
    return "";
  }) as never;
  try {
    const first = await pullAndIngestCiObservations(
      cell,
      { kind: "ci-observe-pull", limit: 20 },
      { actor, source: "local" },
      runGh,
    );
    const replay = await pullAndIngestCiObservations(
      cell,
      { kind: "ci-observe-pull", limit: 20 },
      { actor, source: "local" },
      runGh,
    );
    assert.deepEqual(JSON.parse(first.evidence), {
      schema: "ci-observe-pull/v1",
      imported: 2,
      duplicate: 0,
      requestedRuns: 20,
    });
    assert.deepEqual(JSON.parse(replay.evidence), {
      schema: "ci-observe-pull/v1",
      imported: 0,
      duplicate: 2,
      requestedRuns: 20,
    });
    assert.equal(events.size, 2);
    assert.ok([...events.values()].every((observed) => observed.schema === "ci-run-observation/v1"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
