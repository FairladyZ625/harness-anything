// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { authorityPlannerUnavailableHint } from "../src/commands/core/authority-planner-unavailable.ts";

test("missing authority planner preserves the active daemon until a replacement composition is verified", () => {
  const rendered = authorityPlannerUnavailableHint(
    "Task completion dry-run is blocked because the canonical authority planner is unavailable; no completion requirement was evaluated."
  );

  assert.equal(
    rendered,
    "Task completion dry-run is blocked because the canonical authority planner is unavailable; no completion requirement was evaluated. The active daemon requires the initialized canonical authority composition (authority manifest, harness/people.yaml, and authority key registry/key material). Next: run `ha daemon status --check --json` and inspect the loaded composition. Do not stop or restart the active daemon, and do not retry completion, until an operator has supplied and verified a replacement with the required authority manifest, people roster, and key material."
  );
});
