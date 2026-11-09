// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  checkDispatchLifecycleObservationSites,
  scanDispatchLifecycleObservationSites,
} from "../../check-domain-judgment-single-definition.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../.."),
  baselinePath = path.join(repoRoot, "tools/gate-allowlists/dispatch-lifecycle-observation.json"),
  addedSitePath = path.join(import.meta.dirname, "fixtures/dispatch-lifecycle-observation-added-site.json");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

test("dispatch lifecycle baseline matches the live tree and may only shrink", () => {
  const baseline = readJson(baselinePath),
    fixture = readJson(addedSitePath),
    liveSites = scanDispatchLifecycleObservationSites(repoRoot),
    addedSites = fixture.entries.observationSites;

  assert.equal(baseline.schema, "harness-anything/gate-allowlist/v1");
  assert.ok(Array.isArray(baseline.entries.observationSites));
  assert.ok(baseline.entries.observationSites.length > 0);
  assert.equal(addedSites.length, 1);

  // The checked-in baseline is the exact debt inventory: every live site is declared and every
  // declared site still exists. A stale missing baseline entry is refused by the same call.
  assert.deepEqual(checkDispatchLifecycleObservationSites(liveSites, baseline), []);

  // Expanding the baseline (the fixture row is the new judgment) must turn red.
  const expanded = {
    ...baseline,
    entries: { observationSites: [...baseline.entries.observationSites, ...addedSites] },
  };
  const refused = checkDispatchLifecycleObservationSites(liveSites, expanded, baseline.entries.observationSites);
  assert.ok(
    refused.some((finding) => finding.includes("baseline may only shrink")),
    refused.join("\n"),
  );
  assert.ok(
    refused.some((finding) => finding.includes("fixture-new-observation.ts")),
    refused.join("\n"),
  );

  // Reducing against that expanded prior baseline is allowed.
  assert.deepEqual(checkDispatchLifecycleObservationSites(liveSites, baseline, expanded.entries.observationSites), []);
});
