// harness-test-tier: contract
import { decodeCiObservation } from "../../kernel/test/fixtures/ci-observation.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { completionSnapshot, emptyCompletionContract } from "../../kernel/test/domain/completion.fixtures.ts";
import { runProcessTextAsync } from "../src/process-port.ts";
import { readCiObservatory } from "../src/ci-observatory-read.ts";
import {
  fetchCiObservations as fetchCiObservationsRaw,
  ingestCiObservations,
  selectCiObservationRuns,
} from "../src/ci-observation-actions.ts";
import type { CiRunObservationEventV3 } from "../../kernel/test/fixtures/ci-observation.ts";

const actor = { principal: { personId: "person-observatory" }, executor: null } as const;
const ciSettings = (workflows: readonly string[] = ["rewrite-ci", "rebuild-gates"]) => ({
  read: () => ({ ci: { workflows } }),
});

// The daemon runs the gh reads before the write queue and the appends inside it; these cases run both halves back to back.
async function pullAndIngestCiObservations(
  cell: Parameters<typeof ingestCiObservations>[0],
  action: Parameters<typeof fetchCiObservations>[1],
  binding: Parameters<typeof ingestCiObservations>[1],
  runGh: Parameters<typeof fetchCiObservations>[2],
) {
  return ingestCiObservations(cell, binding, await fetchCiObservations(cell, action, runGh));
}

