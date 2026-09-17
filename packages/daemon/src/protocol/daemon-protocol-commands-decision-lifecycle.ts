import {
  cliInput,
  decisionProposalDefaultJsonFields,
  decisionProposalJsonFields,
  decisionProposalRequiredJsonFields,
  defineLedgerWriteCommand,
  defineLocalArbiterCommand,
  defineRepoReadCommand,
  workspacePathFormat,
} from "../../../preset/src/preset-command-contract.ts";

export const decisionLifecycleProtocolCommands = Object.freeze([
  defineRepoReadCommand({
    id: "decision-validate",
    actionKind: "decision-validate",
    phase: "DecisionFact-B",
    path: ["decision", "validate", "[id]"],
    summary: "Read-only validation of one or all Decision packages, pins, and amend history.",
    method: "repo.task.read",
    inputs: [
      cliInput("--all", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "decision-verify",
    actionKind: "decision-validate",
    phase: "DecisionFact-B",
    path: ["decision", "verify", "[id]"],
    summary: "Read-only content-pin verification alias; reports every warning without rewriting.",
    method: "repo.task.read",
    inputs: [
      cliInput("--all", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-rematerialize",
    phase: "DecisionFact-B",
    path: ["decision", "rematerialize"],
    summary: "Re-render one Decision's or every Decision's managed document from the current canonical projection.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--all",
        "boolean",
        false,
        {
          code: "invalid_field",
        },
        { conflictsWith: ["--id"] },
      ),
      cliInput(
        "--id",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { field: "decisionId", conflictsWith: ["--all"] },
      ),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-repin",
    phase: "DecisionFact-B",
    path: ["decision", "repin", "[id]"],
    summary: "Append current v1 content pins to one Decision or every Decision in a migration batch.",
    method: "repo.task.run",
    inputs: [
      cliInput("--all", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--migration-evidence",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { regex: "^task/[^/]+/[^/]+$" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-propose",
    phase: "DecisionFact-B",
    path: ["decision", "propose"],
    summary: "Propose an immutable Decision from one structured packet.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--from-file",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          jsonFields: decisionProposalRequiredJsonFields,
          jsonAllowedFields: decisionProposalJsonFields,
          jsonDefaultFields: decisionProposalDefaultJsonFields,
          format: workspacePathFormat,
          conflictsWith: ["--json-input"],
        },
      ),
      cliInput(
        "--json-input",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          jsonFields: decisionProposalRequiredJsonFields,
          jsonAllowedFields: decisionProposalJsonFields,
          jsonDefaultFields: decisionProposalDefaultJsonFields,
          format: "<json|@->",
          conflictsWith: ["--from-file"],
        },
      ),
      cliInput(
        "--body",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          requiresAny: ["--from-file", "--json-input"],
          conflictsWith: ["--body-file"],
        },
      ),
      cliInput(
        "--body-file",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          requiresAny: ["--from-file", "--json-input"],
          format: workspacePathFormat,
          conflictsWith: ["--body"],
        },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-transition",
    phase: "DecisionFact-B",
    path: ["decision", "transition", "<superseded|outcome_retired>", "<id>"],
    summary: "Bookkeeping transition of an in_effect Decision; adjudication uses decision accept/reject/defer.",
    method: "repo.task.run",
    inputs: [
      cliInput("--decided-at", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineLocalArbiterCommand({
    id: "decision-accept",
    phase: "DecisionFact-B",
    path: ["decision", "accept", "<id>"],
    summary: "Adjudicate a proposed Decision as in_effect; carries explicit human consent when given.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "invalid_field",
        },
        {
          requiresAny: ["claim-to-evidence relation", "--judgment-only"],
          regex: "^[\\s\\S]{1,199}$",
        },
      ),
      cliInput(
        "--judgment-only",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { requires: ["--rationale"], regex: "^[\\s\\S]{1,199}$" },
      ),
      cliInput(
        "--consent-by",
        "single",
        false,
        { code: "invalid_field" },
        {
          requires: ["--consent-at", "--consent-channel"],
        },
      ),
      cliInput("--consent-at", "single", false, { code: "invalid_field" }, { requires: ["--consent-by"] }),
      cliInput(
        "--consent-channel",
        "single",
        false,
        { code: "invalid_field" },
        {
          requires: ["--consent-by"],
          regex: "^(chat|cli|gui)$",
        },
      ),
    ],
  }),
  defineLocalArbiterCommand({
    id: "decision-reject",
    phase: "DecisionFact-B",
    path: ["decision", "reject", "<id>"],
    summary: "Adjudicate a proposed Decision as rejected; carries explicit human consent when given.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { regex: "^[\\s\\S]{1,199}$" },
      ),
      cliInput(
        "--consent-by",
        "single",
        false,
        { code: "invalid_field" },
        {
          requires: ["--consent-at", "--consent-channel"],
        },
      ),
      cliInput("--consent-at", "single", false, { code: "invalid_field" }, { requires: ["--consent-by"] }),
      cliInput(
        "--consent-channel",
        "single",
        false,
        { code: "invalid_field" },
        {
          requires: ["--consent-by"],
          regex: "^(chat|cli|gui)$",
        },
      ),
    ],
  }),
  defineLocalArbiterCommand({
    id: "decision-defer",
    phase: "DecisionFact-B",
    path: ["decision", "defer", "<id>"],
    summary: "Adjudicate a proposed Decision as deferred.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { regex: "^[\\s\\S]{1,199}$" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-supersede",
    phase: "DecisionFact-B",
    path: ["decision", "supersede", "<id>"],
    summary: "Deprecated alias for decision transition superseded.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--reason",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { regex: "^[\\s\\S]{1,199}$" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-retire",
    phase: "DecisionFact-B",
    path: ["decision", "retire", "<id>"],
    summary: "Deprecated alias for decision transition outcome_retired.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--reason",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { regex: "^[\\s\\S]{1,199}$" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-amend",
    phase: "DecisionFact-B",
    path: ["decision", "amend", "<id>"],
    summary: "Amend declared machine fields or replace Markdown prose without changing lifecycle state.",
    method: "repo.task.run",
    inputs: [
      cliInput("--title", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--standing-policy", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--fulfillment",
        "repeated",
        false,
        {
          code: "invalid_field",
        },
        { regex: "^C[A-Za-z0-9_-]+:(?:evidenced|delivered|standing_policy)$" },
      ),
      cliInput("--load-bearing", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--non-load-bearing", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--set", "repeated", false, {
        code: "invalid_field",
      }),
      cliInput("--append", "repeated", false, {
        code: "invalid_field",
      }),
      cliInput("--body", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--body-file",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { format: workspacePathFormat },
      ),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
] as const);
