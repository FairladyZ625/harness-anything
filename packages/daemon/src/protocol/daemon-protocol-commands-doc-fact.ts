import {
  defineCenterForwardReadCommand,
  defineCenterForwardWriteCommand,
  cliInput,
  defineLedgerWriteCommand,
  defineRepoReadCommand,
} from "../../../preset/src/preset-command-contract.ts";

export const docFactProtocolCommands = Object.freeze([
  defineCenterForwardReadCommand({
    id: "doc-status",
    phase: "DocSync-B",
    path: ["doc", "status"],
    summary: "Scan the authored root for document candidates.",
    method: "repo.task.run",
    inputs: [
      cliInput("--task", "single", false, {
        code: "invalid_field",
        nextAction: "Use --task <task-id> to scan only that task package; omit it for workspace prose.",
      }),
      cliInput("--path", "repeated", false, {
        code: "invalid_field",
        nextAction: "--path requires an authored-relative path.",
      }),
    ],
  }),
  defineCenterForwardReadCommand({
    id: "doc-sync-dry-run",
    actionKind: "doc-dry-run",
    phase: "DocSync-B",
    path: ["doc", "sync", "--dry-run"],
    summary: "Preview the scanner selection without writing.",
    method: "repo.task.run",
    inputs: [
      cliInput("--task", "single", false, {
        code: "invalid_field",
        nextAction: "Use --task <task-id> to preview only that task package; omit it for workspace prose.",
      }),
      cliInput("--path", "repeated", false, {
        code: "invalid_field",
        nextAction: "--path requires an authored-relative path.",
      }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "doc-sync-submit",
    actionKind: "doc-submit",
    phase: "DocSync-B",
    path: ["doc", "sync", "--submit"],
    summary: "Submit eligible scanner candidates through the resident daemon.",
    method: "repo.task.run",
    inputs: [
      cliInput("--task", "single", false, {
        code: "invalid_field",
        nextAction: "Use --task <task-id> to sync only that task package; omit it for workspace prose.",
      }),
      cliInput("--path", "repeated", false, {
        code: "invalid_field",
        nextAction: "--path requires an authored-relative path.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "doc-materialize",
    phase: "DocSync-B",
    path: ["doc", "materialize"],
    summary: "Restore the current canonical document cut to the worktree.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "doc-show",
    phase: "DocSync-B",
    path: ["doc", "show"],
    summary: "Show a canonical projected document.",
    method: "repo.task.run",
    inputs: [
      cliInput("--path", "single", true, {
        code: "missing_field",
        nextAction: "Add --path <authored-relative-path>.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "doc-retire",
    phase: "DocSync-B",
    path: ["doc", "retire"],
    summary: "Retire one canonical document with an audited reason.",
    method: "repo.task.run",
    inputs: [
      cliInput("--path", "single", true, {
        code: "missing_field",
        nextAction: "Add --path <authored-relative-path>.",
      }),
      cliInput("--reason", "single", true, {
        code: "missing_field",
        nextAction: "Add --reason <auditable-retirement-reason>.",
      }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "doc-conflict-resolve",
    phase: "Fleet-Wiring",
    path: ["doc", "conflict", "resolve", "<conflict-id>"],
    summary:
      "Close a staged sync conflict by hand after merging base/local/center; the next sync submits on the fresh base.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "doc-conflict-discard-local",
    phase: "Fleet-Wiring",
    path: ["doc", "conflict", "discard-local", "<conflict-id>"],
    summary: "Resolve a staged sync conflict by discarding the local changes and restoring the recorded center bytes.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "doc-conflict-overwrite-center",
    phase: "Fleet-Wiring",
    path: ["doc", "conflict", "overwrite-center", "<conflict-id>"],
    summary: [
      "Resolve a staged sync conflict by pushing the staged local bytes with ",
      "the recorded center digest as the expected base.",
    ].join(""),
    method: "repo.task.run",
    inputs: [],
  }),
  defineLedgerWriteCommand({
    id: "fact-reclassify",
    phase: "DecisionFact-A",
    path: ["fact", "reclassify"],
    syntaxPath: ["fact", "reclassify", "<fact-id>"],
    summary: "Replace a Fact's domain types with an audited reclassification event.",
    method: "repo.task.run",
    inputs: [
      cliInput("--type", "repeated", true, {
        code: "missing_field",
        nextAction: "Add one or more registered --type values.",
      }),
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "missing_field",
          nextAction: "Add --rationale <why> with at most 199 characters.",
        },
        { regex: "^[\\s\\S]{1,199}$" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "fact-type-register",
    phase: "DecisionFact-A",
    path: ["fact", "type", "register"],
    syntaxPath: ["fact", "type", "register", "<type>"],
    summary: "Register one controlled Fact domain type through an audited Fact event.",
    method: "repo.task.run",
    inputs: [
      cliInput("--source", "single", true, {
        code: "missing_field",
        nextAction: "Add --source <source> describing the registration basis.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "fact-record",
    phase: "DecisionFact-A",
    path: ["fact", "record"],
    syntaxPath: ["fact", "record", "[task-id]"],
    summary: "Record an immutable Fact event.",
    method: "repo.task.run",
    inputs: [
      cliInput("--task", "single", false, {
        code: "missing_field",
        nextAction: "Use --statement or --text with --source; optionally name a task positionally or with --task.",
      }),
      cliInput(
        "--statement",
        "single",
        false,
        {
          code: "missing_field",
          nextAction: "Use --statement or --text with --source; optionally name a task positionally or with --task.",
        },
        { conflictsWith: ["--text"] },
      ),
      cliInput(
        "--text",
        "single",
        false,
        {
          code: "missing_field",
          nextAction: "Use either --statement or --text for the observed fact.",
        },
        { conflictsWith: ["--statement"] },
      ),
      cliInput("--source", "single", true, {
        code: "missing_field",
        nextAction: "Add --source <source>; use --statement <observation> or --text <observation> for the Fact text.",
      }),
      cliInput(
        "--observed-at",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use an ISO-8601 UTC timestamp for --observed-at.",
        },
        {
          regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
        },
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
      cliInput("--type", "repeated", false, {
        code: "invalid_field",
        nextAction: "Fact type must be 1 to 64 characters without surrounding whitespace or control characters.",
      }),
      cliInput("--memory-tag", "repeated", false, {
        code: "invalid_field",
        nextAction: "--memory-tag requires a non-empty value.",
      }),
      cliInput(
        "--wait-projection",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use a non-negative integer projection wait limit in milliseconds.",
        },
        { regex: "^(?:0|[1-9][0-9]*)$" },
      ),
      cliInput("--supersedes", "single", false, {
        code: "invalid_field",
        nextAction: "Pair --supersedes with a rationale of at most 199 characters.",
      }),
      cliInput(
        "--rationale",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Pair --supersedes with a rationale of at most 199 characters.",
        },
        { regex: "^[\\s\\S]{1,199}$" },
      ),
    ],
  }),
  defineRepoReadCommand({
    id: "fact-search",
    phase: "DecisionFact-A",
    path: ["fact", "search", "[query]"],
    summary: "Search the Fact FTS projection.",
    method: "repo.task.run",
    inputs: [
      cliInput("--task", "single", false, {
        code: "invalid_field",
        nextAction: "--task requires a task id.",
      }),
      cliInput(
        "--confidence",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Fact search confidence must be low, medium, or high.",
        },
        { enum: ["low", "medium", "high"] },
      ),
      cliInput(
        "--memory-class",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Fact search memory class must be semantic, episodic, or procedural.",
        },
        { enum: ["semantic", "episodic", "procedural"] },
      ),
      cliInput("--type", "single", false, {
        code: "invalid_field",
        nextAction: "Fact search type requires a non-empty value.",
      }),
      cliInput(
        "--observed-after",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use an ISO-8601 UTC timestamp with --observed-after.",
        },
        {
          regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
        },
      ),
      cliInput(
        "--observed-before",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use an ISO-8601 UTC timestamp with --observed-before.",
        },
        {
          regex: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
        },
      ),
      cliInput(
        "--limit",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use an integer from 1 to 500 with --limit.",
        },
        { regex: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$" },
      ),
      cliInput("--cursor", "single", false, {
        code: "invalid_field",
        nextAction: "Use the cursor returned by the previous page.",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "fact-show",
    phase: "DecisionFact-A",
    path: ["fact", "show"],
    summary: "Show one projected Fact.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--id",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Use F- followed by eight Crockford characters.",
        },
        { regex: "^F-[0-9A-HJKMNP-TV-Z]{8}$" },
      ),
    ],
  }),
] as const);
