// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { DaemonAdmissionBudget } from "@harness-anything/kernel";
import { runWithAuthorityAdmission } from "../src/authority/admission.ts";

const identity = { workspaceId: "workspace-admission", opId: "op-admission" };

test("authority forced-command reports temporary capacity pressure as retryable", async () => {
  let temporarilyFull = true;
  const budget: DaemonAdmissionBudget = {
    reserve: () => temporarilyFull
      ? {
        ok: false,
        error: {
          _tag: "WriteRejected",
          code: "admission_overloaded",
          reason: "Shared daemon admission budget is full. Run 'ha daemon status --json', wait for current writes to settle, then retry the exact command.",
          retryable: true
        }
      }
      : { ok: true, reservation: { release: () => undefined } },
    snapshot: () => ({
      limits: { maxOperations: 2, maxBytes: 200, reservedOperationsPerPlane: 0, reservedBytesPerPlane: 0 },
      used: { operations: 0, bytes: 0, authorityOperations: 0, authorityBytes: 0, jsonRpcOperations: 0, jsonRpcBytes: 0 },
      rejected: { authority: temporarilyFull ? 1 : 0, "json-rpc": 0 }
    })
  };

  const receipt = await runWithAuthorityAdmission({
    budget,
    identity,
    semanticDigest: "digest-temporary",
    bytes: 100,
    work: () => Promise.reject(new Error("rejected work must not run"))
  });

  assert.deepEqual(receipt, {
    tag: "RETRYABLE_NOT_COMMITTED",
    workspaceId: identity.workspaceId,
    opId: identity.opId,
    semanticDigest: "digest-temporary",
    reason: "Shared daemon admission budget is full. Run 'ha daemon status --json', wait for current writes to settle, then retry the exact command."
  });
  temporarilyFull = false;
  const retried = await runWithAuthorityAdmission({
    budget,
    identity,
    semanticDigest: "digest-temporary",
    bytes: 100,
    work: async () => ({
      tag: "REJECTED",
      workspaceId: identity.workspaceId,
      opId: identity.opId,
      semanticDigest: "digest-temporary",
      reason: "fixture reached work"
    })
  });
  assert.equal(retried.reason, "fixture reached work");
});

test("authority forced-command reports a permanently oversized payload as non-retryable", async () => {
  const budget: DaemonAdmissionBudget = {
    reserve: () => ({
      ok: false,
      error: {
        _tag: "WriteRejected",
        code: "admission_payload_exceeds_limit",
        reason: "Shared daemon admission payload exceeds the per-request limit (operations: requested 1, limit 1; bytes: requested 101, limit 100). Split the batch or reduce the payload, then submit each smaller request.",
        retryable: false
      }
    }),
    snapshot: () => ({
      limits: { maxOperations: 2, maxBytes: 200, reservedOperationsPerPlane: 1, reservedBytesPerPlane: 100 },
      used: { operations: 0, bytes: 0, authorityOperations: 0, authorityBytes: 0, jsonRpcOperations: 0, jsonRpcBytes: 0 },
      rejected: { authority: 2, "json-rpc": 0 }
    })
  };
  const expected = {
    tag: "REJECTED",
    workspaceId: identity.workspaceId,
    opId: identity.opId,
    semanticDigest: "digest-oversized",
    reason: "Shared daemon admission payload exceeds the per-request limit (operations: requested 1, limit 1; bytes: requested 101, limit 100). Split the batch or reduce the payload, then submit each smaller request."
  } as const;
  const request = () => runWithAuthorityAdmission({
    budget,
    identity,
    semanticDigest: "digest-oversized",
    bytes: 101,
    work: () => Promise.reject(new Error("oversized work must not run"))
  });

  assert.deepEqual(await request(), expected);
  assert.deepEqual(await request(), expected);
});
