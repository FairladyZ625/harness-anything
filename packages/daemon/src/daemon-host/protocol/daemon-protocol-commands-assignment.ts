import { cliInput, defineCenterForwardWriteCommand } from "@harness-anything/preset/internal/preset-command-contract";

const invalid = () => ({ code: "invalid_field" as const });
const expectedVersion = cliInput(
  "--expected-version",
  "single",
  true,
  { code: "missing_field" },
  { pathKind: "non-path", regex: "^(?:0|[1-9][0-9]*)$", projection: "number" as const },
);

function assignmentCommands(kind: "agent" | "squad" | "schedule" | "task") {
  return [
    defineCenterForwardWriteCommand({
      id: `${kind}-assign`,
      // Task assignment is admin surface; the other entities' assignment stays common.
      helpTier: kind === "task" ? "maintenance" : "common",
      phase: "Governed-Entity-W1-D",
      path: [kind, "assign", `<${kind}-id>`],
      summary: `Assign a ${kind} to a person, node or team through the canonical Relation writer.`,
      method: "repo.task.run",
      inputs: [
        expectedVersion,
        cliInput("--person", "single", false, invalid(), { pathKind: "non-path", field: "personId" }),
        cliInput("--node", "single", false, invalid(), { pathKind: "non-path", field: "nodeId" }),
        cliInput("--team", "single", false, invalid(), { pathKind: "non-path", field: "teamId" }),
        cliInput("--expires-at", "single", false, invalid(), { pathKind: "non-path", field: "expiresAt" }),
      ],
      actionConstraints: [["personId", "nodeId", "teamId"]],
    }),
    defineCenterForwardWriteCommand({
      id: `${kind}-unassign`,
      // Task assignment is admin surface; the other entities' assignment stays common.
      helpTier: kind === "task" ? "maintenance" : "common",
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
