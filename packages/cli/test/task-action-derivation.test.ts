// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { getEntityKindContract } from "../../kernel/src/index.ts";
import {
  derivedTaskActionProtocolCommands,
  generatedTaskActionProtocolDeclarations,
  reviewJsonFields,
  taskSubmissionJsonFields,
} from "../../daemon/src/protocol/daemon-protocol-commands-task.ts";
import { validateDaemonRpcCall } from "../../daemon/src/protocol/daemon-protocol-rpc-validation.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("daemon lifecycle command inputs and thin CLI parameters are projections of Task Actions", () => {
  const actions = (getEntityKindContract("task")?.actionCatalog?.actions ?? []).filter(
    (action) => action.execution?.lifecycle !== undefined,
  );
  assert.deepEqual(
    generatedTaskActionProtocolDeclarations,
    actions.map(({ id, input, explain, execution }) => ({ id, input, explain, execution })),
    "run tools/generate-task-action-protocol.mjs after changing the Kernel Task Action contract",
  );
  assert.deepEqual(
    derivedTaskActionProtocolCommands.map(({ id }) => id),
    actions.map(({ execution }) => execution?.ingress),
  );
  for (const action of actions) {
    const command = derivedTaskActionProtocolCommands.find(({ id }) => id === action.execution?.ingress);
    assert.ok(command, action.id);
    assert.deepEqual(
      command.inputs,
      action.input.fields.flatMap((field) =>
        field.cli
          ? [
              {
                ...field.cli,
                field: field.field,
                required: field.required,
                ...(field.enum ? { enum: field.enum } : {}),
                ...(field.regex ? { regex: field.regex } : {}),
              },
            ]
          : [],
      ),
      action.id,
    );
  }
  const packetFields = (id: "submit" | "review") =>
    generatedTaskActionProtocolDeclarations
      .find((action) => action.id === id)
      ?.input.fields.find((field) => field.field === "fromFile")?.cli?.jsonFields;
  assert.deepEqual(taskSubmissionJsonFields, packetFields("submit"));
  assert.deepEqual(reviewJsonFields, packetFields("review"));
  const complete = parseThinCommand([
    "task",
    "complete",
    "task_contract",
    "--path",
    "packages/kernel/src/domain/entity-kind-registry.ts",
    "--fact-holds",
    "F-ABCDEFGH:Still holds",
  ]);
  assert.equal(complete.ok, true, JSON.stringify(complete));
  if (complete.ok) {
    assert.equal(complete.command.action.commandType, "CompleteTask");
    assert.deepEqual(complete.command.action.paths, ["packages/kernel/src/domain/entity-kind-registry.ts"]);
    assert.deepEqual(complete.command.action.factHolds, [{ factRef: "fact/F-ABCDEFGH", rationale: "Still holds" }]);
  }
  assert.equal(parseThinCommand(["task", "submit", "task_contract"]).ok, false);
  const amended = parseThinCommand([
    "task",
    "submit",
    "task_contract",
    "--execution-id",
    "execution-1",
    "--amend",
    "--json-input",
    JSON.stringify({
      completionClaim: "corrected",
      deliverables: [],
      outputs: [],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      commitSha: "a".repeat(40),
    }),
  ]);
  assert.equal(amended.ok, true, JSON.stringify(amended));
  if (amended.ok) assert.equal(amended.command.action.amend, true);
});

test("repo.task.run validator consumes the same closed Task Action input", () => {
  const call = (action: Readonly<Record<string, unknown>>) =>
    validateDaemonRpcCall({
      method: "repo.task.run",
      params: { repo: { repoId: "canonical" }, payload: { action } },
    });
  assert.deepEqual(call({ kind: "task-submit", taskId: "task_contract", fromFile: "submission.json" }), []);
  assert.deepEqual(
    call({
      kind: "task-submit",
      taskId: "task_contract",
      executionId: "execution-1",
      amend: true,
      fromFile: "submission.json",
    }),
    [],
  );
  assert.match(call({ kind: "task-submit", taskId: "task_contract" }).join("\n"), /exactly one/u);
  assert.match(
    call({ kind: "task-start", taskId: "task_contract", expectedVersion: "4" }).join("\n"),
    /expectedVersion must be number/u,
  );
  assert.match(call({ kind: "task-complete", taskId: "task_contract", shadow: true }).join("\n"), /shadow/u);
});
