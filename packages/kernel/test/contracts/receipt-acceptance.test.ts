// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { attachReceiptAcceptance } from "../../src/composition/receipt-acceptance.ts";
import { validateWriteReceipt } from "../../src/domain/receipt-domain-registry.ts";
import { unsatisfiedReceiptPredicates, type ReceiptAcceptanceFields } from "../../src/domain/receipt-acceptance.ts";
import { validateReceiptAcceptance } from "../../src/domain/receipt-acceptance.ts";

const cut = { repoId: "repo", generation: 1, revision: 2, headDigest: `sha256:${"a".repeat(64)}` } as const;
const pending = { state: "pending", cut: null } as const;
const accepted: ReceiptAcceptanceFields = {
  status: "accepted_durable",
  acceptance: {
    storage: "sqlite",
    durability: "local_fsync",
    recordedAt: "2026-09-06T00:00:00Z",
    revisionFrom: 1,
    revisionTo: 2,
    memberOpIds: ["member", "command"],
    cut,
  },
  projection: { state: "verified", cut },
  git: { ...pending, commitSha: null },
  worktree: pending,
  replica: { state: "not_configured", cut: null },
};

test("public receipt requires explicit acceptance fields", () => {
  assert.match(validateWriteReceipt({ outcome: "applied", opId: "command" }).join("\n"), /receipt status is invalid/u);
});
test("D4 accepts a committed interval while Git and worktree remain pending", () => {
  assert.deepEqual(validateReceiptAcceptance({ ...accepted, opId: "command", outcome: "applied" }), []);
  assert.deepEqual(unsatisfiedReceiptPredicates(accepted, ["accepted_durable", "projection_visible", "git_verified"]), [
    "git_verified",
  ]);
});
test("D4 refuses applied before commit, invented intervals, and Git SHA without verified cut", () => {
  assert.match(
    validateReceiptAcceptance({ ...accepted, status: "unknown", acceptance: null, outcome: "applied" }).join("\n"),
    /applied requires/u,
  );
  assert.match(
    validateReceiptAcceptance({
      ...accepted,
      opId: "command",
      acceptance: { ...accepted.acceptance!, revisionFrom: 2 },
    }).join("\n"),
    /committed acceptance interval/u,
  );
  assert.match(
    validateReceiptAcceptance({ ...accepted, opId: "command", git: { ...pending, commitSha: "a".repeat(40) } }).join(
      "\n",
    ),
    /git must report/u,
  );
});
test("wait predicates require the same repository, generation and cut ancestry", () => {
  for (const wrong of [
    { ...cut, repoId: "other" },
    { ...cut, revision: 1 },
    { ...cut, headDigest: `sha256:${"b".repeat(64)}` },
  ])
    assert.deepEqual(
      unsatisfiedReceiptPredicates({ ...accepted, git: { state: "verified", cut: wrong, commitSha: "a".repeat(40) } }, [
        "git_verified",
      ]),
      ["git_verified"],
    );
  assert.deepEqual(
    unsatisfiedReceiptPredicates({ ...accepted, git: { state: "verified", cut, commitSha: "a".repeat(40) } }, [
      "git_verified",
      "worktree_visible",
    ]),
    ["worktree_visible"],
  );
});
test("wait timeout preserves durable acceptance and lists unsatisfied facets", () => {
  assert.deepEqual(
    validateReceiptAcceptance({
      ...accepted,
      opId: "command",
      wait: { state: "timed_out", unsatisfied: ["git_verified"] },
    }),
    [],
  );
  assert.match(
    validateReceiptAcceptance({
      ...accepted,
      opId: "command",
      wait: { state: "satisfied", unsatisfied: ["git_verified"] },
    }).join("\n"),
    /wait result/u,
  );
});

test("an intent-conflict rejection cannot borrow acceptance from the operation id's older command", () => {
  const receipt = attachReceiptAcceptance(
    {
      outcome: "op_rejected",
      opId: "command",
      code: "op_conflict",
      origin: "daemon",
      worktreeVisible: true,
      canonicalVisible: true,
    },
    {
      readCommandOutcome: () => ({
        status: "accepted_durable",
        firstRevision: 1,
        lastRevision: 2,
        memberOpIds: ["member", "command"],
      }),
      readEvent: () => {
        throw new Error("rejected invocation must not certify old accepted members");
      },
    } as never,
    {} as never,
  );
  assert.equal(receipt.outcome, "op_rejected");
  assert.equal(receipt.status, "rejected");
  assert.equal(receipt.acceptance, null);
  assert.equal(receipt.worktreeVisible, false);
  assert.equal(receipt.canonicalVisible, false);
  assert.deepEqual(validateReceiptAcceptance(receipt), []);
});
