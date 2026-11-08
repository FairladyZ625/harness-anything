// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { aggregate, attemptFailures, parseFailingTests, renderReport } from "./flaky-rerun-ledger.mjs";

// Shape copied from rewrite-ci job 127348385385 (integration-shard (3), attempt 1 of run 42056719147).
const log = [
  "2026-11-05T15:56:18.2280000Z ✖ failing tests:",
  "2026-11-05T15:56:18.2281000Z ",
  "2026-11-05T15:56:18.2282000Z test at packages/daemon/test/task-squad-orchestration.integration.test.ts:65:1",
  "2026-11-05T15:56:18.2283000Z ✖ squad children submit independently, resume one leader and integrate a verified local-remote delivery (32326.227435ms)",
  "2026-11-05T15:56:18.2285230Z   'test timed out after 30000ms'",
  "2026-11-05T15:56:18.2286000Z test at ../../../../../tmp/ha-cleanup-control-37IHow/control.test.mjs:4:1",
  "2026-11-05T15:56:18.2287000Z ✖ cleanup control (52.75231ms)",
  "2026-11-05T15:56:18.2288000Z test at /home/runner/work/harness-anything/harness-anything/tools/scale/center-bench.integration.test.mjs:81:1",
  "2026-11-05T15:56:18.2289000Z ✖ center campaign measures real transports, replica reconnect, backup and controlled faults (29510.5ms)",
  // The summary repeats a failure when the runner reprints it; one run counts once.
  "2026-11-05T15:56:18.2290000Z test at packages/daemon/test/task-squad-orchestration.integration.test.ts:65:1",
  "2026-11-05T15:56:18.2291000Z ✖ squad children submit independently, resume one leader and integrate a verified local-remote delivery (32326.227435ms)",
].join("\n");

test("first-attempt failures are read from the node:test summary block", () => {
  assert.deepEqual(parseFailingTests(log), [
    {
      file: "packages/daemon/test/task-squad-orchestration.integration.test.ts",
      test: "squad children submit independently, resume one leader and integrate a verified local-remote delivery",
    },
    { file: "/tmp/ha-cleanup-control-37IHow/control.test.mjs", test: "cleanup control" },
    {
      file: "tools/scale/center-bench.integration.test.mjs",
      test: "center campaign measures real transports, replica reconnect, backup and controlled faults",
    },
  ]);
});

test("a job without a parseable summary or without a readable log is marked, not dropped", () => {
  const rows = attemptFailures({ id: 1, createdAt: "2026-11-05T10:00:00Z" }, [
    { name: "gui-build", log: "FAIL test/overview-board.vitest.tsx" },
    { name: "windows-first-run (windows-latest)", log: null },
  ]);
  assert.deepEqual(rows, [
    { file: "(job:gui-build)", test: "", status: "unparsed", runId: 1, date: "2026-11-05", job: "gui-build" },
    {
      file: "(job:windows-first-run (windows-latest))",
      test: "",
      status: "log-unavailable",
      runId: 1,
      date: "2026-11-05",
      job: "windows-first-run (windows-latest)",
    },
  ]);
});

test("one test failing in two shards of the same run counts once", () => {
  const shard = log.split("\n").slice(2, 4).join("\n");
  const rows = attemptFailures({ id: 7, createdAt: "2026-11-05T10:00:00Z" }, [
    { name: "integration-shard (1)", log: shard },
    { name: "integration-shard (3)", log: shard },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(aggregate(rows)[0].count, 1);
});

test("aggregation counts runs per file and the report states the rerun-green rate", () => {
  const run = (id, date) => ({ id, createdAt: `${date}T00:00:00Z` });
  const rows = [
    ...attemptFailures(run(1, "2026-11-04"), [{ name: "integration-shard (3)", log }]),
    ...attemptFailures(run(2, "2026-11-06"), [
      { name: "integration-shard (3)", log: log.split("\n").slice(2, 4).join("\n") },
    ]),
    ...attemptFailures(run(3, "2026-11-05"), [{ name: "gui-build", log: "" }]),
  ];
  const [top] = aggregate(rows);
  assert.equal(top.file, "packages/daemon/test/task-squad-orchestration.integration.test.ts");
  assert.equal(top.count, 2);
  assert.equal(top.lastDate, "2026-11-06");
  const report = renderReport({
    repository: "owner/repo",
    decidedRuns: 40,
    since: "2026-10-25",
    rerunGreenRuns: 3,
    rows,
    generatedAt: "2026-11-08T00:00:00Z",
  });
  assert.match(report, /\*\*Rerun-green rate: 7\.5%\*\* \(3 of 40 runs that concluded success or failure\)/u);
  assert.match(report, /runs created since 2026-10-25/u);
  assert.match(
    report,
    /\| 2 \| 2026-11-06 \| `packages\/daemon\/test\/task-squad-orchestration\.integration\.test\.ts` \| test \|/u,
  );
  assert.match(report, /\| 1 \| 2026-11-05 \| `\(job:gui-build\)` \| unparsed \|/u);
});
