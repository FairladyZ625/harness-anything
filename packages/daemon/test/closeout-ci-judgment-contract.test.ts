// harness-test-tier: fast
/**
 * `completion.ci` used to be pinned to the literal "passed" for every closeout. Four presets
 * (docs-task, code-impact-analysis, subtask-expansion, architecture-rot-audit) declare
 * `completionGates: []`, so their changes carry no CI run at all -- and the only value that
 * passed the validator was a fabricated CI judgment, exactly what its own hint claimed to
 * prevent. The legal value is now a function of the task contract, in both directions:
 *
 *   completionGateIds includes "ci"  ->  only "passed"          (a declared gate needs a real green run)
 *   completionGateIds omits  "ci"    ->  only "not_applicable"  (no run exists for "passed" to refer to)
 *
 * Reverting either direction in task-closeout-action.ts turns this file red.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ActorIdentity, WriteReceipt } from "../../kernel/src/index.ts";
import { runTaskCloseoutAction } from "../../application/src/task-closeout-action.ts";
import { readWorkspaceText } from "../src/workspace-text-port.ts";

const taskId = "task-ci-judgment", executionId = "execution-ci-judgment", commitSha = "b".repeat(40);
const person: ActorIdentity = { principal: { personId: "owner" }, executor: { kind: "agent", id: "owner-agent" } };
const submission = { completionClaim: "Docs only.", deliverables: ["report"], outputs: ["artifact"], verificationNotes: ["read"], knownGaps: [], residualRisks: [], commitSha };

/** A docs-shaped judgment packet whose CI posture the caller chooses, so both postures meet both contracts. */
function packet(ci: string) { return { submission, review: { verdict: "approved", reason: "Reviewed.", evidenceChecked: ["report"] }, consent: { approved: true }, completion: { ci, codeDocPaths: [] } }; }
/** completionGateIds is the whole point of the fixture: it is preset-owned and fixed at task creation. */
function fixture(completionGateIds: readonly string[]) {
  return { revision: 2, task: { schema: "task/v1", taskId, title: "CI judgment", taskClass: "standard", status: "active", graph: { maxIterations: 1, nodes: [], edges: [] }, currentNode: "implementation", iteration: 0, createdBy: person, completionGateIds, presetSnapshotDigest: null },
    executions: [{ schema: "execution/v1", executionId, taskId, nodeId: "implementation", iteration: 0, state: "active", actor: person, claimedAt: "2026-08-24T00:00:00.000Z", submittedAt: null, closedAt: null, submission: null }],
    reviews: [], consents: [], codeDocWitnesses: [], gateWitnesses: [], edgesTaken: [], lease: { schema: "lease/v1", taskId, executionId, actor: person, source: "local", phase: "held", expiresAt: "2026-08-24T01:00:00.000Z", ttlMs: 1, version: 0 }, decisionRelations: [] };
}
async function closeout(completionGateIds: readonly string[], ci: string) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-closeout-ci-")), fromFile = "judgment.json", completeCalls: Array<Readonly<Record<string, unknown>>> = [];
  writeFileSync(path.join(rootDir, fromFile), JSON.stringify(packet(ci)));
  try {
    const receipt = await runTaskCloseoutAction({ rootDir, action: { kind: "task-closeout", taskId, fromFile }, caller: person, opId: "op-ci-judgment", readWorkspaceText,
      read: async () => fixture(completionGateIds) as never,
      invoke: async (stage, action) => { if (stage === "complete") completeCalls.push(action); return { outcome: "applied", opId: `op-${stage}`, revision: 3, evidence: `event:${stage}`, visibility: "center", proof: { committedRevision: 3, appliedCut: 3, durable: true, canonicalVisible: true, worktreeVisible: true } } as WriteReceipt; } });
    return { receipt, completeCalls };
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
}

test("a task whose contract declares no ci gate closes out on the honest not_applicable", async () => {
  const { receipt } = await closeout([], "not_applicable");
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
});

test("a task whose contract declares no ci gate cannot invent a passing CI judgment", async () => {
  const { receipt } = await closeout([], "passed");
  assert.equal(receipt.outcome, "op_rejected");
  assert.equal(receipt.code, "invalid_judgment");
  assert.match(String(receipt.nextAction), /completion\.ci must be not_applicable/u);
  assert.match(String(receipt.nextAction), /closeout never invents a CI judgment/u);
});

test("a declared ci gate still demands passed, so the original intent is not weakened", async () => {
  const { receipt } = await closeout(["ci"], "passed");
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
});

test("a declared ci gate cannot be waved away as not_applicable", async () => {
  const { receipt } = await closeout(["ci"], "not_applicable");
  assert.equal(receipt.outcome, "op_rejected");
  assert.equal(receipt.code, "invalid_judgment");
  assert.match(String(receipt.nextAction), /completion\.ci must be passed/u);
  assert.match(String(receipt.nextAction), /closeout never invents a CI judgment/u);
});

test("the ci value domain stays closed, so no third token slips through either contract", async () => {
  for (const gates of [[], ["ci"]] as const) for (const ci of ["failed", "skipped", "PASSED", "", "true"]) {
    const { receipt } = await closeout(gates, ci);
    assert.equal(receipt.code, "invalid_judgment", `${ci} was accepted for gates ${JSON.stringify(gates)}`);
  }
});

test("not_applicable reaches the leaf as an omitted --ci flag rather than a value it would reject", async () => {
  const absent = await closeout([], "not_applicable");
  assert.deepEqual(absent.completeCalls.map((action) => Object.hasOwn(action, "ci")), [false]);
  const present = await closeout(["ci"], "passed");
  assert.deepEqual(present.completeCalls.map((action) => action.ci), ["passed"]);
});
