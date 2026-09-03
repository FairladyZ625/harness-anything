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
    method: "repo.task.read",
    inputs: [
      cliInput("--task", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--path", "repeated", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineCenterForwardReadCommand({
    id: "doc-sync-dry-run",
    actionKind: "doc-dry-run",
    phase: "DocSync-B",
    path: ["doc", "sync", "--dry-run"],
    summary: "Preview the scanner selection without writing.",
    method: "repo.task.read",
    inputs: [
      cliInput("--task", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--path", "repeated", false, {
        code: "invalid_field",
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
      }),
      cliInput("--path", "repeated", false, {
        code: "invalid_field",
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
    method: "repo.task.read",
    inputs: [
      cliInput("--path", "single", true, {
        code: "missing_field",
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
      }),
      cliInput("--reason", "single", true, {
        code: "missing_field",
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
      }),
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "missing_field",
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
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "fact-type-list",
    phase: "DecisionFact-A",
    path: ["fact", "type", "list"],
    summary: "List registered Fact domain types and the Fact that registered each value.",
    method: "repo.task.read",
    inputs: [],
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
      }),
      cliInput(
        "--statement",
        "single",
        false,
        {
          code: "missing_field",
        },
        { conflictsWith: ["--text"] },
      ),
      cliInput(
        "--text",
        "single",
        false,
        {
          code: "missing_field",
        },
        { conflictsWith: ["--statement"] },
      ),
      cliInput("--source", "single", true, {
        code: "missing_field",
      }),
      cliInput(
        "--observed-at",
        "single",
        false,
        {
          code: "invalid_field",
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
        },
        { enum: ["low", "medium", "high"] },
      ),
      cliInput(
        "--memory-class",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { enum: ["semantic", "episodic", "procedural"] },
      ),
      cliInput("--type", "repeated", false, {
        code: "invalid_field",
      }),
      cliInput("--memory-tag", "repeated", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--wait-projection",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { regex: "^(?:0|[1-9][0-9]*)$" },
      ),
      cliInput("--supersedes", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--rationale",
        "single",
        false,
        {
          code: "invalid_field",
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
    method: "repo.task.read",
    inputs: [
      cliInput("--task", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--confidence",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { enum: ["low", "medium", "high"] },
      ),
      cliInput(
        "--memory-class",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { enum: ["semantic", "episodic", "procedural"] },
      ),
      cliInput("--type", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--observed-after",
        "single",
        false,
        {
          code: "invalid_field",
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
        },
        { regex: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$" },
      ),
      cliInput("--cursor", "single", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "fact-show",
    phase: "DecisionFact-A",
    path: ["fact", "show"],
    summary: "Show one projected Fact.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--id",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { regex: "^F-[0-9A-HJKMNP-TV-Z]{8}$" },
      ),
    ],
  }),
] as const);
