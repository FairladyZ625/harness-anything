// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDelegatedExecutionToken,
  verifyDelegatedExecutionToken,
  type DelegatedExecutionToken,
} from "../../src/domain/delegated-execution-token.ts";

const token: DelegatedExecutionToken = {
  schema: "delegated-execution-token/v1",
  tokenId: "det_offline_owner_1",
  issuer: { personId: "person_owner" },
  delegate: { runtimeSessionId: "runtime_1" },
  allowedActions: ["execution.start", "doc.submit"],
  issuedAt: "2026-08-27T02:00:00.000Z",
  expiresAt: "2026-08-27T03:00:00.000Z",
  revokedAt: null,
};

const actor = {
  principal: token.issuer,
  executor: { kind: "agent" as const, id: `runtime-session:${token.delegate.runtimeSessionId}` },
};

test("DelegatedExecutionToken is a closed ledger-verifiable principal delegation", () => {
  assert.deepEqual(parseDelegatedExecutionToken(token), {
    ...token,
    allowedActions: ["doc.submit", "execution.start"],
  });
  assert.throws(() => parseDelegatedExecutionToken({ ...token, allowedActions: [] }), /at least one allowed Action/u);
  assert.throws(
    () => parseDelegatedExecutionToken({ ...token, expiresAt: token.issuedAt }),
    /expiresAt must be later than issuedAt/u,
  );
  assert.throws(
    () => parseDelegatedExecutionToken({ ...token, bearerSecret: "not-ledger-safe" }),
    /unsupported fields: bearerSecret/u,
  );
});

test("token proof binds principal, RuntimeSession, Action scope, expiry, and revocation", () => {
  assert.deepEqual(verifyDelegatedExecutionToken(token, actor, "doc.submit", "2026-08-27T02:30:00.000Z"), { ok: true });
  assert.equal(
    verifyDelegatedExecutionToken(token, actor, "task.complete", "2026-08-27T02:30:00.000Z").reasonCode,
    "delegated_token_action_forbidden",
  );
  assert.equal(
    verifyDelegatedExecutionToken(
      token,
      { ...actor, principal: { personId: "person_other" } },
      "doc.submit",
      "2026-08-27T02:30:00.000Z",
    ).reasonCode,
    "delegated_token_actor_mismatch",
  );
  assert.equal(
    verifyDelegatedExecutionToken(token, actor, "doc.submit", token.expiresAt).reasonCode,
    "delegated_token_expired",
  );
  assert.equal(
    verifyDelegatedExecutionToken(
      { ...token, revokedAt: "2026-08-27T02:20:00.000Z" },
      actor,
      "doc.submit",
      "2026-08-27T02:30:00.000Z",
    ).reasonCode,
    "delegated_token_revoked",
  );
});
