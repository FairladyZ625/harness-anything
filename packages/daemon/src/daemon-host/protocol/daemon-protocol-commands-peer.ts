import { peerActionDefinitions } from "@harness-anything/kernel/internal/domain/peer-action-contract";
import type { EntityActionInputField } from "@harness-anything/kernel";
import {
  cliInput,
  defineCenterForwardWriteCommand,
  defineEdgeReplicaQueryOnlyReadCommand,
} from "@harness-anything/preset/internal/preset-command-contract";

export const peerProtocolCommands = peerActionDefinitions.map(({ id, read, summary, fields }) => {
  const hasPositional = id === "reply" || id === "promote" || id === "handoff",
    positionalName = id === "handoff" ? "<target-id>" : "<request-id>",
    positionalField = id === "handoff" ? "targetId" : "requestId";
  const command = {
    id: `peer-${id}`,
    phase: "W3",
    path: hasPositional ? ["peer", id, positionalName] : ["peer", id],
    summary,
    method: read ? "repo.task.read" : "repo.task.run",
    repositoryRead: read,
    positional: hasPositional ? positionalField : undefined,
    positionalInputs: hasPositional ? [{ name: positionalName, pathKind: "non-path", pathReader: "none" }] : [],
    inputs: (fields as readonly EntityActionInputField[]).flatMap((field) =>
      field.cli
        ? [
            cliInput(field.cli.name, field.cli.kind, field.required, field.cli.error, {
              pathKind: "non-path",
              field: field.field,
              ...(field.cli.projection ? { projection: field.cli.projection } : {}),
            }),
          ]
        : [],
    ),
    payloadFields: (fields as readonly EntityActionInputField[]).filter((field) => !field.cli),
  };
  return read ? defineEdgeReplicaQueryOnlyReadCommand(command) : defineCenterForwardWriteCommand(command);
});
