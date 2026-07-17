// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatResultLine, parseMainWatchArgs, resolveCommitSha, watchMain } from "./main-watch.mjs";

const knownFlake = "daemon start service status and stop expose productized status contract";
const failedLog = readFileSync(
  new URL("./fixtures/main-watch/run-29513133791-failed.txt", import.meta.url),
  "utf8"
);

test("a short merge SHA resolves to its full local commit SHA", () => {
  const fullSha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const shortSha = fullSha.slice(0, 8);

  assert.equal(parseMainWatchArgs([shortSha]).commitSha, shortSha);
  assert.equal(resolveCommitSha(shortSha), fullSha);
});

test("a completed main run is a flake when every failing test exactly matches the registry", async () => {
  const result = await watchMain({
    commitSha: "37d234863f1bb06b7fa33e511d1558bc1394dc77",
    registry: { entries: [{ testName: knownFlake }] },
    github: {
      listRuns: async () => [{
        databaseId: 29513133791,
        event: "push",
        headSha: "37d234863f1bb06b7fa33e511d1558bc1394dc77",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/FairladyZ625/harness-anything/actions/runs/29513133791"
      }],
      readFailedLogs: async () => failedLog
    }
  });

  assert.deepEqual(result, {
    code: 20,
    classification: "flake",
    runUrl: "https://github.com/FairladyZ625/harness-anything/actions/runs/29513133791",
    failingTests: [knownFlake]
  });
});

test("one unregistered failing test classifies the whole run as a regression", async () => {
  const unknownFailure = "a newly introduced test failure";
  const mixedLog = `${failedLog}\nfull-check (24)\tRun npm run check\t2026-07-16T16:13:54Z\t✖ failing tests:\n` +
    `full-check (24)\tRun npm run check\t2026-07-16T16:13:54Z\ttest at tools/example.test.mjs:1:1\n` +
    `full-check (24)\tRun npm run check\t2026-07-16T16:13:54Z\t✖ ${unknownFailure} (1.25ms)\n`;
  const result = await watchMain({
    commitSha: "37d234863f1bb06b7fa33e511d1558bc1394dc77",
    registry: { entries: [{ testName: knownFlake }] },
    github: {
      listRuns: async () => [{
        databaseId: 29513133791,
        event: "push",
        headSha: "37d234863f1bb06b7fa33e511d1558bc1394dc77",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/FairladyZ625/harness-anything/actions/runs/29513133791"
      }],
      readFailedLogs: async () => mixedLog
    }
  });

  assert.equal(result.code, 30);
  assert.equal(result.classification, "regression");
  assert.deepEqual(result.failingTests, [knownFlake, unknownFailure]);
});

test("a successful completed main run is green without reading failure logs", async () => {
  const result = await watchMain({
    commitSha: "37d234863f1bb06b7fa33e511d1558bc1394dc77",
    registry: { entries: [{ testName: knownFlake }] },
    github: {
      listRuns: async () => [{
        databaseId: 1,
        event: "push",
        headSha: "37d234863f1bb06b7fa33e511d1558bc1394dc77",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/example/repo/actions/runs/1"
      }],
      readFailedLogs: async () => assert.fail("green runs have no failed logs to read")
    }
  });

  assert.deepEqual(result, {
    code: 0,
    classification: "green",
    runUrl: "https://github.com/example/repo/actions/runs/1",
    failingTests: []
  });
});

test("a cancelled completed main run is superseded instead of a regression", async () => {
  const result = await watchMain({
    commitSha: "9e447b2a9b1726d8e81c91105e41699599c0b789",
    registry: { entries: [] },
    github: {
      listRuns: async () => [{
        databaseId: 29544075307,
        event: "push",
        headSha: "9e447b2a9b1726d8e81c91105e41699599c0b789",
        status: "completed",
        conclusion: "cancelled",
        createdAt: "2026-07-17T01:00:00Z",
        url: "https://github.com/example/repo/actions/runs/29544075307"
      }],
      listNewerMainRuns: async () => [{
        databaseId: 29544075308,
        createdAt: "2026-07-17T01:01:00Z",
        url: "https://github.com/example/repo/actions/runs/29544075308"
      }],
      readFailedLogs: async () => assert.fail("cancelled runs have no failure logs to read")
    }
  });

  assert.deepEqual(result, {
    code: 50,
    classification: "superseded",
    runUrl: "https://github.com/example/repo/actions/runs/29544075307",
    failingTests: [],
    supersedingRunUrl: "https://github.com/example/repo/actions/runs/29544075308"
  });
  assert.equal(formatResultLine(result),
    "RESULT: 50 superseded https://github.com/example/repo/actions/runs/29544075307 https://github.com/example/repo/actions/runs/29544075308");
});

test("a startup failure is unavailable instead of a regression", async () => {
  const result = await watchMain({
    commitSha: "37d234863f1bb06b7fa33e511d1558bc1394dc77",
    registry: { entries: [] },
    github: {
      listRuns: async () => [{
        databaseId: 9,
        event: "push",
        headSha: "37d234863f1bb06b7fa33e511d1558bc1394dc77",
        status: "completed",
        conclusion: "startup_failure",
        url: "https://github.com/example/repo/actions/runs/9"
      }],
      listNewerMainRuns: async () => assert.fail("only cancelled runs look for a superseding run"),
      readFailedLogs: async () => assert.fail("startup failures have no failure logs to read")
    }
  });

  assert.deepEqual(result, {
    code: 40,
    classification: "unavailable",
    runUrl: "https://github.com/example/repo/actions/runs/9",
    failingTests: []
  });
});

