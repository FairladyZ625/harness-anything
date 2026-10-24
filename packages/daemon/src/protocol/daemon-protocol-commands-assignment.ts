import { cliInput, defineCenterForwardWriteCommand } from "@harness-anything/preset/internal/preset-command-contract";

const invalid = () => ({ code: "invalid_field" as const });
const expectedVersion = cliInput(
  "--expected-version",
  "single",
  true,
  { code: "missing_field" },
  {
    regex: "^(?:0|[1-9][0-9]*)$",
    projection: "number" as const,
  },
);

function assignmentCommands(kind: "agent" | "squad" | "schedule" | "task") {
  return [
    defineCenterForwardWriteCommand({
      id: `${kind}-assign`,
      phase: "Governed-Entity-W1-D",
      path: [kind, "assign", `<${kind}-id>`],
      summary: `Assign a ${kind} to a person, node or team through the canonical Relation writer.`,
      method: "repo.task.run",
      inputs: [
        expectedVersion,
        cliInput("--person", "single", false, invalid(), { field: "personId" }),
        cliInput("--node", "single", false, invalid(), { field: "nodeId" }),
        cliInput("--team", "single", false, invalid(), { field: "teamId" }),
        cliInput("--expires-at", "single", false, invalid(), { field: "expiresAt" }),
      ],
      actionConstraints: [["personId", "nodeId", "teamId"]],
    }),
    defineCenterForwardWriteCommand({
      id: `${kind}-unassign`,
      phase: "Governed-Entity-W1-D",
      path: [kind, "unassign", `<${kind}-id>`],
      summary: `Remove the current ${kind} assignment through the canonical Relation writer.`,
      method: "repo.task.run",
      inputs: [expectedVersion],
    }),
  ] as const;
}

export const assignmentProtocolCommands = Object.freeze([
  ...assignmentCommands("task"),
  ...assignmentCommands("agent"),
  ...assignmentCommands("squad"),
  ...assignmentCommands("schedule"),
] as const);
