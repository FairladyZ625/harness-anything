// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("squad cancel routes a required run id through the daemon", () => {
  const parsed = parseThinCommand(["squad", "cancel", "squad_0123456789abcdef01234567"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.command.method, "repo.task.run");
    assert.deepEqual(parsed.command.action, {
      kind: "squad-cancel",
      squadRunId: "squad_0123456789abcdef01234567",
    });
  }
  assert.equal(parseThinCommand(["squad", "cancel"]).ok, false);
});
