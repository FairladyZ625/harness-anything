// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as application from "../src/index.ts";

test("W3 removes session provenance materializers from the production application surface", () => {
  const applicationRoot = path.resolve(import.meta.dirname, "../src");
  for (const retired of [
    "current-session-probe.ts",
    "provenance-binding.ts",
    "provenance-session-exporter.ts",
    "runtime-session-logs.ts",
    "session-entity-reader.ts"
  ]) assert.equal(existsSync(path.join(applicationRoot, retired)), false, `${retired} must remain retired`);

  assert.equal("makeEnvironmentCurrentSessionProbe" in application, false);
  assert.equal("makeHumanFallbackSessionProbe" in application, false);
  assert.equal("currentSessionToProvenancePayload" in application, false);
  assert.equal(typeof application.makeTaskLifecycleService, "function");
});
