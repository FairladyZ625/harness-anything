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

test("dispatch lifecycle boundary has no live business observations or baseline exemptions", () => {
  const baseline = readJson(baselinePath),
    fixture = readJson(addedSitePath),
    liveSites = scanDispatchLifecycleObservationSites(repoRoot);
  assert.equal(baseline.schema, "harness-anything/gate-allowlist/v1");
  assert.deepEqual(baseline.entries.observationSites, []);
  assert.deepEqual(liveSites, []);
  assert.deepEqual(checkDispatchLifecycleObservationSites(liveSites, baseline), []);
  assert.ok(
    checkDispatchLifecycleObservationSites(liveSites, fixture).some((finding) => finding.includes("zero exemptions")),
  );
  assert.ok(checkDispatchLifecycleObservationSites([], null).some((finding) => finding.includes("invalid or missing")));
});

// dec_AEB05951 CH4/CH6 slice 7 closes the debt inventory permanently.
test("a matching baseline cannot exempt a second lifecycle judgment", () => {
  const fixture = readJson(addedSitePath),
    sites = fixture.entries.observationSites;
  const findings = checkDispatchLifecycleObservationSites(sites, fixture);
  assert.ok(
    findings.some((finding) => finding.includes("zero exemptions")),
    findings.join("\n"),
  );
  assert.ok(
    findings.some((finding) => finding.includes("fixture-new-observation.ts")),
    findings.join("\n"),
  );
});
