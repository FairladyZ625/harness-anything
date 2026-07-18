// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { daemonActorAttributionForParsedCommand } from "../src/composition/actor-attribution.ts";

test("daemon derives preset ownership for a preset script-run id", () => {
  const attribution = daemonActorAttributionForParsedCommand({
    personId: "person_alice",
    displayName: "Alice",
    primaryEmail: "alice@example.test",
    roles: ["writer"],
    providerId: "forced-command",
    resolvedCredential: {
      kind: "ssh-forced-command-person",
      issuer: "test",
      subject: "person_alice"
    }
  }, {
    rootDir: "/repo",
    json: true,
    action: {
      kind: "script-run",
      scriptId: "preset:usage-acceptance:scaffold",
      taskId: "task_01TEST",
      inputs: {},
      dryRun: false
    }
  }, { kind: "agent", id: "client-self-report-must-be-ignored" });

  assert.deepEqual(attribution.executor, { kind: "agent", id: "preset:usage-acceptance" });
});
