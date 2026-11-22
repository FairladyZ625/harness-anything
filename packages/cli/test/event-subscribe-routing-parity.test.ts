// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("event subscribe sends numeric cursor, limit and wait fields to the repository read route", () => {
  const after = ["event", "subscribe", "--after-revision", "17", "--limit", "2", "--wait-ms", "25000"];
  const parsed = parseThinCommand(after);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok) {
    assert.equal(parsed.command.method, "repo.events.read");
    assert.equal(parsed.command.json, true);
    assert.deepEqual(parsed.command.action, { kind: "event-subscribe", afterRevision: 17, limit: 2, waitMs: 25_000 });
  }
  assert.equal(parseThinCommand(["event", "subscribe", "--limit", "2"]).ok, false);
  assert.equal(parseThinCommand(["event", "subscribe", "--after-revision", "0", "--limit", "501"]).ok, false);
});
