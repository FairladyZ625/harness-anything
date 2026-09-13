// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { getEntityKindContract } from "../../kernel/src/index.ts";
import {
  derivedTaskActionProtocolCommands,
  generatedTaskActionProtocolDeclarations,
  reviewJsonFields,
} from "../../daemon/src/protocol/daemon-protocol-commands-task.ts";
import { validateDaemonRpcCall } from "../../daemon/src/protocol/daemon-protocol-rpc-validation.ts";
import { workspacePathFormat } from "../../preset/src/preset-command-contract.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("daemon lifecycle command inputs and thin CLI parameters are projections of Task Actions", () => {
  const actions = (getEntityKindContract("task")?.actionCatalog?.actions ?? []).filter(
    (action) => action.execution?.lifecycle !== undefined && action.id !== "create",
  );
  assert.deepEqual(
    generatedTaskActionProtocolDeclarations.map(({ id }) => id),
    actions.map(({ id }) => id),
    "daemon projection must cover every executable Kernel Task Action",
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
                ...Object.fromEntries(Object.entries(field.cli).filter(([key]) => key !== "jsonSchema")),
                field: field.field,
                required: field.required,
                ...(field.enum ? { enum: field.enum } : {}),
                ...(field.regex ? { regex: field.regex } : {}),
                ...(field.field === "fromFile" ? { format: workspacePathFormat } : {}),
                ...(field.cli.jsonSchema
                  ? {
                      jsonFields: field.cli.jsonSchema.fields
                        .filter(({ required }) => required)
                        .map(({ field }) => field),
                      jsonAllowedFields: field.cli.jsonSchema.fields.map(({ field }) => field),
                      ...(field.cli.jsonSchema.fields.some(
                        (nested) => nested.value?.kind === "string" && nested.value.enumRef,
                      )
                        ? {
                            jsonEnums: Object.fromEntries(
                              field.cli.jsonSchema.fields.flatMap((nested) =>
                                nested.value?.kind === "string" && nested.value.enumRef
                                  ? [[nested.field, nested.value.enumRef]]
                                  : [],
                              ),
                            ),
                          }
                        : {}),
                    }
                  : {}),
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
  assert.equal(packetFields("submit"), undefined);
  assert.deepEqual(reviewJsonFields, packetFields("review"));
  const complete = parseThinCommand(["task", "complete", "task_contract", "--fact-holds", "F-ABCDEFGH:Still holds"]);
  assert.equal(complete.ok, true, JSON.stringify(complete));
  if (complete.ok) {
    assert.equal(complete.command.action.commandType, "CompleteTask");
    assert.equal(Object.hasOwn(complete.command.action, "paths"), false);
    assert.deepEqual(complete.command.action.factHolds, [{ factRef: "fact/F-ABCDEFGH", rationale: "Still holds" }]);
  }
  assert.equal(parseThinCommand(["task", "submit", "task_contract"]).ok, true);
  const amended = parseThinCommand(["task", "submit", "task_contract", "--execution-id", "execution-1", "--amend"]);
  assert.equal(amended.ok, true, JSON.stringify(amended));
  if (amended.ok) assert.equal(amended.command.action.amend, true);
});

test("repo.task.run validator consumes the same closed Task Action input", () => {
  const call = (action: Readonly<Record<string, unknown>>) =>
    validateDaemonRpcCall({
      method: "repo.task.run",
      params: { repo: { repoId: "canonical" }, payload: { action } },
    });
  assert.match(
    call({ kind: "task-submit", taskId: "task_contract", fromFile: "submission.json" }).join("\n"),
    /fromFile/u,
  );
  assert.deepEqual(
    call({
      kind: "task-submit",
      taskId: "task_contract",
      executionId: "execution-1",
      amend: true,
    }),
    [],
  );
  assert.deepEqual(call({ kind: "task-submit", taskId: "task_contract" }), []);
  assert.match(
    call({ kind: "task-start", taskId: "task_contract", expectedVersion: "4" }).join("\n"),
    /expectedVersion must be number/u,
  );
  assert.match(call({ kind: "task-complete", taskId: "task_contract", shadow: true }).join("\n"), /shadow/u);
});

test("removed submit JSON and complete evidence forms are rejected", () => {
  for (const [verb, flag] of [
    ["submit", "--from-file"],
    ["submit", "--json-input"],
    ["complete", "--ci"],
    ["complete", "--path"],
  ]) {
    const result = parseThinCommand(["task", verb!, "task_contract", flag!, "legacy-input"]);
    assert.equal(result.ok, false, `${verb} ${flag}`);
  }
});
