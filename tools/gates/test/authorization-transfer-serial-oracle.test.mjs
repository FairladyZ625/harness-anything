// harness-test-tier: contract
// harness-test-file-timeout: 3600000
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import test from "node:test";
import { auditDurableActionAuthorization, loadAuthorizationInputs } from "../ontology-durable-action-authorization.mjs";

test("measure the complete independent serial authorization reference for draft 4705", async () => {
  const rootDir = process.cwd();
  const start = performance.now();
  const result = auditDurableActionAuthorization(rootDir, await loadAuthorizationInputs(rootDir));
  const digests = Object.fromEntries(
    Object.entries(result).map(([key, value]) => [key, hash("sha256", JSON.stringify(value))]),
  );
  console.log(
    "FULL_SERIAL_AUTHORIZATION",
    JSON.stringify({
      ms: Math.round(performance.now() - start),
      peakRssKiB: process.resourceUsage().maxRSS,
      rows: result.rows.length,
      sourceRows: result.sourceRows.length,
      digests,
    }),
  );
  assert.ok(result.rows.length > 0);
  assert.ok(result.sourceRows.length > 0);
  assert.deepEqual(result.findings, []);
});
