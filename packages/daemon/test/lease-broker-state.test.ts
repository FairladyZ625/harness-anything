// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openFleetLeaseBroker } from "../src/lease-broker.ts";

test("completed commands persist receipts without copying them into coordination state", async () => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "ha-lease-broker-state-"));
  mkdirSync(stateRoot, { recursive: true });
  const assignment = {
      nodeId: "node-one",
      assignmentId: "assignment-one",
      repoId: "repo-one",
      scope: { kind: "task", taskId: "task-one", executionId: "execution-one", paths: [] },
      viewId: "view-one",
      expiresAt: "2099-01-01T00:00:00.000Z",
      actor: { principal: { personId: "person-one" }, executor: { kind: "agent", id: "agent-one" } },
    } as const,
    broker = openFleetLeaseBroker({
      stateRoot,
      host: { run: async () => ({ outcome: "applied", revision: 7, code: null }) as never },
      resolveAssignment: async () => assignment as never,
      now: () => "2026-09-13T00:00:00.000Z",
    });
  try {
    const result = await broker.handleTaskCommand(
      "node-one",
      {
        schema: "fleet.task.command/v1",
        assignmentId: assignment.assignmentId,
        repoId: assignment.repoId,
        taskId: null,
        opId: "op-one",
        action: { kind: "task-create", title: "One" },
        docChanges: null,
        mirrorBaseCut: null,
      } as never,
      () => false,
    );
    assert.equal(result.outcome, "applied");
    const coordination = JSON.parse(readFileSync(path.join(stateRoot, "leases.json"), "utf8")),
      receiptRing = JSON.parse(readFileSync(path.join(stateRoot, "lease-receipts.json"), "utf8"));
    assert.equal(coordination.receipts, undefined);
    assert.equal(receiptRing.receipts["op-one"].revision, 7);
  } finally {
    broker.close();
  }
});
