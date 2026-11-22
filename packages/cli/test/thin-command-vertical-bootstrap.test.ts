// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { validateDaemonRpcCall } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("ha init forwards --vertical and --preset flags through daemon.repo.bootstrap", () => {
  const parsed = parseThinCommand(["init", "--vertical", "office/collab", "--preset", "deliverable-task"], "/repo");
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok) {
    assert.deepEqual(parsed.command.action, {
      kind: "repo-bootstrap",
      vertical: "office/collab",
      preset: "deliverable-task",
    });
    const { kind: _kind, ...params } = parsed.command.action;
    assert.deepEqual(
      validateDaemonRpcCall({ method: "daemon.repo.bootstrap", params: { rootDir: "/repo", ...params } }),
      [],
    );
  }
});

test("ha work create omits hardcoded presetId so the daemon resolves the active vertical work preset", () => {
  const parsed = parseThinCommand(["work", "create", "--title", "Ops Plan", "--decision", "dec_ops/CH1"], "/repo");
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok) {
    assert.equal(parsed.command.action.kind, "task-create");
    assert.equal(parsed.command.action.taskClass, "work");
    assert.equal(parsed.command.action.requirePlan, true);
    assert.equal("presetId" in parsed.command.action, false);
  }
});
