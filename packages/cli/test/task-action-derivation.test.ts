// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { entityActionCliInputs, getEntityKindContract } from "../../kernel/src/index.ts";
import { derivedTaskActionProtocolCommands } from "../../daemon/src/protocol/daemon-protocol-commands-task.ts";
import { validateDaemonRpcCall } from "../../daemon/src/protocol/daemon-protocol-rpc-validation.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("daemon command inputs and thin CLI parameters are projections of Task Actions", () => {
  const actions = getEntityKindContract("task")?.actionCatalog?.actions ?? [];
  assert.deepEqual(
    derivedTaskActionProtocolCommands.map(({ id }) => id),
    actions.map(({ execution }) => execution?.ingress),
  );
  for (const action of actions) {
    const command = derivedTaskActionProtocolCommands.find(({ id }) => id === action.execution?.ingress);
    assert.ok(command, action.id);
    assert.deepEqual(command.inputs, entityActionCliInputs(action), action.id);
  }
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
});

test("repo.task.run validator consumes the same closed Task Action input", () => {
  const call = (action: Readonly<Record<string, unknown>>) =>
    validateDaemonRpcCall({
      method: "repo.task.run",
      params: { repo: { repoId: "canonical" }, payload: { action } },
    });
  assert.deepEqual(call({ kind: "task-submit", taskId: "task_contract", fromFile: "submission.json" }), []);
  assert.match(call({ kind: "task-submit", taskId: "task_contract" }).join("\n"), /exactly one/u);
  assert.match(
    call({ kind: "task-start", taskId: "task_contract", expectedVersion: "4" }).join("\n"),
    /expectedVersion must be number/u,
  );
  assert.match(call({ kind: "task-complete", taskId: "task_contract", shadow: true }).join("\n"), /shadow/u);
});
