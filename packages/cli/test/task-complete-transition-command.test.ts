// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskComplete } from "../src/cli/parsers/core-task-complete.ts";
import { taskCompleteTransitionCommandFromCliAction } from "../src/cli/task-complete-transition-command.ts";
import { cliDaemonCommandHostServices } from "../src/composition/daemon-command-host-services.ts";

test("CLI complete intent is field-equal after daemon host strict decoding", () => {
  const parsed = parseTaskComplete(
    ["task-complete", "task_TYPED", "--approve", "--ci", "passed"],
    "/repo",
    true,
    {
      commandKind: "task-complete",
      payload: {
        executionId: "exe_TYPED",
        reviewerId: "reviewer_TYPED",
        findings: "The execution evidence is complete.",
        evidenceChecked: ["artifact:report", "test:local-gate"],
        rationale: "The reviewed execution satisfies the completion contract.",
        archiveWarningsAcknowledged: true,
        consentStandingPolicyDecisionId: "dec_TYPED",
        consentActions: ["approve_execution", "complete_task"],
        paths: ["packages/application/src/authority/daemon-host-contract.ts"],
        prRef: "#typed",
        externalCheckpointRefs: [
          { kind: "document-publication", ref: "sha256:document-checkpoint" },
          { kind: "code-doc-reconciliation", ref: "sha256:code-doc-checkpoint" }
        ]
      }
    }
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const constructed = taskCompleteTransitionCommandFromCliAction(parsed.value.action);
  const transported = JSON.parse(JSON.stringify(parsed.value)) as Record<string, unknown>;
  const decoded = cliDaemonCommandHostServices.parseCommandPayload({ command: transported });
  assert.deepEqual(decoded.action, constructed);
  assert.deepEqual(decoded.action, {
    kind: "task-complete",
    taskId: "task_TYPED",
    executionId: "exe_TYPED",
    ciGate: "passed",
    reviewerId: "reviewer_TYPED",
    evidenceMode: "execution-review",
    commitRef: "HEAD",
    judgment: null,
    approval: {
      executionId: "exe_TYPED",
      findings: "The execution evidence is complete.",
      evidenceChecked: ["artifact:report", "test:local-gate"],
      rationale: "The reviewed execution satisfies the completion contract.",
      archiveWarningsAcknowledged: true,
      consentSource: { kind: "standing-policy", decisionId: "dec_TYPED" },
      consentActions: ["approve_execution", "complete_task"],
      paths: ["packages/application/src/authority/daemon-host-contract.ts"],
      prRef: "#typed"
    },
    externalCheckpointRefs: [
      { kind: "document-publication", ref: "sha256:document-checkpoint" },
      { kind: "code-doc-reconciliation", ref: "sha256:code-doc-checkpoint" }
    ],
    callerIdempotencyKey: constructed.callerIdempotencyKey,
    dryRun: false
  });
});

test("daemon host rejects unknown and missing complete-intent fields", () => {
  const action = completeAction();
  assert.throws(
    () => cliDaemonCommandHostServices.parseCommandPayload({
      command: { rootDir: "/repo", json: true, action: { ...action, silentlyDropped: true } }
    }),
    /TASK_COMPLETE_TRANSITION_COMMAND_INVALID:\$\.action\.silentlyDropped:no unknown fields/u
  );
  const { callerIdempotencyKey: _missing, ...withoutIdempotencyKey } = action;
  assert.throws(
    () => cliDaemonCommandHostServices.parseCommandPayload({
      command: { rootDir: "/repo", json: true, action: withoutIdempotencyKey }
    }),
    /TASK_COMPLETE_TRANSITION_COMMAND_INVALID:\$\.action\.callerIdempotencyKey:required field/u
  );
});

test("CLI derives the same load-bearing idempotency key for the same intent", () => {
  const first = parseTaskComplete(["task-complete", "task_RETRY", "--ci", "passed"], "/repo", true);
  const replay = parseTaskComplete(["task-complete", "task_RETRY", "--ci", "passed"], "/repo", true);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (!first.ok || !replay.ok || first.value.action.kind !== "task-complete"
    || replay.value.action.kind !== "task-complete") return;
  const firstCommand = taskCompleteTransitionCommandFromCliAction(first.value.action);
  const replayCommand = taskCompleteTransitionCommandFromCliAction(replay.value.action);
  assert.match(firstCommand.callerIdempotencyKey, /^task-complete-[a-f0-9]{64}$/u);
  assert.equal(replayCommand.callerIdempotencyKey, firstCommand.callerIdempotencyKey);
});

function completeAction() {
  return {
    kind: "task-complete" as const,
    taskId: "task_STRICT",
    executionId: null,
    ciGate: "passed" as const,
    reviewerId: "reviewer_STRICT",
    evidenceMode: "execution-review" as const,
    commitRef: null,
    judgment: null,
    approval: null,
    externalCheckpointRefs: [],
    callerIdempotencyKey: "caller-strict-key",
    dryRun: false
  };
}
