import {
  cliInput,
  decisionProposalJsonFields,
  defineLedgerWriteCommand,
  defineLocalArbiterCommand,
  defineRepoReadCommand,
} from "../../../preset/src/preset-command-contract.ts";

export const decisionLifecycleProtocolCommands = Object.freeze([
  defineRepoReadCommand({
    id: "decision-validate",
    actionKind: "decision-validate",
    phase: "DecisionFact-B",
    path: ["decision", "validate", "[id]"],
    summary: "Read-only validation of one or all Decision packages, pins, and amend history.",
    method: "repo.task.run",
    inputs: [
      cliInput("--all", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use exactly one of decision validate <id> or decision validate --all.",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "decision-verify",
    actionKind: "decision-validate",
    phase: "DecisionFact-B",
    path: ["decision", "verify", "[id]"],
    summary: "Read-only content-pin verification alias; reports every warning without rewriting.",
    method: "repo.task.run",
    inputs: [
      cliInput("--all", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use exactly one of decision verify <id> or decision verify --all.",
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
        nextAction: "Use exactly one Decision id or --all.",
      }),
      cliInput(
        "--migration-evidence",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Use --migration-evidence task/<task-id>/<audit-marker>.",
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
          nextAction: "Use exactly one of --from-file <workspace-packet.json> or --json-input <json|@->.",
        },
        {
          jsonFields: decisionProposalJsonFields,
          conflictsWith: ["--json-input"],
        },
      ),
      cliInput(
        "--json-input",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use exactly one of --from-file <workspace-packet.json> or --json-input <json|@->.",
        },
        {
          jsonFields: decisionProposalJsonFields,
          conflictsWith: ["--from-file"],
        },
      ),
      cliInput(
        "--body",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use only one of --body or --body-file.",
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
          nextAction: "Use only one of --body or --body-file.",
        },
        {
          requiresAny: ["--from-file", "--json-input"],
          conflictsWith: ["--body"],
        },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-transition",
    phase: "DecisionFact-B",
    path: ["decision", "transition", "<in_effect|rejected|deferred|superseded|outcome_retired>", "<id>"],
    summary: "Canonical lifecycle transition; terminal states cannot transition again.",
    method: "repo.task.run",
    inputs: [
      cliInput("--decided-at", "single", false, {
        code: "invalid_field",
        nextAction: "Use an ISO-8601 timestamp.",
      }),
      cliInput(
        "--judgment-only",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Judgment-only acceptance requires an explicit rationale of 1..199 characters.",
        },
        { regex: "^[\\s\\S]{1,199}$" },
      ),
      cliInput("--standing-policy", "boolean", false, {
        code: "invalid_field",
        nextAction: "--standing-policy is only valid when transitioning to in_effect.",
      }),
      cliInput(
        "--fulfillment",
        "repeated",
        false,
        {
          code: "invalid_field",
          nextAction: "Use --fulfillment <claim-id>:<evidenced|delivered|standing_policy>.",
        },
        { regex: "^C[A-Za-z0-9_-]+:(?:evidenced|delivered|standing_policy)$" },
      ),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --dry-run once to preview without writing.",
      }),
    ],
  }),
  defineLocalArbiterCommand({
    id: "decision-accept",
    phase: "DecisionFact-B",
    path: ["decision", "accept", "<id>"],
    summary: "Deprecated alias for decision transition in_effect.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "A rationale of 1..199 characters is required.",
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
          nextAction: "Without claim evidence, --judgment-only requires an explicit rationale of 1..199 characters.",
        },
        { requires: ["--rationale"], regex: "^[\\s\\S]{1,199}$" },
      ),
    ],
  }),
  defineLocalArbiterCommand({
    id: "decision-reject",
    phase: "DecisionFact-B",
    path: ["decision", "reject", "<id>"],
    summary: "Deprecated alias for decision transition rejected.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "A rationale of 1..199 characters is required.",
        },
        { regex: "^[\\s\\S]{1,199}$" },
      ),
    ],
  }),
  defineLocalArbiterCommand({
    id: "decision-defer",
    phase: "DecisionFact-B",
    path: ["decision", "defer", "<id>"],
    summary: "Deprecated alias for decision transition deferred.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "A rationale of 1..199 characters is required.",
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
          nextAction: "A reason of 1..199 characters is required.",
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
          nextAction: "A reason of 1..199 characters is required.",
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
        nextAction: "--title requires a non-empty title.",
      }),
      cliInput("--standing-policy", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --standing-policy once.",
      }),
      cliInput(
        "--fulfillment",
        "repeated",
        false,
        {
          code: "invalid_field",
          nextAction: "Use --fulfillment <claim-id>:<evidenced|delivered|standing_policy>.",
        },
        { regex: "^C[A-Za-z0-9_-]+:(?:evidenced|delivered|standing_policy)$" },
      ),
      cliInput("--load-bearing", "single", false, {
        code: "invalid_field",
        nextAction: "Use only one of --load-bearing or --non-load-bearing.",
      }),
      cliInput("--non-load-bearing", "single", false, {
        code: "invalid_field",
        nextAction: "Use only one of --load-bearing or --non-load-bearing.",
      }),
      cliInput("--set", "repeated", false, {
        code: "invalid_field",
        nextAction: "Use --set title:<value>.",
      }),
      cliInput("--append", "repeated", false, {
        code: "invalid_field",
        nextAction: "Use --append <chosen|rejected|claims>:<json-object>.",
      }),
      cliInput("--body", "single", false, {
        code: "invalid_field",
        nextAction: "Use only one of --body or --body-file.",
      }),
      cliInput("--body-file", "single", false, {
        code: "invalid_field",
        nextAction: "Use only one of --body or --body-file.",
      }),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --dry-run once to preview without writing.",
      }),
    ],
  }),
] as const);