test("a missing run is polled until timeout and exits unavailable", async () => {
  let now = 0;
  let polls = 0;
  const result = await watchMain({
    commitSha: "37d234863f1bb06b7fa33e511d1558bc1394dc77",
    registry: { entries: [{ testName: knownFlake }] },
    intervalMs: 50,
    timeoutMs: 100,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    github: {
      listRuns: async () => { polls += 1; return []; },
      readFailedLogs: async () => assert.fail("a missing run has no logs")
    }
  });

  assert.equal(polls, 3);
  assert.deepEqual(result, {
    code: 40,
    classification: "timeout",
    runUrl: "-",
    failingTests: []
  });
});

test("the CLI prints a machine-readable flake result and exits 20", { skip: process.platform === "win32" }, (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-main-watch-"));
  const binDir = path.join(rootDir, "bin");
  const ghPath = path.join(binDir, "gh");
  mkdirSync(binDir);
  writeFileSync(ghPath, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'run' && args[1] === 'list') {",
    "  process.stdout.write(JSON.stringify([{ databaseId: 29513133791, event: 'push', headSha: '37d234863f1bb06b7fa33e511d1558bc1394dc77', status: 'completed', conclusion: 'failure', url: 'https://github.com/FairladyZ625/harness-anything/actions/runs/29513133791' }]));",
    "} else if (args[0] === 'run' && args[1] === 'view') {",
    "  process.stdout.write(fs.readFileSync(process.env.MAIN_WATCH_TEST_LOG, 'utf8'));",
    "} else {",
    "  process.stderr.write(`unexpected gh args: ${args.join(' ')}`);",
    "  process.exitCode = 1;",
    "}",
    ""
  ].join("\n"), "utf8");
  chmodSync(ghPath, 0o755);
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [
    "tools/main-watch.mjs",
    "37d234863f1bb06b7fa33e511d1558bc1394dc77",
    "--repo",
    "FairladyZ625/harness-anything",
    "--dry-run"
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      MAIN_WATCH_TEST_LOG: path.resolve(import.meta.dirname, "fixtures/main-watch/run-29513133791-failed.txt"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
    }
  });

  assert.equal(result.status, 20, result.stderr);
  assert.equal(result.stdout.trim().split("\n").at(-1),
    `RESULT: 20 flake https://github.com/FairladyZ625/harness-anything/actions/runs/29513133791 ${knownFlake}`);
});

test("an opaque failed job keeps an otherwise registered run in regression classification", async () => {
  const logWithOpaqueFailure = `${failedLog}\nboundaries\tRun checker\t2026-07-16T16:14:00Z\tchecker stopped before Node test output\n` +
    "boundaries\tRun checker\t2026-07-16T16:14:01Z\t##[error]Process completed with exit code 1.\n";
  const result = await watchMain({
    commitSha: "37d234863f1bb06b7fa33e511d1558bc1394dc77",
    registry: { entries: [{ testName: knownFlake }] },
    github: {
      listRuns: async () => [{
        databaseId: 29513133791,
        event: "push",
        headSha: "37d234863f1bb06b7fa33e511d1558bc1394dc77",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/FairladyZ625/harness-anything/actions/runs/29513133791"
      }],
      readFailedLogs: async () => logWithOpaqueFailure
    }
  });

  assert.equal(result.code, 30);
  assert.equal(result.classification, "regression");
  assert.deepEqual(result.failingTests, [knownFlake]);
});

test("run selection ignores a pull request run even when it is listed first", async () => {
  const commitSha = "37d234863f1bb06b7fa33e511d1558bc1394dc77";
  const result = await watchMain({
    commitSha,
    registry: { entries: [{ testName: knownFlake }] },
    github: {
      listRuns: async () => [
        {
          databaseId: 1,
          event: "pull_request",
          headSha: commitSha,
          status: "completed",
          conclusion: "success",
          url: "https://github.com/example/repo/actions/runs/1"
        },
        {
          databaseId: 29513133791,
          event: "push",
          headSha: commitSha,
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/FairladyZ625/harness-anything/actions/runs/29513133791"
        }
      ],
      readFailedLogs: async () => failedLog
    }
  });

  assert.equal(result.code, 20);
  assert.equal(result.runUrl, "https://github.com/FairladyZ625/harness-anything/actions/runs/29513133791");
});

test("dry-run reports a missing run after one read instead of polling", async () => {
  let polls = 0;
  const result = await watchMain({
    commitSha: "37d234863f1bb06b7fa33e511d1558bc1394dc77",
    registry: { entries: [{ testName: knownFlake }] },
    dryRun: true,
    sleep: async () => assert.fail("dry-run must not sleep"),
    github: {
      listRuns: async () => { polls += 1; return []; },
      readFailedLogs: async () => assert.fail("a missing run has no logs")
    }
  });

  assert.equal(polls, 1);
  assert.deepEqual(result, {
    code: 40,
    classification: "run-missing",
    runUrl: "-",
    failingTests: []
  });
});
