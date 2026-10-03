// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openFleetLeaseBroker } from "../src/lease-broker.ts";
import { FleetFault } from "../src/fleet/center-types.ts";
import { verifyOwnedClaims } from "../src/fleet/center-lease-claims.ts";

test("claim ownership requires the complete staged descriptor", () => {
  const descriptor = {
      ref: "doc-sync-claims/claim-one",
      sha256: "a".repeat(64),
      size: 4,
      mediaType: "text/plain",
    },
    context = {
      state: {
        uploads: {
          upload: {
            nodeId: "node-one",
            assignmentId: "assignment-one",
            repoId: "repo-one",
            content: descriptor,
            descriptor,
          },
        },
      },
      persist: () => undefined,
      FleetFault,
      safeLocal: () => "",
      uploadPath: () => "",
    };

  verifyOwnedClaims(context, "node-one", "assignment-one", [{ candidate: descriptor }]);
  assert.throws(
    () =>
      verifyOwnedClaims(context, "node-one", "assignment-one", [
        { candidate: { ...descriptor, sha256: "b".repeat(64) } },
      ]),
    (error: unknown) => error instanceof FleetFault && error.code === "claim_not_owned",
  );
});

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
    } as const,
    broker = openFleetLeaseBroker({
      stateRoot,
      host: { run: async () => ({ outcome: "applied", revision: 7, code: null }) as never },
      resolveAssignment: async () => assignment as never,
      auth: async (binding) => ({
        peer: { transport: "tls", nodeId: binding.nodeId },
        assignmentBinding: binding,
        nodePrincipal: { nodeId: binding.nodeId, personId: "person-one" },
      }),
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

for (const revoked of [true, false])
  test(`delivery preparation rechecks ${revoked ? "assignment before enqueue" : "authorization after transfer"}`, async () => {
    const stateRoot = mkdtempSync(path.join(tmpdir(), "ha-delivery-broker-"));
    const assignment = {
      nodeId: "node-one",
      assignmentId: "assignment-one",
      repoId: "repo-one",
      scope: { kind: "task", taskId: "task-one", executionId: "execution-one", paths: ["tasks"] },
      viewId: "view-one",
      expiresAt: "2099-01-01T00:00:00.000Z",
    } as const;
    let transferred = false,
      writes = 0,
      changed = false;
    const broker = openFleetLeaseBroker({
      stateRoot,
      resolveAssignment: () => (revoked && changed ? null : assignment),
      now: () => "2026-10-03T00:00:00.000Z",
      auth: async () => {
        if (changed) throw Object.assign(new Error("owner changed during transfer"), { code: "authorization_denied" });
        return {};
      },
      prepareTaskSubmit: async (_assignment, action) => {
        transferred = true;
        changed = true;
        return action;
      },
      host: {
        run: async (_repo, action) => {
          if (action.kind === "task-show")
            return {
              outcome: "applied",
              evidence: JSON.stringify({
                lease: {
                  executionId: "execution-one",
                  phase: "held",
                  expiresAt: assignment.expiresAt,
                  source: { kind: "assignment", nodeId: assignment.nodeId, assignmentId: assignment.assignmentId },
                },
              }),
            } as never;
          writes += 1;
          return { outcome: "applied" } as never;
        },
      },
    });
    try {
      const result = broker.handleTaskCommand(
        assignment.nodeId,
        {
          schema: "fleet.task.command/v1",
          assignmentId: assignment.assignmentId,
          repoId: assignment.repoId,
          taskId: assignment.scope.taskId,
          action: { kind: "task-submit", taskId: assignment.scope.taskId },
          opId: "delivery-one",
          docChanges: null,
          mirrorBaseCut: null,
        } as never,
        () => false,
      );
      if (revoked) assert.equal((await result).code, "assignment_rejected");
      else await assert.rejects(result, /owner changed during transfer/u);
      assert.equal(transferred, true);
      assert.equal(writes, 0, "no submission enters the repository queue on stale early authorization");
    } finally {
      broker.close();
    }
  });
