// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand, renderThinHelp, thinCliCommands } from "../src/cli/thin-command.ts";

test("thin command directory renders every supported user command", () => {
  const help = renderThinHelp();
  assert.equal(thinCliCommands.length, 13);
  for (const command of thinCliCommands) assert.match(help, new RegExp(command.usage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(help, /daemon serve|fact record|doc sync/u);
});

test("thin parser exposes only contracted task lifecycle and receipt reads", () => {
  assert.equal(parseThinCommand(["fact", "record", "--text", "legacy"]).ok, false);
  assert.equal(parseThinCommand(["doc", "sync"]).ok, false);
  const create = parseThinCommand(["task", "create", "--title", "Bound", "--completion-gate", "G32"]);
  assert.equal(create.ok, true); if (create.ok) assert.deepEqual(create.command.action.completionGateIds, ["G32"]);
});

test("thin parser exposes daemon-backed workspace bootstrap", () => {
  const parsed = parseThinCommand(["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.command.action, {
    kind: "repo-bootstrap", repoId: "alpha", personId: "owner", displayName: "Owner"
  });
  assert.equal(parseThinCommand(["init", "--repo-id", "alpha", "--person-id", "owner"]).ok, false);
});

test("thin parser rejects malformed completion receipts instead of throwing", () => {
  const parsed = parseThinCommand(["task", "complete", "task-1", "--execution-id", "exec-1", "--gate-receipt", "missing-separator"]);
  assert.deepEqual(parsed, { ok: false, code: "invalid_field", nextAction: "Use --gate-receipt <gate-id>:<receipt-ref>.", json: false });
});
