import {
  cliInput,
  defineCenterForwardWriteCommand,
  defineEdgeReplicaQueryOnlyReadCommand,
} from "@harness-anything/preset/internal/preset-command-contract";

export const decisionRelationProtocolCommands = Object.freeze([
  defineCenterForwardWriteCommand({
    id: "decision-claim-add",
    phase: "DecisionFact-B",
    path: ["decision", "claim", "add", "<id>"],
    summary: "Append a Decision claim.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--id",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", field: "claimId", regex: "^C[A-Za-z0-9_-]+$" },
      ),
      cliInput(
        "--text",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--non-load-bearing",
        "boolean",
        false,
        {
          code: "invalid_field",
        },
        { field: "loadBearing" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "decision-claim-fulfill",
    phase: "DecisionFact-B",
    path: ["decision", "claim", "fulfill", "<id>"],
    summary: "Declare a claim fulfillment mode.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--id",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", field: "claimId", regex: "^C[A-Za-z0-9_-]+$" },
      ),
      cliInput(
        "--mode",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", enum: ["evidenced", "delivered", "standing_policy"] },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "decision-reckon",
    phase: "DecisionFact-B",
    path: ["decision", "reckon", "<id>"],
    summary: "Record coverage at the exact projected basis revision.",
    method: "repo.task.run",
    inputs: [cliInput("--task", "single", true, { code: "missing_field" }, { pathKind: "non-path", field: "taskId" })],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "decision-list",
    phase: "DecisionFact-B",
    path: ["decision", "list"],
    summary: "List the canonical Decision projection without authored prose.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--search",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--legacy-id",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", regex: "^E[1-9][0-9]*$" },
      ),
      cliInput(
        "--legacy-range",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^E[1-9][0-9]*-E[1-9][0-9]*$" },
      ),
      cliInput(
        "--state",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          pathKind: "non-path",
          enum: ["proposed", "in_effect", "rejected", "deferred", "superseded", "outcome_retired"],
        },
      ),
      cliInput(
        "--module",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--product-line",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--limit",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$" },
      ),
      cliInput(
        "--cursor",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "decision-show",
    phase: "DecisionFact-B",
    path: ["decision", "show", "<id>"],
    summary: "Show one canonical Decision by id or E-number.",
    method: "repo.task.read",
    inputs: [
      // <id> and --id are the same field in two spellings; the parser rejects both-at-once
      // and reports a missing id itself, so the flag stays optional in the declaration.
      cliInput("--id", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--include-body", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "distill-candidate",
    // No Agent/person caller in either observation window; keep the protocol face executable.
    hiddenSince: "2026-11-05",
    phase: "DecisionFact-B",
    path: ["distill", "candidate"],
    summary: "Create a generated, non-canonical candidate artifact from a file or governed artifact entity.",
    method: "repo.task.run",
    inputs: [
      cliInput("--task", "single", true, { code: "missing_field" }, { pathKind: "non-path", field: "taskId" }),
      cliInput(
        "--input",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "workspace-file", pathReader: "workspace-text", field: "inputPath" },
      ),
      cliInput("--entity", "single", false, { code: "invalid_field" }, { pathKind: "non-path", field: "entityRef" }),
    ],
    actionConstraints: [["inputPath", "entityRef"]],
  }),
  defineCenterForwardWriteCommand({
    id: "distill-promote",
    hiddenSince: "2026-11-05",
    phase: "DecisionFact-B",
    path: ["distill", "promote"],
    summary: "Promote one validated candidate claim through the canonical immutable Fact write path.",
    method: "repo.task.run",
    inputs: [
      cliInput("--task", "single", true, { code: "missing_field" }, { pathKind: "non-path", field: "taskId" }),
      cliInput(
        "--candidate",
        "single",
        true,
        { code: "invalid_field" },
        { pathKind: "workspace-file", pathReader: "workspace-text", field: "candidatePath" },
      ),
      cliInput("--claim", "single", true, { code: "invalid_field" }, { pathKind: "non-path", field: "statement" }),
      cliInput(
        "--id",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", field: "factId", regex: "^F-[0-9A-HJKMNP-TV-Z]{8}$" },
      ),
      cliInput(
        "--confidence",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", enum: ["low", "medium", "high"] },
      ),
      cliInput(
        "--memory-class",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", enum: ["semantic", "episodic", "procedural"] },
      ),
      cliInput(
        "--memory-tag",
        "repeated",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "memoryTags" },
      ),
      cliInput(
        "--observed-at",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
    ],
  }),
] as const);
