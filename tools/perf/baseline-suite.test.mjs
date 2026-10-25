// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { bytesToMib, percentile, stats, summarizeEventLoopLines, windowSamples } from "./baseline-stats.mjs";
import { eventLoopSnapshot, probeShouldActivate } from "./daemon-eventloop-probe.mjs";
import { parseArgs, renderMarkdown } from "./baseline-suite.mjs";
import { compare } from "./compare-baselines.mjs";

test("percentile and stats cover empty, single and spread samples", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.deepEqual(stats([]), { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null });
  assert.deepEqual(stats([5, 1, 3]), { count: 3, minMs: 1, p50Ms: 3, p95Ms: 5, maxMs: 5 });
  assert.equal(bytesToMib(1024 * 1024), 1);
});

test("windowSamples assigns boundary samples to the later window", () => {
  const split = windowSamples([{ atMs: 90 }, { atMs: 100 }, { atMs: 150 }, { atMs: 199 }, { atMs: 200 }], {
    first: { startMs: 100, endMs: 200 },
    second: { startMs: 200, endMs: 300 },
  });
  assert.deepEqual(
    split.first.map((row) => row.atMs),
    [100, 150, 199],
  );
  assert.deepEqual(
    split.second.map((row) => row.atMs),
    [200],
  );
});

test("summarizeEventLoopLines reports parse errors and per-window percentiles", () => {
  const { summary, parseErrors, records } = summarizeEventLoopLines(
    [
      JSON.stringify({ atMs: 10, p50Ms: 0.1, p95Ms: 0.2, maxMs: 0.3, rssBytes: 1024 * 1024 }),
      "{not json",
      JSON.stringify({ atMs: 30, p50Ms: 1, p95Ms: 2, maxMs: 4, rssBytes: 2 * 1024 * 1024 }),
    ],
    { idle: { startMs: 0, endMs: 20 }, load: { startMs: 20, endMs: 40 } },
  );
  assert.equal(parseErrors, 1);
  assert.equal(records.length, 2);
  assert.equal(summary.idle.samples, 1);
  assert.equal(summary.idle.delayP95Ms, 0.2);
  assert.equal(summary.idle.rssMib, 1);
  assert.equal(summary.load.delayMaxMs, 4);
});

test("event-loop probe only activates for a daemon-shaped argv with an explicit log target", () => {
  assert.equal(probeShouldActivate({}, ["node", "cli.js"]), false);
  assert.equal(probeShouldActivate({ HA_PERF_EVENTLOOP_LOG: "/tmp/x.jsonl" }, ["node", "cli.js"]), false);
  assert.equal(probeShouldActivate({ HA_PERF_EVENTLOOP_LOG: "/tmp/x.jsonl" }, ["node", "bin.ts", "serve"]), true);
  assert.equal(probeShouldActivate({ HA_PERF_EVENTLOOP_LOG: "/tmp/x.jsonl" }, ["node", "bin.ts", "--service"]), true);
});

test("eventLoopSnapshot reads histogram percentiles in nanoseconds", () => {
  const histogram = {
    mean: 1_000_000,
    max: 5_000_000,
    percentile: (value) => value * 20_000,
  };
  const snapshot = eventLoopSnapshot(histogram, { rss: 10, heapUsed: 4, external: 1 }, 123);
  assert.equal(snapshot.p50Ms, 1);
  assert.equal(snapshot.p95Ms, 1.9);
  assert.equal(snapshot.maxMs, 5);
  assert.equal(snapshot.rssBytes, 10);
  assert.equal(snapshot.atMs, 123);
});

test("parseArgs validates arms, sizes and required --out", () => {
  assert.throws(() => parseArgs([]), /--out <dir> is required/u);
  assert.throws(() => parseArgs(["--out", "d", "--arms", "nope"]), /unknown arm: nope/u);
  assert.throws(() => parseArgs(["--out", "d", "--cold-cycles", "0"]), /positive integer/u);
  const options = parseArgs(["--out", "d", "--arms", "cli,daemon", "--sizes", "1000,10000"]);
  assert.deepEqual(options.arms, ["cli", "daemon"]);
  assert.deepEqual(options.sizes, [1000, 10000]);
});

test("commit comparison matches equal event sizes and reports latency deltas", () => {
  const baseline = {
    schema: "perf-baseline-suite/v1",
    basisRevision: "a".repeat(40),
    measuredAt: "2026-10-24T00:00:00.000Z",
    host: { cpuModel: "fixture CPU" },
    kernel: {
      runs: [
        {
          events: 217107,
          catchUpMs: 100,
          reads: {
            taskList: { p95Ms: 20 },
            singleTaskRead: { p95Ms: 2 },
            factSearch: { p95Ms: 3 },
            relationGraph: { p95Ms: 4 },
          },
        },
      ],
    },
  };
  const current = {
    ...baseline,
    basisRevision: "b".repeat(40),
    kernel: {
      runs: [
        {
          events: 217107,
          catchUpMs: 120,
          reads: {
            taskList: { p95Ms: 22 },
            singleTaskRead: { p95Ms: 2 },
            factSearch: { p95Ms: 3 },
            relationGraph: { p95Ms: 4 },
          },
        },
      ],
    },
  };
  const report = compare(baseline, current);
  assert.match(report, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/u);
  assert.match(report, /\+20\.0%/u);
  assert.match(report, /Matched metrics: 5/u);
});

