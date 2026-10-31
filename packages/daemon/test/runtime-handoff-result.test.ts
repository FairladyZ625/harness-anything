// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDaemonGuiActionResult } from "../src/protocol/gui-result-validation.ts";
import { runRuntimeHandoff } from "../src/runtime-handoff.ts";
import {
  assertHandoffClaim,
  runRuntimeHandoffAction,
  type RuntimeHandoffCheckpoint,
} from "../src/runtime-handoff-store.ts";
import type { RepoCellActionContext } from "../src/repo-cell-action-context.ts";
import { buildHandoffPacket } from "@harness-anything/kernel";

const dispatchId = `dispatch_${"a".repeat(24)}`;

test("a center-local repeated export returns the settled checkpoint receipt without its ingress event", (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "handoff-receipt-")),
    checkpoint: RuntimeHandoffCheckpoint = {
      dispatchId,
      taskId: "task-handoff",
      executionId: "execution-handoff",
      runtimeSessionId: "runtime_handoff",
      ownerPersonId: "person-owner",
      source: { kind: "local" },
      providerSessionId: "provider-session",
      commit: "a".repeat(40),
      version: "0.159.1",
      agentId: "handoff-agent",
      model: "gpt-5.6-sol",
      blob: { sha256: "b".repeat(64), size: 1, mediaType: "application/x-ndjson" },
      exportedAt: "2026-10-27T00:00:00.000Z",
      revokedAt: null,
    },
    local = path.join(rootDir, ".harness", "runtime-handoffs", dispatchId);
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nname: handoff-receipt\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  mkdirSync(local, { recursive: true });
  writeFileSync(path.join(local, "checkpoint.json"), JSON.stringify(checkpoint));

  const opId = `runtime-handoff-export-${dispatchId}`,
    event = {
      actor: { principal: { personId: "person-owner" } },
      source: { kind: "local" },
      payload: { runtimeSessionId: checkpoint.runtimeSessionId },
    },
    cell = {
      rootDir,
      requiredCellText: (value: unknown) => String(value),
      projection: { readRuntimeDispatchById: () => ({ event }) },
      appendAuxiliaryRuntimeIngress: () => ({
        outcome: "applied",
        opId,
        event: { type: "runtime_handoff_exported" },
      }),
      receiptForOperation: (requestedOpId: string) => ({
        outcome: "applied",
        opId: requestedOpId,
        revision: 2,
        evidence: `event-object:${requestedOpId}`,
      }),
    } as unknown as RepoCellActionContext,
    result = runRuntimeHandoffAction(
      cell,
      { kind: "runtime-handoff-export", dispatchId } as never,
      { actor: { principal: { personId: "person-owner" } }, source: { kind: "local" } } as never,
    );

  assert.equal(result.outcome, "applied");
  assert.equal(result.opId, opId);
  assert.equal(Object.hasOwn(result, "event"), false);
  assert.deepEqual(result.checkpoint, checkpoint);
});

test("handoff facade returns a declared command and the real rejected receipt code", async () => {
  const code = "runtime_dispatch_already_resumed",
    receipt = await runRuntimeHandoff({
      rootDir: "/unused",
      payload: {
        operation: "claim",
        dispatchId,
        runtimeInstanceId: "target-instance",
        prompt: "Continue the work.",
        dispatchKey: "center-local-retry",
      },
      command: async (action) => {
        assert.equal(action.kind, "runtime-handoff-claim");
        return {
          outcome: "op_rejected",
          opId: `rejected:${action.kind}`,
          code,
          origin: "daemon",
          evidence: `rejection:${code}`,
          rejectionExplanation: "The checkpoint has already been consumed.",
        };
      },
      spawn: async () => assert.fail("rejected claim must not launch a runtime"),
    });

  assert.equal(receipt.command, "runtime-handoff-claim");
  assert.equal(receipt.ok, false);
  assert.deepEqual(receipt.error, { code });
  assert.equal(parseDaemonGuiActionResult("repo.agentRuntime.handoff", receipt).code, code);
});

test("handoff claim rejects a packet whose causal content changed after export", () => {
  const built = buildHandoffPacket({
      handoffId: dispatchId,
      revision: 1,
      mode: "transfer",
      expiresAt: "2026-10-28T00:00:00.000Z",
      work: {
        id: "task-handoff",
        title: "Handoff",
        description: "Handoff",
        specRevision: 1,
        specDigest: "sha256:" + "a".repeat(64),
      },
      target: { employeeId: "next", name: "Next" },
    }),
    checkpoint: RuntimeHandoffCheckpoint = {
      dispatchId,
      taskId: "task-handoff",
      executionId: "execution-handoff",
      runtimeSessionId: "runtime_handoff",
      ownerPersonId: "person-owner",
      source: { kind: "local" },
      providerSessionId: "provider-session",
      commit: "a".repeat(40),
      version: "0.159.1",
      agentId: "handoff-agent",
      model: "gpt-5.6-sol",
      blob: { sha256: "b".repeat(64), size: 1, mediaType: "application/x-ndjson" },
      exportedAt: "2026-10-27T00:00:00.000Z",
      revokedAt: null,
      handoffPacket: { ...built.packet, goal: { ...built.packet.goal, title: "Changed" } },
      handoffPacketDigest: built.digest,
    };
  assert.throws(
    () => assertHandoffClaim({} as RepoCellActionContext, checkpoint, {} as never),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_handoff_payload_invalid",
  );
});

test("handoff claim rejects a self-consistent packet bound to another runtime", () => {
  const built = buildHandoffPacket({
      handoffId: "dispatch_" + "b".repeat(24),
      revision: 1,
      mode: "transfer",
      expiresAt: "2026-10-28T00:00:00.000Z",
      work: {
        id: "task-handoff",
        title: "Handoff",
        description: "Handoff",
        specRevision: 1,
        specDigest: "sha256:" + "a".repeat(64),
      },
      attempt: {
        id: "runtime-other",
        sessionId: "runtime-other",
        status: "succeeded",
      },
      sourceEmployeeId: "person-owner",
      target: { employeeId: "next", name: "Next" },
    }),
    checkpoint: RuntimeHandoffCheckpoint = {
      dispatchId,
      taskId: "task-handoff",
      executionId: "execution-handoff",
      runtimeSessionId: "runtime_handoff",
      ownerPersonId: "person-owner",
      source: { kind: "local" },
      providerSessionId: "provider-session",
      commit: "a".repeat(40),
      version: "0.159.1",
      agentId: "handoff-agent",
      model: "gpt-5.6-sol",
      blob: { sha256: "b".repeat(64), size: 1, mediaType: "application/x-ndjson" },
      exportedAt: "2026-10-27T00:00:00.000Z",
      revokedAt: null,
      handoffPacket: built.packet,
      handoffPacketDigest: built.digest,
    };
  assert.throws(
    () => assertHandoffClaim({} as RepoCellActionContext, checkpoint, {} as never),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_handoff_payload_invalid",
  );
});
