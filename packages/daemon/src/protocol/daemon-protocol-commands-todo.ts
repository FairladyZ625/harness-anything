import { todoActionDefinitions } from "@harness-anything/kernel/internal/domain/todo-action-contract";
import type { EntityActionInputField } from "@harness-anything/kernel";
import {
  cliInput,
  defineCenterForwardWriteCommand,
  defineRepoReadCommand,
} from "@harness-anything/preset/internal/preset-command-contract";

export const todoProtocolCommands = todoActionDefinitions.map(({ id, read, summary, fields }) => {
  const command = {
    id: `todo-${id}`,
    phase: "Todo",
    path: id === "list" ? ["todo", id] : ["todo", id, id === "add" ? "<text>" : "<todo-id>"],
    summary,
    method: read ? "repo.task.read" : "repo.task.run",
    repositoryRead: read,
    positional: id === "list" ? undefined : id === "add" ? "text" : "todoId",
    inputs: (fields as readonly EntityActionInputField[]).flatMap((field) =>
      field.cli
        ? [
            cliInput(field.cli.name, field.cli.kind, field.required, field.cli.error, {
              field: field.field,
              ...(field.cli.projection ? { projection: field.cli.projection } : {}),
            }),
          ]
        : [],
    ),
    payloadFields: (fields as readonly EntityActionInputField[]).filter((field) => !field.cli),
  };
  return read ? defineRepoReadCommand(command) : defineCenterForwardWriteCommand(command);
});
