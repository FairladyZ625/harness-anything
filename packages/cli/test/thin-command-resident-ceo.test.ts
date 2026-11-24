// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("peer delegate CLI compiles to the canonical PeerRequest ask action", () => {
  const parsed = parseThinCommand(["peer", "delegate", "--to", "person_bob", "--title", "Review the migration"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.command.method, "repo.task.run");
  assert.deepEqual(parsed.command.action, {
    kind: "peer-ask",
    requestKind: "delegate",
    toPersonId: "person_bob",
    summary: "Review the migration",
  });
});

test("resident CEO config CLI carries the selected instance, model, and heartbeat interval", () => {
  const parsed = parseThinCommand([
    "ceo",
    "config",
    "--instance",
    "instance_owner",
    "--model",
    "model-a",
    "--heartbeat-interval-sec",
    "600",
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.command.method, "repo.residentCeo.config");
  assert.deepEqual(parsed.command.action, {
    kind: "ceo-config",
    runtimeInstanceId: "instance_owner",
    model: "model-a",
    heartbeatIntervalSec: 600,
  });
});
