// harness-test-tier: contract
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readCiObservatory } from "../src/ci-observatory-read.ts";
import { pullAndIngestCiObservations, selectCiObservationRuns } from "../src/ci-observation-actions.ts";
import type { CiRunObservationEventV2 } from "../../kernel/src/index.ts";

const actor = { principal: { personId: "person-observatory" }, executor: null } as const;

function event(
  revision: number,
  run: Partial<CiRunObservationEventV2["payload"]["run"]>,
  tests: CiRunObservationEventV2["payload"]["tests"],
  gates: CiRunObservationEventV2["payload"]["gates"] = [],
): CiRunObservationEventV2 {
  return {
    schema: "ci-run-observation/v2",
    eventId: `event-observatory-${revision}`,
    workspaceRevision: revision,
    opId: `op-observatory-${revision}`,
    type: "ci_run_observed",
    actor,
    source: "local",
    occurredAt: `2026-08-2${revision}T00:00:00.000Z`,
    payload: {
      verification: null,
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
      { runId: "run-2", branch: "main", job: "typecheck", wallclockMs: 500 },
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

test("CI observation pull selects the newest main and main runs globally", () => {
  assert.deepEqual(
    selectCiObservationRuns(
      [
        { databaseId: 1, headBranch: "feature/ignored", createdAt: "2026-08-27T03:00:00Z" },
        { databaseId: 2, headBranch: "main", createdAt: "2026-08-27T01:00:00Z" },
        { databaseId: 3, headBranch: "main", createdAt: "2026-08-27T02:00:00Z" },
        { databaseId: 4, headBranch: "main", createdAt: "2026-08-27T00:00:00Z" },
      ],
      2,
    ),
    [
      { databaseId: 3, headBranch: "main", createdAt: "2026-08-27T02:00:00Z" },
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
  const events = new Map<string, CiRunObservationEventV2>();
  let revision = 0;
  const cell = {
    rootDir,
    now: () => "2026-08-27T04:00:00.000Z",
    cellCodedError: (_code: string, message: string) => new Error(message),
    store: {
      readHead: () => (revision === 0 ? null : { revision }),
      readEvent: (opId: string) => events.get(opId),
      append: ({ event: observed }: { event: CiRunObservationEventV2 }) => {
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
          : [{ databaseId: 102, headBranch: "main", createdAt: "2026-08-27T02:00:00Z" }],
      );
    }
    if (args[1] === "view")
      return JSON.stringify({
        workflowName: args[2] === "101" ? "rewrite-ci" : "rebuild-gates",
        headSha: `sha-${args[2]}`,
        headBranch: "main",
        status: "completed",
        conclusion: "success",
        attempt: 1,
      });
    const runId = String(args[2]),
      outputDir = String(args[args.indexOf("--dir") + 1]);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      path.join(outputDir, "observation.json"),
      JSON.stringify({
        schema: "ci-run-artifact/v1",
        run: {
          runId: `${runId}.1`,
          sha: `sha-${runId}`,
          branch: runId === "101" ? "main" : "main",
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
    const eventRefs = [...events.values()].map((event) => `event:${event.opId}`);
    assert.equal(eventRefs.length, 2);
    assert.deepEqual(JSON.parse(first.evidence), {
      eventRefs,
      schema: "ci-observe-pull/v1",
      imported: 2,
      duplicate: 0,
      requestedRuns: 20,
    });
    assert.deepEqual(JSON.parse(replay.evidence), {
      eventRefs,
      schema: "ci-observe-pull/v1",
      imported: 0,
      duplicate: 2,
      requestedRuns: 20,
    });
    assert.equal(events.size, 2);
    const observed = [...events.values()];
    assert.deepEqual(observed.find((event) => event.payload.run.runId === "101.1")?.payload.verification, {
      source: "github-actions",
      workflow: "rewrite-ci",
      runId: "101",
      attempt: 1,
      headSha: "sha-101",
      conclusion: "success",
    });
    assert.equal(observed.find((event) => event.payload.run.runId === "102.1")?.payload.verification, null);
    assert.ok([...events.values()].every((observed) => observed.schema === "ci-run-observation/v2"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CI observation pull imports named main runs without listing recent runs", async () => {
  const rootDir = mkdtempSync(path.join(process.cwd(), ".tmp-ci-observation-named-")),
    events: CiRunObservationEventV2[] = [],
    calls: string[] = [];
  const cell = {
    rootDir,
    now: () => "2026-09-10T00:00:00.000Z",
    cellCodedError: (_code: string, message: string) => new Error(message),
    store: {
      readHead: () => (events.length ? { revision: events.length } : null),
      readEvent: (opId: string) => events.find((event) => event.opId === opId),
      append: ({ event }: { event: CiRunObservationEventV2 }) => {
        events.push(event);
        return { revision: events.length };
      },
    },
    projection: { apply: () => undefined, readCiRunObservations: () => ({ watermark: events.length }) },
  };
  const runGh = async (_command: string, args: readonly string[]) => {
    calls.push(`${args[1]}:${args[2]}`);
    if (args[1] === "view")
      return JSON.stringify({
        workflowName: "rewrite-ci",
        headSha: `sha-${args[2]}`,
        headBranch: args[2] === "700" ? "main" : "codex/feature",
        status: "completed",
        conclusion: "success",
        attempt: 1,
      });
    assert.equal(args[1], "download");
    const output = String(args[args.indexOf("--dir") + 1]);
    mkdirSync(output, { recursive: true });
    writeFileSync(
      path.join(output, "observation.json"),
      JSON.stringify({
        schema: "ci-run-artifact/v1",
        run: {
          runId: `${args[2]}.1`,
          sha: `sha-${args[2]}`,
          branch: "main",
          prNumber: null,
          job: "full-check (24)",
          wallclockMs: 20,
          runner: "ubuntu",
        },
        tests: [],
        gates: [],
      }),
    );
    return "";
  };
  try {
    const receipt = await pullAndIngestCiObservations(
      cell as never,
      { kind: "ci-observe-pull", runs: ["700"] },
      { actor, source: "local" },
      runGh,
    );
    assert.deepEqual(calls, ["view:700", "download:700"]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.verification?.headSha, "sha-700");
    assert.equal(JSON.parse(receipt.evidence).requestedRuns, 1);
    await assert.rejects(
      pullAndIngestCiObservations(
        cell as never,
        { kind: "ci-observe-pull", runs: ["701"] },
        { actor, source: "local" },
        runGh,
      ),
      /CI run 701 is completed on codex\/feature; only completed main runs can be imported\./u,
    );
    assert.equal(events.length, 1);
    await assert.rejects(
      pullAndIngestCiObservations(
        cell as never,
        { kind: "ci-observe-pull", runs: ["700"], limit: 5 },
        { actor, source: "local" },
        runGh,
      ),
      /not both/u,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CI completion verdict comes from the completed matching workflow run, not artifact labels", async () => {
  const cases = [
    {
      name: "success",
      workflow: "rewrite-ci",
      status: "completed",
      conclusion: "success",
      attempt: 1,
      sha: "commit",
      expected: true,
    },
    {
      name: "failure",
      workflow: "rewrite-ci",
      status: "completed",
      conclusion: "failure",
      attempt: 1,
      sha: "commit",
      expected: false,
    },
    {
      name: "other workflow",
      workflow: "rebuild-gates",
      status: "completed",
      conclusion: "success",
      attempt: 1,
      sha: "commit",
      expected: undefined,
    },
    {
      name: "still running",
      workflow: "rewrite-ci",
      status: "in_progress",
      conclusion: "",
      attempt: 1,
      sha: "commit",
      expected: undefined,
    },
    {
      name: "old attempt",
      workflow: "rewrite-ci",
      status: "completed",
      conclusion: "success",
      attempt: 2,
      sha: "commit",
      expected: undefined,
    },
    {
      name: "other commit",
      workflow: "rewrite-ci",
      status: "completed",
      conclusion: "success",
      attempt: 1,
      sha: "other",
      expected: undefined,
    },
  ];
  for (const scenario of cases) {
    const rootDir = mkdtempSync(path.join(process.cwd(), ".tmp-ci-completion-verdict-")),
      events: CiRunObservationEventV2[] = [];
    let downloads = 0;
    const cell = {
      rootDir,
      now: () => "2026-09-09T00:00:00.000Z",
      cellCodedError: (_code: string, message: string) => new Error(message),
      store: {
        readHead: () => (events.length ? { revision: events.length } : null),
        readEvent: (opId: string) => events.find((event) => event.opId === opId),
        append: ({ event }: { event: CiRunObservationEventV2 }) => {
          events.push(event);
          return { revision: events.length };
        },
      },
      projection: { apply: () => undefined, readCiRunObservations: () => ({ watermark: events.length }) },
    };
    try {
      await pullAndIngestCiObservations(
        cell as never,
        { kind: "ci-observe-pull", limit: 1 },
        { actor, source: "local" },
        async (_command, args) => {
          if (args[1] === "list")
            return JSON.stringify([{ databaseId: 303, headBranch: "main", createdAt: "2026-09-09T00:00:00.000Z" }]);
          if (args[1] === "view")
            return JSON.stringify({
              workflowName: scenario.workflow,
              status: scenario.status,
              conclusion: scenario.conclusion,
              attempt: scenario.attempt,
              headSha: scenario.sha,
              headBranch: "main",
            });
          assert.equal(args[1], "download");
          downloads += 1;
          const output = String(args[args.indexOf("--dir") + 1]);
          mkdirSync(output, { recursive: true });
          writeFileSync(
            path.join(output, "observation.json"),
            JSON.stringify({
              schema: "ci-run-artifact/v1",
              run: {
                runId: "303.1",
                sha: "commit",
                branch: "main",
                prNumber: null,
                job: "full-check (24)",
                wallclockMs: 1,
                runner: "fixture",
              },
              tests: [],
              gates: [{ gate: "ci", pass: true, metrics: {} }],
            }),
          );
          return "";
        },
      );
      assert.equal(events.length, scenario.status === "completed" ? 1 : 0, scenario.name);
      assert.equal(downloads, scenario.status === "completed" ? 1 : 0, scenario.name);
      assert.equal(
        events[0]?.payload.verification ? events[0].payload.verification.conclusion === "success" : undefined,
        scenario.expected,
        scenario.name,
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});
