import {
  cliInput,
  defineLedgerWriteCommand,
  defineRepoReadCommand,
} from "../../../preset/src/preset-command-contract.ts";

export const decisionRelationProtocolCommands = Object.freeze([
  defineLedgerWriteCommand({
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
          nextAction: "Claim requires a C-prefixed --id.",
        },
        { regex: "^C[A-Za-z0-9_-]+$" },
      ),
      cliInput("--text", "single", true, {
        code: "invalid_field",
        nextAction: "Claim requires --text.",
      }),
      cliInput("--non-load-bearing", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --non-load-bearing once.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
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
          nextAction: "Claim requires a C-prefixed --id.",
        },
        { regex: "^C[A-Za-z0-9_-]+$" },
      ),
      cliInput(
        "--mode",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Fulfillment requires evidenced, delivered, or standing_policy mode.",
        },
        { enum: ["evidenced", "delivered", "standing_policy"] },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-relate",
    phase: "DecisionFact-B",
    path: ["decision", "relate", "<id>"],
    summary: "Append a Decision-owned relation.",
    method: "repo.task.run",
    inputs: [
      cliInput("--anchor", "single", true, {
        code: "invalid_field",
        nextAction: "Relate requires an existing Decision anchor.",
      }),
      cliInput("--type", "single", true, {
        code: "invalid_field",
        nextAction: "Relate requires type, target, and a rationale of 1..199 characters.",
      }),
      cliInput("--target", "single", true, {
        code: "invalid_field",
        nextAction: "Relate requires type, target, and a rationale of 1..199 characters.",
      }),
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Relate requires type, target, and a rationale of 1..199 characters.",
        },
        { regex: "^[\\s\\S]{1,199}$" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-relation-retire",
    phase: "DecisionFact-B",
    path: ["decision", "relation", "retire", "<id>"],
    summary: "Retire a Decision-owned relation while preserving the old edge.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--relation",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Relation retire requires a deterministic relation id and reason.",
        },
        { regex: "^rel_[0-9a-f]{16}$" },
      ),
      cliInput(
        "--reason",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Relation retire requires a deterministic relation id and reason.",
        },
        { regex: "^[\\s\\S]{1,199}$" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-relation-replace",
    phase: "DecisionFact-B",
    path: ["decision", "relation", "replace", "<id>"],
    summary: "Atomically retire one hosted relation and append its deterministic replacement.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--relation",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Relation replace requires the old deterministic relation id.",
        },
        { regex: "^rel_[0-9a-f]{16}$" },
      ),
      cliInput("--anchor", "single", true, {
        code: "invalid_field",
        nextAction: "Relation replace requires an existing Decision anchor.",
      }),
      cliInput("--type", "single", true, {
        code: "invalid_field",
        nextAction: "Relation replace requires type, target, and rationale.",
      }),
      cliInput("--target", "single", true, {
        code: "invalid_field",
        nextAction: "Relation replace requires type, target, and rationale.",
      }),
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Relation replace requires a rationale of 1..199 characters.",
        },
        { regex: "^[\\s\\S]{1,199}$" },
      ),
      cliInput("--body", "single", false, {
        code: "invalid_field",
        nextAction: "--body replaces only authored Markdown prose.",
      }),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --dry-run once to preview without writing.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-reckon",
    phase: "DecisionFact-B",
    path: ["decision", "reckon", "<id>"],
    summary: "Record coverage at the exact projected basis revision.",
    method: "repo.task.run",
    inputs: [
      cliInput("--task", "single", true, {
        code: "missing_field",
        nextAction: "Reckon requires --task.",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "decision-list",
    phase: "DecisionFact-B",
    path: ["decision", "list"],
    summary: "List the canonical Decision projection without authored prose.",
    method: "repo.task.run",
    inputs: [
      cliInput("--search", "single", false, {
        code: "invalid_field",
        nextAction: "--search requires a non-empty value.",
      }),
      cliInput(
        "--legacy-id",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use an E-number such as E12." },
        { regex: "^E[1-9][0-9]*$" },
      ),
      cliInput(
        "--legacy-range",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use an inclusive range such as E1-E12.",
        },
        { regex: "^E[1-9][0-9]*-E[1-9][0-9]*$" },
      ),
      cliInput(
        "--state",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Decision state filter is invalid.",
        },
        {
          enum: ["proposed", "in_effect", "rejected", "deferred", "superseded", "outcome_retired"],
        },
      ),
      cliInput("--module", "single", false, {
        code: "invalid_field",
        nextAction: "--module requires a non-empty value.",
      }),
      cliInput("--product-line", "single", false, {
        code: "invalid_field",
        nextAction: "--product-line requires a non-empty value.",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "decision-show",
    phase: "DecisionFact-B",
    path: ["decision", "show", "<id>"],
    summary: "Show one canonical Decision by id or E-number.",
    method: "repo.task.run",
    inputs: [
      cliInput("--include-body", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --include-body once.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "distill-candidate",
    phase: "DecisionFact-B",
    path: ["distill", "candidate"],
    summary: "Create a generated, non-canonical candidate artifact from a task evidence file; no Fact is written.",
    method: "repo.task.run",
    inputs: [
      cliInput("--task", "single", true, {
        code: "missing_field",
        nextAction: "Distill candidate requires --task and --input.",
      }),
      cliInput("--input", "single", true, {
        code: "invalid_field",
        nextAction: "--input must be a readable workspace-relative file.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "distill-promote",
    phase: "DecisionFact-B",
    path: ["distill", "promote"],
    summary: "Promote one validated candidate claim through the canonical immutable Fact write path.",
    method: "repo.task.run",
    inputs: [
      cliInput("--task", "single", true, {
        code: "missing_field",
        nextAction: "Distill promote requires --task, --candidate, and --claim.",
      }),
      cliInput("--candidate", "single", true, {
        code: "invalid_field",
        nextAction: "--candidate must be a readable distill-candidate/v1 artifact.",
      }),
      cliInput("--claim", "single", true, {
        code: "invalid_field",
        nextAction: "--claim requires explicit stable Fact text.",
      }),
      cliInput(
        "--id",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use F- followed by eight Crockford characters.",
        },
        { regex: "^F-[0-9A-HJKMNP-TV-Z]{8}$" },
      ),
      cliInput(
        "--confidence",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Confidence must be low, medium, or high.",
        },
        { enum: ["low", "medium", "high"] },
      ),
      cliInput(
        "--memory-class",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Memory class must be semantic, episodic, or procedural.",
        },
        { enum: ["semantic", "episodic", "procedural"] },
      ),
      cliInput("--memory-tag", "repeated", false, {
        code: "invalid_field",
        nextAction: "--memory-tag requires a declared Fact memory tag.",
      }),
      cliInput("--observed-at", "single", false, {
        code: "invalid_field",
        nextAction: "Use an ISO-8601 timestamp for --observed-at.",
      }),
    ],
  }),
] as const);
