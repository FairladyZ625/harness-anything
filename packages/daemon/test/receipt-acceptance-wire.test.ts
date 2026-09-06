// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { validateReceiptAcceptance } from "../../kernel/src/index.ts";
import { validateReceiptAcceptanceWire } from "../src/protocol/daemon-protocol-validate-entities.ts";
import { validateDaemonGuiCommandReceipt } from "../src/protocol/daemon-protocol-validate-results.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

test("wire acceptance agrees with domain acceptance for committed receipts and negative controls", () => {
  const cut = { repoId: "repo", generation: 1, revision: 2, headDigest: `sha256:${"a".repeat(64)}` };
  const receipt: JsonObject = {
    opId: "op-2",
    outcome: "applied",
    status: "accepted_durable",
    acceptance: {
      storage: "sqlite",
      durability: "local_fsync",
      recordedAt: "2026-09-06T00:00:00Z",
      revisionFrom: 1,
      revisionTo: 2,
      memberOpIds: ["op-1", "op-2"],
      cut,
    },
    projection: { state: "verified", cut },
    git: { state: "verified", cut, commitSha: "b".repeat(40) },
    worktree: { state: "pending", cut: null, reason: "pending" },
    replica: { state: "not_configured", cut: null },
    wait: { state: "timed_out", unsatisfied: ["worktree_visible"] },
  };
  const check = (value: Readonly<Record<string, unknown>>, valid: boolean) => {
    const domain = validateReceiptAcceptance(value),
      wire = validateReceiptAcceptanceWire(value);
    assert.equal(domain.length === 0, valid, JSON.stringify(value));
    assert.deepEqual(wire, domain);
  };
  check(receipt, true);
  for (const status of ["rejected", "unknown"])
    check({ ...receipt, outcome: "op_rejected", status, acceptance: null }, true);
  const acceptance = receipt.acceptance as JsonObject;
  for (const changed of [
    { storage: "wal" },
    { durability: "buffered" },
    { recordedAt: "invalid" },
    { revisionFrom: 0 },
    { revisionFrom: 3 },
    { revisionTo: 1.5 },
    { revisionTo: Number.MAX_SAFE_INTEGER + 1 },
    { memberOpIds: ["op-1", "op-1"] },
    { memberOpIds: ["op-1", " "] },
    { memberOpIds: ["op-1"] },
    { memberOpIds: ["op-3", "op-4"] },
    { extra: true },
    { cut: { ...cut, revision: 1 } },
    { cut: { ...cut, generation: 2 } },
    { cut: { ...cut, repoId: " " } },
    { cut: { ...cut, headDigest: "sha256:bad" } },
    { cut: { ...cut, extra: true } },
  ])
    check({ ...receipt, acceptance: { ...acceptance, ...changed } }, false);
  for (const key of Object.keys(acceptance)) {
    const missing = { ...acceptance };
    delete missing[key];
    check({ ...receipt, acceptance: missing }, false);
  }
  check({ ...receipt, status: "unknown", acceptance: null }, false);
  check({ ...receipt, status: "rejected" }, false);
  check({ ...receipt, status: "invalid" }, false);
  for (const name of ["projection", "git", "worktree", "replica"]) {
    const facet = receipt[name] as JsonObject;
    for (const changed of [
      { extra: true },
      { reason: " " },
      { state: "invalid" },
      { state: "verified", cut: null },
      { state: "pending", cut },
      { cut: { ...cut, revision: -1 } },
    ])
      check({ ...receipt, [name]: { ...facet, ...changed } }, false);
  }
  check({ ...receipt, projection: { state: "not_configured", cut: null } }, false);
  check({ ...receipt, git: { state: "verified", cut, commitSha: "bad" } }, false);
  check({ ...receipt, git: { state: "pending", cut: null, commitSha: "b".repeat(40) } }, false);
  for (const wait of [
    { state: "satisfied", unsatisfied: ["git_verified"] },
    { state: "timed_out", unsatisfied: [] },
    { state: "timed_out", unsatisfied: ["made_up"] },
    { state: "satisfied", unsatisfied: [], extra: true },
  ])
    check({ ...receipt, wait }, false);
});

test("Decision wire fidelity follows the verified worktree cut independently of acceptance", () => {
  const cut = { repoId: "repo", generation: 1, revision: 2, headDigest: `sha256:${"a".repeat(64)}` },
    receipt = {
      schema: "command-receipt/v2",
      command: "decision-propose",
      ok: true,
      opId: "op-2",
      outcome: "applied",
      status: "accepted_durable",
      revision: 2,
      acceptance: {
        storage: "sqlite",
        durability: "local_fsync",
        recordedAt: "2026-09-06T00:00:00Z",
        revisionFrom: 2,
        revisionTo: 2,
        memberOpIds: ["op-2"],
        cut,
      },
      projection: { state: "verified", cut },
      git: { state: "pending", cut: null, commitSha: null },
      worktree: { state: "pending", cut: null },
      replica: { state: "not_configured", cut: null },
      visibility: "center",
      evidence: "decision",
      path: "decisions/decision.md",
      commitSha: null,
      documentSha256: "b".repeat(64),
      consentId: null,
      worktreeVisible: false,
      proof: { committedRevision: 2, appliedCut: 2, durable: true, canonicalVisible: true, worktreeVisible: false },
    };
  assert.deepEqual(validateDaemonGuiCommandReceipt(receipt), []);
  assert.ok(validateDaemonGuiCommandReceipt({ ...receipt, worktreeVisible: true }).length > 0);
  const verified = {
    ...receipt,
    worktreeVisible: true,
    proof: { ...receipt.proof, worktreeVisible: true },
    worktree: { state: "verified", cut },
  };
  assert.deepEqual(validateDaemonGuiCommandReceipt(verified), []);
  for (const wrongCut of [
    { ...cut, revision: 1 },
    { ...cut, repoId: "another" },
  ]) {
    assert.ok(
      validateDaemonGuiCommandReceipt({ ...verified, worktree: { state: "verified", cut: wrongCut } }).length > 0,
    );
    assert.deepEqual(
      validateDaemonGuiCommandReceipt({ ...receipt, worktree: { state: "verified", cut: wrongCut } }),
      [],
    );
  }
});
