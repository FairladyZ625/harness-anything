// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSteps, parseLocalCheckArgs, excludedBoundaryGateIds, selectQosPrefix } from "./run-local-check.mjs";

test("parseLocalCheckArgs defaults to the waiting fast tier", () => {
  assert.deepEqual(parseLocalCheckArgs([]), { full: false, wait: true, pollMs: 2000 });
});

test("parseLocalCheckArgs recognizes --full, --fast and --no-wait", () => {
  assert.equal(parseLocalCheckArgs(["--full"]).full, true);
  assert.equal(parseLocalCheckArgs(["--fast"]).full, false);
  assert.equal(parseLocalCheckArgs(["--no-wait"]).wait, false);
  // last tier flag wins
  assert.equal(parseLocalCheckArgs(["--full", "--fast"]).full, false);
});

test("parseLocalCheckArgs rejects unknown options", () => {
  assert.throws(() => parseLocalCheckArgs(["--bogus"]), /unknown run-local-check option/u);
});

test("buildSteps appends integration and gui lanes only in the full tier", () => {
  const fastScripts = buildSteps(false).map(([, script]) => script);
  const fullScripts = buildSteps(true).map(([, script]) => script);

  assert.ok(!fastScripts.includes("test:integration"));
  assert.ok(!fastScripts.includes("test:gui"));
  assert.ok(!fastScripts.includes("test:gui:e2e"));
  assert.ok(fullScripts.includes("test:integration"));
  assert.ok(fullScripts.includes("test:gui"));
  assert.ok(fullScripts.includes("test:gui:e2e"));
  assert.equal(fullScripts.length, fastScripts.length + 3);

  // Fast tier derives the CI boundaries + package-policy surface from the gate
  // manifest, so every deterministic checkPr gate in those jobs must be present.
  const manifest = JSON.parse(readFileSync(new URL("./gate-manifest.json", import.meta.url), "utf8"));
  const excluded = excludedBoundaryGateIds();
  const expectedScripts = manifest.gates
    .filter((gate) => {
      const surfaces = gate.executionSurfaces ?? {};
      const jobs = surfaces.rewriteCi?.pullRequestJobs ?? [];
      const pkg = surfaces.packageJson ?? {};
      return jobs.some((job) => job === "boundaries" || job === "package-policy")
        && !excluded.has(gate.id)
        && typeof pkg.script === "string" && pkg.checkPr === true && gate.deterministic === true;
    })
    .map((gate) => gate.executionSurfaces.packageJson.script);
  for (const script of expectedScripts) {
    assert.ok(fastScripts.includes(script), `missing manifest gate script: ${script}`);
  }
  assert.ok(fastScripts.includes("lint"));
  // Positive control: the gate PR #1358 slipped through on must be present.
  assert.ok(fastScripts.includes("harness:check-cli-help-contract"));
  // CI's boundaries exclusions must be honored locally too — and only those. The
  // rebuild lane used to exclude check-duplicate-definitions here; with all 50 groups
  // cleared the gate is back in CI, so it has to be back in the local set as well.
  assert.deepEqual([...excluded], ["mergify-queue-metadata-edit-noop"]);
  assert.ok(fastScripts.includes("harness:check-duplicate-definitions"));
  assert.deepEqual(fastScripts.slice(-2), ["check:local:derived-contracts", "check:local:schema-closure"]);
});

test("selectQosPrefix wraps with taskpolicy on darwin when available", () => {
  assert.deepEqual(
    selectQosPrefix({ platform: "darwin", hasTaskpolicy: true, hasNice: true }),
    ["taskpolicy", "-c", "utility"]
  );
});

test("selectQosPrefix falls back to nice off darwin or without taskpolicy", () => {
  assert.deepEqual(
    selectQosPrefix({ platform: "linux", hasTaskpolicy: false, hasNice: true }),
    ["nice", "-n", "10"]
  );
  assert.deepEqual(
    selectQosPrefix({ platform: "darwin", hasTaskpolicy: false, hasNice: true }),
    ["nice", "-n", "10"]
  );
});

test("selectQosPrefix runs bare when no QoS tool is available", () => {
  assert.deepEqual(
    selectQosPrefix({ platform: "linux", hasTaskpolicy: false, hasNice: false }),
    []
  );
});