function event(
  revision: number,
  run: Partial<CiRunObservationEventV3["payload"]["run"]>,
  tests: CiRunObservationEventV3["payload"]["tests"],
  gates: CiRunObservationEventV3["payload"]["gates"] = [],
): CiRunObservationEventV3 {
  return {
    schema: "ci-run-observation/v3",
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

test("CI observatory preserves legacy hot counters and exposes unavailable rerun statistics", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ci-observatory-"));
  mkdirSync(path.join(rootDir, "tools"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "tools/test-quarantine.json"),
    JSON.stringify({
      schema: "harness-test-quarantine/v1",
      tests: [{ test: "flaky test", ownerTask: "task_f9443002d6d995489ebf082911", quarantinedAt: "2026-08-01" }],
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
      [{ gate: "G32", result: "fail", metrics: { durationMs: 20 } }],
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
      [{ gate: "G32", result: "pass", metrics: { durationMs: 12, count: 3 } }],
    ),
    event(1, { branch: "feature/ignored" }, [
      { file: "ignored.ts", name: "ignored", tier: "fast", shard: 1, durationMs: 99, status: "failed", retry: 0 },
    ]),
  ];
  try {
    const result = readCiObservatory({
      rootDir,
      projection: {
        listEntities: () => [],
        readCiRunObservations: () => ({
          status: "ready",
          events: observations.map(decodeCiObservation),
          watermark: 3,
          sourceRevision: 3,
        }),
      } as never,
      now: "2026-08-27T00:00:00.000Z",
      window: 10,
    });
    assert.equal(result.runs.length, 2);
    assert.deepEqual(result.tests, []);
    assert.equal(result.statisticsAvailability, "pending");
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
    assert.equal(result.runs[0]?.pass, null);
    assert.equal(result.runs[1]?.pass, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CI observatory rejects out-of-range windows before reading the projection", () => {
  assert.throws(() => readCiObservatory({ rootDir: process.cwd(), projection: {} as never, window: 0 }), /1\.\.100/u);
});

test("CI observatory does not count an advisory gate as a passing run", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ci-observatory-advisory-"));
  mkdirSync(path.join(rootDir, "tools"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "tools/test-quarantine.json"),
    JSON.stringify({ schema: "harness-test-quarantine/v1", tests: [] }),
  );
  try {
    const result = readCiObservatory({
      rootDir,
      projection: {
        listEntities: () => [],
        readCiRunObservations: () => ({
          status: "ready",
          events: [
            decodeCiObservation(
              event(1, { runId: "advisory-run" }, [], [{ gate: "G32", result: "advisory", metrics: { count: 1 } }]),
            ),
          ],
          watermark: 1,
          sourceRevision: 1,
        }),
      } as never,
      window: 1,
    });
    assert.equal(result.runs[0]?.pass, null);
    assert.equal(result.gateTrends[0]?.points[0]?.pass, false);
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
  const rootDir = mkdtempSync(path.join(tmpdir(), "ci-observatory-window-"));
  mkdirSync(path.join(rootDir, "tools"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "tools/test-quarantine.json"),
    JSON.stringify({ schema: "harness-test-quarantine/v1", tests: [] }),
  );
  try {
    const result = readCiObservatory({
      rootDir,
      projection: {
        listEntities: () => [],
        readCiRunObservations: () => ({
          status: "ready",
          events: [
            decodeCiObservation(event(3, { runId: "new", job: "typecheck" }, [])),
            decodeCiObservation(event(2, { runId: "new", job: "fast-contract" }, [])),
            decodeCiObservation(event(1, { runId: "old" }, [])),
          ],
          watermark: 3,
          sourceRevision: 3,
        }),
      } as never,
      window: 1,
    });
    assert.deepEqual(
      result.runs.map((run) => run.job),
      ["fast-contract", "typecheck"],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CI observation pull writes canonical events once per run and job", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ci-observation-pull-"));
  const events = new Map<string, CiRunObservationEventV3>();
  let revision = 0;
  const cell = {
    rootDir,
    settings: ciSettings(),
    now: () => "2026-08-27T04:00:00.000Z",
    cellCodedError: (_code: string, message: string) => new Error(message),
    store: {
      readHead: () => (revision === 0 ? null : { revision }),
      readEvent: (opId: string) => events.get(opId),
      append: ({ event: observed }: { event: CiRunObservationEventV3 }) => {
        revision += 1;
        events.set(observed.opId, observed);
        return { revision };
      },
    },
    projection: {
      listEntities: () => [],
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
        event: args[2] === "101" ? "schedule" : "push",
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
        gates:
          runId === "101"
            ? [{ gate: "G32", result: "pass", metrics: { files: 42 } }]
            : [{ gate: "G32", pass: true, metrics: { files: 42 } }],
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
    assert.equal(eventRefs.length, 4);
    assert.deepEqual(JSON.parse(first.evidence), {
      eventRefs,
      schema: "ci-observe-pull/v1",
      imported: 4,
      duplicate: 0,
      requestedRuns: 20,
    });
    assert.deepEqual(JSON.parse(replay.evidence), {
      eventRefs,
      schema: "ci-observe-pull/v1",
      imported: 0,
      duplicate: 4,
      requestedRuns: 20,
    });
    assert.equal(events.size, 4);
    const observed = [...events.values()];
    assert.deepEqual(observed.find((event) => event.payload.run.runId === "101.1")?.payload.verification, {
      source: "github-actions",
      workflow: "rewrite-ci",
      runId: "101",
      attempt: 1,
      headSha: "sha-101",
      conclusion: "success",
      event: "schedule",
    });
    assert.equal(
      observed.find((event) => event.payload.run.runId === "101.1")?.payload.verification?.event,
      "schedule",
    );
    assert.equal(
      readCiObservatory({
        rootDir,
        projection: {
          listEntities: () => [],
          readCiRunObservations: () => ({
            status: "ready",
            events: observed.map(decodeCiObservation),
            watermark: 2,
            sourceRevision: 2,
          }),
        } as never,
      }).runs.length,
      2,
    );
    assert.equal(
      observed.find((event) => event.payload.run.runId === "102.1")?.payload.verification?.workflow,
      "rebuild-gates",
    );
    assert.ok([...events.values()].every((observed) => String(observed.schema) === "ci-run-observation/v4"));
    assert.deepEqual(
      [...events.values()].map((observed) => observed.payload.gates),
      [[], [], [], []],
      "legacy artifacts cannot become new job measurements",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CI observation pull collects selected GitHub runs concurrently in selection order", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ci-observation-concurrent-"));
  const viewResolvers = new Map<string, () => void>();
  const viewStarts: string[] = [];
  const runGh = (async (_command: string, args: readonly string[]) => {
    const runId = String(args[2]);
    if (args[1] === "view") {
      viewStarts.push(runId);
      await new Promise<void>((resolve) => viewResolvers.set(runId, resolve));
      return JSON.stringify({
        workflowName: "rewrite-ci",
        headSha: `sha-${runId}`,
        headBranch: "main",
        status: "completed",
        conclusion: "success",
        attempt: 1,
        event: "push",
      });
    }
    const outputDir = String(args[args.indexOf("--dir") + 1]);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      path.join(outputDir, "observation.json"),
      JSON.stringify({
        schema: "ci-run-artifact/v1",
        run: {
          runId: `${runId}.1`,
          sha: `sha-${runId}`,
          branch: "main",
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
    const fetching = fetchCiObservations(
      { rootDir, settings: ciSettings(), cellCodedError: (_code: string, message: string) => new Error(message) },
      { kind: "ci-observe-pull", runs: [102, 101] },
      runGh,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(viewStarts, ["102", "101"]);
    viewResolvers.get("102")?.();
    viewResolvers.get("101")?.();
    const result = await fetching;
    assert.deepEqual(
      result.runs.map((run) => run.databaseId),
      [102, 101],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CI observation pull synthesizes a ledger-publication run only for private ledger commits", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ci-observation-ledger-"));
  const ledgerRoot = path.join(rootDir, "harness");
  const cell = {
    rootDir,
    settings: ciSettings(),
    cellCodedError: (_code: string, message: string) => new Error(message),
  };
  const noRuns = ((_command: string, args: readonly string[]) => (args[1] === "list" ? "[]" : "")) as never;
  try {
    git(rootDir, "init", "-q", "-b", "main");
    writeFileSync(path.join(rootDir, "README.md"), "public\n");
    git(rootDir, "add", "README.md");
    git(rootDir, "commit", "-q", "-m", "public");
    mkdirSync(ledgerRoot);
    git(ledgerRoot, "init", "-q", "-b", "main");
    writeFileSync(path.join(ledgerRoot, "harness.yaml"), "ledger: true\n");
    git(ledgerRoot, "add", "harness.yaml");
    git(ledgerRoot, "commit", "-q", "-m", "ledger");
    const ledgerHead = git(ledgerRoot, "rev-parse", "HEAD");
    const privateOnly = await fetchCiObservations(cell, { kind: "ci-observe-pull", limit: 20 }, noRuns);
    assert.deepEqual(
      privateOnly.runs.map((run) => [run.summary.workflowName, run.summary.headSha, `ledger-${run.summary.headSha}`]),
      [["ledger-publication", ledgerHead, `ledger-${ledgerHead}`]],
    );
    // Once the public repository holds the same commit, GitHub owns the observation.
    git(rootDir, "fetch", "-q", ledgerRoot, "HEAD");
    const published = await fetchCiObservations(cell, { kind: "ci-observe-pull", limit: 20 }, noRuns);
    assert.deepEqual(published.runs, []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    encoding: "utf8",
  }).trim();
}

test("CI observation pull imports named main runs without listing recent runs", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ci-observation-named-")),
    events: CiRunObservationEventV3[] = [],
    calls: string[] = [];
  const cell = {
    rootDir,
    settings: ciSettings(["ci"]),
    now: () => "2026-09-10T00:00:00.000Z",
    cellCodedError: (_code: string, message: string) => new Error(message),
    store: {
      readHead: () => (events.length ? { revision: events.length } : null),
      readEvent: (opId: string) => events.find((event) => event.opId === opId),
      append: ({ event }: { event: CiRunObservationEventV3 }) => {
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
        workflowName: args[2] === "700" ? "ci" : "rewrite-ci",
        headSha: `sha-${args[2]}`,
        headBranch: args[2] === "701" ? "codex/feature" : "main",
        status: "completed",
        conclusion: "success",
        attempt: 1,
        event: "push",
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
    assert.equal(events.length, 2);
    assert.equal(events[0]?.payload.verification?.headSha, "sha-700");
    assert.equal(events[0]?.payload.verification?.workflow, "ci");
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
    assert.equal(events.length, 2);
    const unconfigured = await pullAndIngestCiObservations(
      cell as never,
      { kind: "ci-observe-pull", runs: ["702"] },
      { actor, source: "local" },
      runGh,
    );
    assert.equal(JSON.parse(unconfigured.evidence).imported, 2);
    assert.deepEqual(events[2]?.payload.verification, {
      source: "github-actions",
      workflow: "rewrite-ci",
      runId: "702",
      attempt: 1,
      headSha: "sha-702",
      conclusion: "success",
      event: "push",
    });
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

test("CI provenance comes from the completed matching GitHub run, not workflow policy or artifact labels", async () => {
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
      workflow: "other-ci",
      status: "completed",
      conclusion: "success",
      attempt: 1,
      sha: "commit",
      expected: true,
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
      name: "old attempt artifact does not suppress latest workflow witness",
      workflow: "rewrite-ci",
      status: "completed",
      conclusion: "success",
      attempt: 2,
      sha: "commit",
      expected: true,
    },
    {
      name: "other commit artifact does not alter API witness",
      workflow: "rewrite-ci",
      status: "completed",
      conclusion: "success",
      attempt: 1,
      sha: "other",
      expected: true,
    },
  ];
  for (const scenario of cases) {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ci-completion-verdict-")),
      events: CiRunObservationEventV3[] = [];
    let downloads = 0;
    const cell = {
      rootDir,
      settings: ciSettings(),
      now: () => "2026-09-09T00:00:00.000Z",
      cellCodedError: (_code: string, message: string) => new Error(message),
      store: {
        readHead: () => (events.length ? { revision: events.length } : null),
        readEvent: (opId: string) => events.find((event) => event.opId === opId),
        append: ({ event }: { event: CiRunObservationEventV3 }) => {
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
              event: "push",
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
              gates: [{ gate: "ci", result: "pass", metrics: {} }],
            }),
          );
          return "";
        },
      );
      assert.equal(events.length, scenario.status === "completed" ? 2 : 0, scenario.name);
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

test("CI observation pull --task imports the run the frozen contract judges: the newest covering push, red included", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ci-observation-task-")),
    delivery = "d".repeat(40),
    events: CiRunObservationEventV3[] = [];
  const cell = {
    rootDir,
    settings: ciSettings(["rewrite-ci"]),
    now: () => "2026-09-15T00:00:00.000Z",
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    store: {
      readHead: () => (events.length ? { revision: events.length } : null),
      readEvent: (opId: string) => events.find((event) => event.opId === opId),
      append: ({ event }: { event: CiRunObservationEventV3 }) => {
        events.push(event);
        return { revision: events.length };
      },
    },
    projection: {
      listEntities: () => [],
      apply: () => undefined,
      readCiRunObservations: () => ({ watermark: events.length }),
      read: () => ({
        snapshot: {
          // The current cut freezes its source and coverage options.
          task: { iteration: 2, completionGateIds: ["ci"] },
          executions: [
            { iteration: 1, submission: { commitSha: "a".repeat(40) } },
            { iteration: 2, submission: { commitSha: delivery, completionContract: taskCiContract } },
          ],
        },
      }),
    },
  };
  // Coverage keys are the full `${delivery}...${head}` compare range: keyed by head alone the
  // stub accepts any base, so a delivery-resolution regression (an older iteration's commit)
  // still reads as covered. Unknown ranges answer "diverged" and fail the pull closed.
  const coverage: Readonly<Record<string, string>> = {
      [`${delivery}...sha-906`]: "ahead",
      [`${delivery}...sha-905`]: "ahead",
      [`${delivery}...sha-904`]: "ahead",
      [`${delivery}...sha-903`]: "ahead",
      [`${delivery}...sha-902`]: "ahead",
      [`${delivery}...sha-side`]: "ahead",
    },
    // Main's history page, tip first. sha-side is a merged branch's commit listed between main heads
    // but off the first-parent chain: its green run must never be consulted ahead of 903's red.
    commits = [
      { sha: "sha-906", parents: ["sha-905"] },
      { sha: "sha-905", parents: ["sha-904", "sha-side"] },
      { sha: "sha-side", parents: ["sha-903"] },
      { sha: "sha-904", parents: ["sha-903"] },
      { sha: "sha-903", parents: ["sha-902"] },
      { sha: "sha-902", parents: ["sha-901"] },
      { sha: "sha-901", parents: [] },
    ],
    run = (databaseId: number, conclusion: string, extra: Record<string, unknown> = {}) => ({
      databaseId,
      path: ".github/workflows/rewrite-ci.yml",
      headBranch: "main",
      event: "push",
      status: "completed",
      conclusion,
      ...extra,
    }),
    // Per head, newest first along the chain: 906 carries only a manual dispatch (not the frozen push
    // event) and a pull-request branch run, 905 only another workflow, 904 was cancelled (no
    // verdict), so 903's failure is the verdict and neither the older green 902 nor sha-side shadows it.
    runsByHead: Readonly<Record<string, readonly unknown[]>> = {
      "sha-906": [run(906, "success", { event: "workflow_dispatch" }), run(916, "success", { headBranch: "codex/x" })],
      "sha-905": [run(905, "success", { path: ".github/workflows/other.yml" })],
      "sha-904": [run(904, "cancelled")],
      "sha-903": [run(903, "failure")],
      "sha-902": [run(902, "success")],
      "sha-side": [run(950, "success")],
    },
    conclusions: Readonly<Record<string, string>> = { "903": "failure" };
  const api = async (args: readonly string[]) => {
    const url = String(args[1]);
    if (url.startsWith("repos/:owner/:repo/commits?")) return JSON.stringify(commits);
    if (url.includes("/actions/runs?head_sha="))
      return JSON.stringify(runsByHead[/head_sha=([^&]+)/u.exec(url)?.[1] ?? ""] ?? []);
    const status = coverage[url.replace(/^.*\/compare\//u, "")] ?? "diverged";
    // Exercise the production subprocess buffer with a historical compare whose
    // patch exceeds it. gh must project the response before writing stdout.
    return runProcessTextAsync(process.execPath, [
      "-e",
      `const response = { status: process.argv[1], files: [{ patch: "x".repeat(2 * 1024 * 1024) }] };
         process.stdout.write(JSON.stringify(process.argv[2] === "{status: .status}" ? { status: response.status } : response));`,
      status,
      args[args.indexOf("--jq") + 1] ?? "",
    ]);
  };
  const runGh = async (_command: string, args: readonly string[]) => {
    if (args[0] === "api") return api(args);
    assert.notEqual(args[1], "list", "a task witness lookup never lists runs by branch");
    if (args[1] === "view")
      return JSON.stringify({
        workflowName: "rewrite-ci",
        headSha: `sha-${args[2]}`,
        headBranch: "main",
        status: "completed",
        conclusion: conclusions[String(args[2])],
        attempt: 1,
        event: "push",
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
      { kind: "ci-observe-pull", taskId: "task-witness" },
      { actor, source: "local" },
      runGh,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.scope, "workflow");
    assert.equal(events[0]?.payload.verification?.runId, "903");
    assert.equal(events[0]?.payload.verification?.headSha, "sha-903");
    assert.equal(events[0]?.payload.verification?.conclusion, "failure");
    assert.equal(JSON.parse(receipt.evidence).requestedRuns, 1);
    assert.match(receipt.summary, /task-witness CI witness: run 903 \(rewrite-ci\) concluded failure/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CI observation pull --task fails closed when no completed run covers the delivery", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ci-observation-task-none-")),
    delivery = "d".repeat(40);
  const cell = {
    rootDir,
    settings: ciSettings(["rewrite-ci"]),
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    projection: {
      listEntities: () => [],
      read: () => ({
        snapshot: {
          task: { iteration: 1, completionGateIds: ["ci"] },
          executions: [{ iteration: 1, submission: { commitSha: delivery, completionContract: taskCiContract } }],
        },
      }),
    },
  };
  // 906 (tip) covers the delivery but is still running; 905 predates it, so the walk stops there and
  // its completed green never answers for the delivery.
  const commits = [
      { sha: "sha-906", parents: ["sha-905"] },
      { sha: "sha-905", parents: [] },
    ],
    runsByHead: Readonly<Record<string, readonly unknown[]>> = {
      "sha-906": [
        {
          databaseId: 906,
          path: ".github/workflows/rewrite-ci.yml",
          headBranch: "main",
          event: "push",
          status: "in_progress",
          conclusion: null,
        },
      ],
      "sha-905": [
        {
          databaseId: 905,
          path: ".github/workflows/rewrite-ci.yml",
          headBranch: "main",
          event: "push",
          status: "completed",
          conclusion: "success",
        },
      ],
    };
  const coverage: Readonly<Record<string, string>> = {
    [`${delivery}...sha-906`]: "ahead",
    [`${delivery}...sha-905`]: "diverged",
  };
  const runGh = (async (_command: string, args: readonly string[]) => {
    const url = String(args[1]);
    if (args[0] !== "api") throw new Error(`unexpected gh call: ${args.join(" ")}`);
    if (url.startsWith("repos/:owner/:repo/commits?")) return JSON.stringify(commits);
    if (url.includes("/actions/runs?head_sha="))
      return JSON.stringify(runsByHead[/head_sha=([^&]+)/u.exec(url)?.[1] ?? ""] ?? []);
    return JSON.stringify({ status: coverage[url.replace(/^.*\/compare\//u, "")] ?? "diverged" });
  }) as never;
  try {
    // The completed run does not cover; the in_progress run does, so next names the pending run.
    await assert.rejects(
      fetchCiObservations(cell as never, { kind: "ci-observe-pull", taskId: "task-witness" }, runGh),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "ci_witness_not_found");
        assert.match(error.message, /next: run 906 is in_progress/u);
        return true;
      },
    );
    // No submitted execution with a delivery commit fails closed before any gh call.
    const unsubmitted = {
      ...cell,
      projection: {
        listEntities: () => [],
        read: () => ({
          snapshot: { task: { iteration: 1 }, executions: [{ iteration: 1, submission: null }] },
        }),
      },
    };
    await assert.rejects(
      fetchCiObservations(unsubmitted as never, { kind: "ci-observe-pull", taskId: "task-witness" }, runGh),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "ci_witness_delivery_unresolved");
        assert.match(error.message, /next: submit the task delivery/u);
        return true;
      },
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CI observation pull reports rate_limited with the reset hint instead of a raw gh 403", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ci-observation-rate-limit-")),
    delivery = "d".repeat(40);
  const cell = {
    rootDir,
    settings: ciSettings(["rewrite-ci"]),
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    projection: {
      listEntities: () => [],
      read: () => ({
        snapshot: {
          task: { iteration: 1, completionGateIds: ["ci"] },
          executions: [{ iteration: 1, submission: { commitSha: delivery, completionContract: taskCiContract } }],
        },
      }),
    },
  };
  const runs = [
    {
      databaseId: 905,
      headBranch: "main",
      headSha: "sha-905",
      createdAt: "2026-09-15T05:00:00Z",
      status: "completed",
      conclusion: "success",
      event: "push",
    },
  ];
  // execFile-shaped failure: message embeds the gh stderr, stderr rides alongside, code is numeric.
  const ghRateLimited = (stderr: string) =>
    Object.assign(new Error(`Command failed: gh api repos/:owner/:repo/compare\n${stderr}`), {
      code: 1,
      stdout: "",
      stderr,
    });
  const listThen = (failure: () => Error) => async (_command: string, args: readonly string[]) => {
    if (args[0] === "api") throw failure();
    if (args[1] === "list") return JSON.stringify(runs);
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  try {
    // A primary rate limit on the first GitHub API call classifies with the parsed reset hint.
    await assert.rejects(
      fetchCiObservations(
        cell as never,
        { kind: "ci-observe-pull", taskId: "task-witness" },
        listThen(() =>
          ghRateLimited("gh: API rate limit exceeded for person-zeyu. (rate limit reset in 27m57s) (HTTP 403)"),
        ),
      ),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "rate_limited");
        assert.match(error.message, /resets in 27m57s/u);
        assert.doesNotMatch(error.message, /Command failed/u);
        return true;
      },
    );
    // A secondary rate limit without a parseable reset still classifies as rate_limited.
    await assert.rejects(
      fetchCiObservations(
        cell as never,
        { kind: "ci-observe-pull", taskId: "task-witness" },
        listThen(() =>
          ghRateLimited(
            "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)",
          ),
        ),
      ),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "rate_limited");
        return true;
      },
    );
    // An unscoped pull hits the rate limit on `gh run list` first.
    await assert.rejects(
      fetchCiObservations(cell as never, { kind: "ci-observe-pull", limit: 5 }, async () => {
        throw ghRateLimited("gh: API rate limit exceeded for person-zeyu. (rate limit reset in 1h2m3s) (HTTP 403)");
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "rate_limited");
        assert.match(error.message, /resets in 1h2m3s/u);
        return true;
      },
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function fetchCiObservations(
  cell: Parameters<typeof fetchCiObservationsRaw>[0],
  action: Parameters<typeof fetchCiObservationsRaw>[1],
  runner: NonNullable<Parameters<typeof fetchCiObservationsRaw>[2]>,
) {
  const summaries = new Map<string, Record<string, unknown>>();
  return fetchCiObservationsRaw(cell, action, async (command, args, options) => {
    const artifactRun = /actions\/runs\/(\d+)\/artifacts\?/u.exec(args.find((arg) => arg.startsWith("repos/")) ?? "");
    if (artifactRun) {
      const summary = summaries.get(artifactRun[1]!)!;
      return JSON.stringify([
        {
          artifacts: [
            {
              id: Number(artifactRun[1]),
              name: `ci-observation-${artifactRun[1]}-${summary.attempt}-fixture`,
              expired: false,
            },
          ],
        },
      ]);
    }
    if (args.some((arg) => arg.includes("/jobs?"))) return JSON.stringify([{ jobs: [] }]);
    const match = args[0] === "api" ? /actions\/runs\/(\d+)\/attempts\/(\d+)$/u.exec(args[1] ?? "") : null;
    if (!match) {
      const result = await runner(command, args, options);
      if (args[1] === "view") summaries.set(args[2]!, JSON.parse(result));
      return result;
    }
    const summary = summaries.get(match[1]!)!;
    return JSON.stringify({
      run_attempt: Number(match[2]),
      head_sha: summary.headSha,
      head_branch: summary.headBranch,
      conclusion: summary.conclusion,
      event: summary.event,
      path: `.github/workflows/${summary.workflowName}.yml`,
      workflow_id: 1,
      name: summary.workflowName,
      repository: { full_name: "fixture/repository" },
    });
  });
}

const taskCiContract = {
  ...emptyCompletionContract,
  gates: [
    {
      gateId: "ci",
      appliesTo: "code",
      witness: {
        ...completionSnapshot.completion.sources["github-actions"],
        adapterId: "github-actions",
        adapterOptions: {
          workflows: ["rewrite-ci"],
          branch: "main",
          event: "push",
          coverage: "descendant",
          selection: "newest",
        },
      },
    },
  ],
};
