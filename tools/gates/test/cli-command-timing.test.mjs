// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { evaluateCliCommandTiming, main } from "../cli-command-timing.mjs";
import { MEASURED_COMMANDS, NOOP_ID } from "../../measure-cli-command-timing.mjs";
import { captureGate, makeRepo, writeRepoFile } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const baselinePath = "tools/gates/cli-command-timing.json";
const ids = MEASURED_COMMANDS.map((command) => command.id).filter((id) => id !== NOOP_ID);

function baseline(limit) {
  return `${JSON.stringify({
    schema: "cli-command-timing-ratchet/v1",
    basisRevision: "a".repeat(40),
    baseline: NOOP_ID,
    limits: Object.fromEntries(ids.map((id) => [id, { maxTotalRatio: limit }])),
  })}\n`;
}

function measurement(ratio) {
  return `${JSON.stringify({
    schema: "cli-command-timing/v1",
    basisRevision: "b".repeat(40),
    commands: {
      [NOOP_ID]: { ratio: null },
      ...Object.fromEntries(ids.map((id) => [id, { ratio: { p50: ratio, p95: ratio, min: ratio, max: ratio } }])),
    },
  })}\n`;
}

test("committed CLI timing limits only shrink and a measurement may not exceed them", () => {
  assert.equal(captureGate(() => main(["--root", repoRoot, "--base", "origin/main", "--mode", "ratchet"])).code, 0);
  const { rootDir, base } = makeRepo({ [baselinePath]: baseline(2) });

  // A limit that rises is the whole failure mode this ratchet exists to stop: it would let a
  // regression be absorbed by editing the file that is supposed to detect it.
  writeRepoFile(rootDir, baselinePath, baseline(3));
  assert.match(
    evaluateCliCommandTiming({ rootDir, base }).findings.join("\n"),
    /agenda-read\.totalRatio: shrink-only baseline rose from 2x to 3x/u,
  );

  writeRepoFile(rootDir, baselinePath, baseline(1.5));
  assert.deepEqual(evaluateCliCommandTiming({ rootDir, base }).findings, []);

  writeRepoFile(rootDir, baselinePath, baseline(2));
  const measurementPath = path.join(rootDir, "measurement.json");
  writeRepoFile(rootDir, "measurement.json", measurement(2.5));
  assert.match(
    evaluateCliCommandTiming({ rootDir, base, measurementPath }).findings.join("\n"),
    /task-list\.totalRatio: measurement rose from 2x to 2\.5x/u,
  );
  const red = captureGate(() =>
    main(["--root", rootDir, "--base", base, "--measurement", measurementPath, "--mode", "ratchet"]),
  );
  assert.equal(red.code, 1);
  assert.match(red.stderr, /measurement rose from 2x to 2\.5x/u);

  writeRepoFile(rootDir, "measurement.json", measurement(1.75));
  assert.equal(
    captureGate(() => main(["--root", rootDir, "--base", base, "--measurement", measurementPath, "--mode", "ratchet"]))
      .code,
    0,
  );
});

test("CLI timing gate rejects a measurement whose ratio is missing or not a ratio", () => {
  const { rootDir, base } = makeRepo({ [baselinePath]: baseline(2) });
  const measurementPath = path.join(rootDir, "measurement.json");
  // A measurement produced against an uninstrumented CLI has no ratio to read. Failing closed here
  // is what keeps the negative control honest: silence must not read as a pass.
  writeRepoFile(
    rootDir,
    "measurement.json",
    `${JSON.stringify({ schema: "cli-command-timing/v1", commands: { "task-list": {} } })}\n`,
  );
  const failed = captureGate(() =>
    main(["--root", rootDir, "--base", base, "--measurement", measurementPath, "--mode", "ratchet"]),
  );
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /ratio\.p50 must be a positive number/u);
});
