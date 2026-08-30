// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { evaluateGuiReadBaseline, main } from "../gui-read-baseline.mjs";
import { captureGate, makeRepo, writeRepoFile } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const baselinePath = "tools/gates/gui-read-baseline.json";
const ids = ["overview", "board", "graph", "sessions", "schedules", "agentSquad", "artifacts"];

function baseline(value) {
  return `${JSON.stringify({
    schema: "gui-read-ratchet/v1",
    basisRevision: "a".repeat(40),
    views: Object.fromEntries(
      ids.map((id) => [
        id,
        { requestCount: value, payloadBytes: value, maxE2eDurationMs: value, maxHandlerDurationMs: value },
      ]),
    ),
  })}\n`;
}

function measurement(value) {
  return `${JSON.stringify({
    schema: "gui-read-baseline/v1",
    views: Object.fromEntries(
      ids.map((id) => [
        id,
        { requestCount: value, payloadBytes: value, maxE2eDurationMs: value, maxHandlerDurationMs: value },
      ]),
    ),
  })}\n`;
}

test("GUI read gate rejects an upward ratchet and an observation over baseline", () => {
  assert.equal(captureGate(() => main(["--root", repoRoot, "--base", "origin/main", "--mode", "ratchet"])).code, 0);
  const { rootDir, base } = makeRepo({ [baselinePath]: baseline(5) });

  writeRepoFile(rootDir, baselinePath, baseline(6));
  const raised = evaluateGuiReadBaseline({ rootDir, base });
  assert.match(raised.findings.join("\n"), /overview\.requestCount: shrink-only baseline rose from 5 to 6/u);

  writeRepoFile(rootDir, baselinePath, baseline(5));
  const measurementPath = path.join(rootDir, "measurement.json");
  writeRepoFile(rootDir, "measurement.json", measurement(7));
  const observed = evaluateGuiReadBaseline({ rootDir, base, measurementPath });
  assert.match(observed.findings.join("\n"), /overview\.payloadBytes: measurement rose from 5 to 7/u);
  const positive = captureGate(() =>
    main(["--root", rootDir, "--base", base, "--measurement", measurementPath, "--mode", "ratchet"]),
  );
  assert.equal(positive.code, 1);
});