test("renderMarkdown carries every measured arm and the unverified section", () => {
  const report = {
    schema: "perf-baseline-suite/v1",
    measuredAt: "2026-10-18T00:00:00.000Z",
    basisRevision: "deadbeef",
    sourceState: { dirty: false, status: [] },
    host: { cpuModel: "Test CPU", parallelism: 8, totalMemMib: 16384, platform: "darwin", arch: "arm64", node: "v24" },
    reproduction: {
      build: "npm run build -w @harness-anything/cli",
      command: "node tools/perf/baseline-suite.mjs --out <dir>",
      arms: { cli: "cli shape", daemon: "daemon shape", kernel: "kernel shape", gui: "gui shape" },
    },
    cli: {
      cliEntry: "packages/cli/src/index.ts (source entry)",
      warm: {
        measurement: { ran: false, reason: "compiled CLI dist entry is a linked-worktree build" },
        committedRatchet: {
          source: "tools/gates/cli-command-timing.json",
          basisRevision: "ratchetbeef",
          measuredAt: null,
          limits: {
            "task-list": { maxTotalRatio: 2.5, observedP50: 1.2 },
            "task-show": { maxTotalRatio: 3, observedP50: 1.4 },
          },
        },
      },
      coldStart: {
        cycles: 5,
        coldWallMs: { p50Ms: 1500, p95Ms: 2000 },
        warmControlWallMs: { p50Ms: 300 },
        coldCliTotalMs: { p50Ms: 1480 },
        coldDaemonRoundTripMs: { p50Ms: 1200 },
        attachP50Ms: 900,
        attachDurationMsFromLog: [900, 910],
      },
      docShow: {
        measured: true,
        samples: 10,
        path: "harness/tasks/x/task_plan.md",
        wallMs: { p50Ms: 140, p95Ms: 180 },
      },
    },
    daemon: {
      socketReadyMs: 700,
      coldBootMs: 800,
      reads: {
        clientWallMs: { "repo.tasks.list": { count: 10, p50Ms: 5, p95Ms: 8 } },
        serverServiceMs: { "repo.tasks.list": { count: 10, p50Ms: 3, p95Ms: 6 } },
      },
      writes: {
        clientWallMs: { count: 8, p50Ms: 90, p95Ms: 130 },
        serverServiceMs: { count: 8, p50Ms: 80, p95Ms: 120 },
      },
      memory: {
        idleRssMib: { p50Ms: 120 },
        loadRssMib: { p50Ms: 140 },
        inDaemonIdleRssMib: 118,
        inDaemonLoadRssMib: 139,
      },
      eventLoopDelay: { idle: { delayP95Ms: 0.4, delayMaxMs: 2 }, load: { delayP95Ms: 1.1, delayMaxMs: 5 } },
      eventLoopParseErrors: 0,
    },
    kernel: {
      seed: 20261018,
      runs: [
        {
          entities: 1000,
          events: 1900,
          tasks: 1000,
          ledgerBuildMs: 100,
          catchUpMs: 200,
          reads: {
            taskList: { p50Ms: 4 },
            singleTaskRead: { p50Ms: 1 },
            factSearch: { p50Ms: 2 },
            relationGraph: { p50Ms: 6 },
          },
        },
      ],
    },
    gui: {
      startup: { windowReadyMs: 3000, firstUsableMs: 4200 },
      idle: {
        windowMs: 30000,
        processCount: 3,
        mainRssMib: { p50Ms: 200 },
        treeRssMib: { p50Ms: 400 },
        treeCpuPercent: { p50Ms: 1.5 },
        trailingTreeCpuPercent: { p50Ms: 0.8 },
      },
      viewSwitchMs: { 总览: { count: 8, p50Ms: 120, p95Ms: 200 } },
      gpu: { measured: false, reason: "disabled headless" },
    },
  };
  const markdown = renderMarkdown(report);
  for (const expected of [
    "## CLI",
    "task-list",
    "冷启动（5 轮",
    "doc show",
    "## daemon（独立实例）",
    "repo.tasks.list（读）",
    "repo.task.run fact-record（写）",
    "事件循环延迟",
    "## kernel（规模曲线）",
    "singleTask p50",
    "## GUI（隐藏窗口 lane）",
    "## 未覆盖（unverified）",
  ])
    assert.ok(markdown.includes(expected), `markdown must mention ${expected}`);
  const partial = renderMarkdown({ ...report, gui: undefined, kernel: undefined });
  assert.ok(!partial.includes("## kernel"));
  assert.ok(!partial.includes("## GUI"));
  assert.ok(partial.includes("## CLI"));
});
