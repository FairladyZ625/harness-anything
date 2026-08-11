// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskLifecycleArgs,
  runTaskLifecycleFacade,
  type TaskLifecycleServiceInput
} from "../src/commands/core/task-lifecycle.ts";

const actor = {
  principal: { personId: "person_zeyu" },
  executor: { kind: "agent" as const, id: "executor-session" }
};
const workspaceId = "/workspace";
const applied = (opId: string, revision: number, evidence: string) => ({
  outcome: "applied" as const, opId, revision, evidence, visibility: "center" as const,
  proof: { committedRevision: revision, appliedCut: revision }
});

const argv = [
  "task", "submit", "task_TYPED",
  "--execution-id", "exe_TYPED",
  "--claim", "The typed submission is ready for review.",
  "--deliverable", "typed task-submit",
  "--evidence-ref", "artifact:integration",
  "--verification", "npm run check:local",
  "--known-gap", "W2 integration remains",
  "--residual-risk", "integration tier remains",
  "--commit-sha", "a".repeat(40)
] as const;

test("submit sends a field-equal SubmitExecution intent to the host", async () => {
  const parsed = parseTaskLifecycleArgs(argv);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  let received: TaskLifecycleServiceInput | undefined;
  const receipt = await runTaskLifecycleFacade(parsed.value, {
    actor,
    workspaceId,
    service: {
      execute: async (input) => {
        received = input;
        return applied(input.command.opId, 3, "task-event:event-3");
      },
      show: async () => applied("read:task", 3, "unused")
    }
  });

  assert.equal(receipt.outcome, "applied");
  assert.deepEqual(received, {
    command: {
      type: "SubmitExecution",
      schema: "normalized-command/v1",
      workspaceId,
      taskId: "task_TYPED",
      actor,
      source: "local",
      expectedRevision: 3,
      opId: received?.command.opId,
      commandDigest: received?.command.commandDigest,
      executionId: "exe_TYPED",
      submission: {
        claim: "The typed submission is ready for review.",
        deliverables: ["typed task-submit"],
        evidenceRefs: ["artifact:integration"],
        verification: ["npm run check:local"],
        knownGaps: ["W2 integration remains"],
        residualRisks: ["integration tier remains"],
        commitSha: "a".repeat(40)
      }
    }
  });
});

test("submit rejects unknown or missing fields before calling the host", () => {
  const unknown = parseTaskLifecycleArgs([...argv, "--silently-dropped", "true"]);
  const missing = parseTaskLifecycleArgs(argv.filter((value, index) => value !== "--commit-sha" && argv[index - 1] !== "--commit-sha"));
  assert.equal(unknown.ok, false);
  assert.equal(missing.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.error.code, "unknown_field");
    assert.match(unknown.error.nextAction, /--help/u);
  }
  if (!missing.ok) {
    assert.equal(missing.error.code, "missing_field");
    assert.match(missing.error.nextAction, /--commit-sha/u);
  }
});

test("same submit intent produces the same load-bearing opId", async () => {
  const opIds: string[] = [];
  const service = {
    execute: async (input: TaskLifecycleServiceInput) => {
      opIds.push(input.command.opId);
      return applied(input.command.opId, 3, "task-event:event-3");
    },
    show: async () => applied("read:task", 3, "unused")
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parsed = parseTaskLifecycleArgs(argv);
    assert.equal(parsed.ok, true);
    if (parsed.ok) await runTaskLifecycleFacade(parsed.value, { actor, workspaceId, service });
  }
  assert.match(opIds[0] ?? "", /^op_[a-f0-9]{64}$/u);
  assert.equal(opIds[1], opIds[0]);
});

test("rejected submit preserves G04 recovery guidance", async () => {
  const parsed = parseTaskLifecycleArgs(argv);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const receipt = await runTaskLifecycleFacade(parsed.value, {
    actor,
    workspaceId,
    service: {
      execute: async (input) => ({
        outcome: "rejected",
        opId: input.command.opId,
        code: "invalid_transition",
        origin: "task-lifecycle-service",
        evidence: "service-rejection:invalid_transition",
        nextAction: "Run `ha task show task_TYPED` and start an Execution before submitting."
      }),
      show: async () => applied("read:task", 3, "unused")
    }
  });
  assert.deepEqual(receipt, {
    outcome: "rejected",
    opId: receipt.opId,
    code: "invalid_transition",
    origin: "task-lifecycle-service",
    evidence: "service-rejection:invalid_transition",
    nextAction: "Run `ha task show task_TYPED` and start an Execution before submitting."
  });
});

test("indeterminate submit preserves all G04 recovery fields", async () => {
  const parsed = parseTaskLifecycleArgs(argv);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const receipt = await runTaskLifecycleFacade(parsed.value, {
    actor,
    workspaceId,
    service: {
      execute: async (input) => ({
        outcome: "indeterminate",
        opId: input.command.opId,
        code: "publication_unknown",
        origin: "N/A",
        nextAction: "Run `ha task show task_TYPED`; retry only if the projection does not contain this opId."
      }),
      show: async () => applied("read:task", 3, "unused")
    }
  });
  assert.equal(receipt.outcome, "indeterminate");
  assert.deepEqual(
    [receipt.code, receipt.origin, receipt.nextAction?.includes("task show"), receipt.opId?.startsWith("op_")],
    ["publication_unknown", "N/A", true, true]
  );
});
