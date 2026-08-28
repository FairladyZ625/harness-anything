import {
  defineCenterForwardReadCommand,
  defineCenterForwardWriteCommand,
  cliInput,
  consentJsonFields,
  defineLedgerWriteCommand,
  defineLocalArbiterCommand,
  defineRepoReadCommand,
  reviewJsonFields,
  taskSubmissionJsonFields,
} from "../../../preset/src/preset-command-contract.ts";

export const taskExecutionProtocolCommands = Object.freeze([
  defineCenterForwardWriteCommand({
    id: "task-start",
    phase: "W3",
    path: ["task", "start", "<task-id>"],
    summary: "Acquire the task execution lease.",
    method: "repo.task.run",
    inputs: [
      cliInput("--execution-id", "single", false, {
        code: "invalid_field",
        nextAction: "Use one execution id, or omit it for deterministic allocation.",
      }),
      cliInput(
        "--ttl-ms",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use a positive lease duration in milliseconds.",
        },
        { regex: "^[1-9][0-9]*$" },
      ),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --dry-run once to preview lease admission.",
      }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-progress-append",
    phase: "W3",
    path: ["task", "progress", "append", "<task-id>"],
    summary: "Append typed progress through the active task lease.",
    method: "repo.task.run",
    inputs: [
      cliInput("--text", "single", true, {
        code: "missing_field",
        nextAction: "Add --text <progress-text>.",
      }),
      cliInput(
        "--evidence",
        "repeated",
        false,
        {
          code: "invalid_field",
          nextAction: "Use --evidence <type>:<path>:<summary> with a canonical relative path.",
        },
        {
          format: "<type>:<path>:<summary>",
          regex: "^[a-z][a-z0-9_-]{0,31}:[^:]+:.+$",
        },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-artifact-add",
    phase: "W3",
    path: ["task", "artifact", "add", "<task-id>"],
    summary: "Publish an untracked UTF-8 artifact through canonical doc sync.",
    method: "repo.task.run",
    inputs: [
      cliInput("--source", "single", true, {
        code: "missing_field",
        nextAction: "Add --source <untracked-file>.",
      }),
      cliInput("--destination", "single", true, {
        code: "missing_field",
        nextAction: "Add --destination <artifact-path>.",
      }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-submit",
    phase: "W3",
    path: ["task", "submit", "<task-id>"],
    summary: "Atomically finalize an Execution and enter review.",
    method: "repo.task.run",
    inputs: [
      cliInput("--execution-id", "single", false, {
        code: "invalid_field",
        nextAction: "Use one execution id only to assert the authenticated active lease explicitly.",
      }),
      cliInput(
        "--from-file",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use exactly one submission source: --json-input <json> or workspace-local --from-file <path>.",
        },
        { jsonFields: taskSubmissionJsonFields, conflictsWith: ["--json-input"] },
      ),
      cliInput(
        "--json-input",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use exactly one submission source: --json-input <json> or workspace-local --from-file <path>.",
        },
        { jsonFields: taskSubmissionJsonFields, conflictsWith: ["--from-file"] },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-closeout",
    phase: "W3",
    path: ["task", "closeout", "<task-id>"],
    summary: [
      "Run submission, independent review, owner consent, and completion in ",
      "canonical order, resuming from the current closeout stage.",
    ].join(""),
    method: "repo.task.run",
    inputs: [
      cliInput("--execution-id", "single", false, {
        code: "invalid_field",
        nextAction: "Use --execution-id only when closeout lists multiple current submitted execution candidates.",
      }),
      cliInput(
        "--from-file",
        "single",
        true,
        {
          code: "missing_field",
          nextAction: "Run ha task closeout <task-id> --from-file <judgment.json>.",
        },
        { jsonFields: ["submission", "review", "consent", "completion"] },
      ),
    ],
  }),
  defineLocalArbiterCommand({
    id: "task-review-execution",
    phase: "W3",
    path: ["task", "review-execution", "<task-id>"],
    summary: "Append a canonical Execution Review.",
    method: "repo.task.run",
    inputs: [
      cliInput("--execution-id", "single", false, {
        code: "invalid_field",
        nextAction: "Use one named current submitted execution only when the daemon reports ambiguity.",
      }),
      cliInput("--review-id", "single", true, {
        code: "invalid_field",
        nextAction: "Review requires a review id.",
      }),
      cliInput(
        "--from-file",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Review requires a complete review JSON packet.",
        },
        { jsonFields: reviewJsonFields },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-review-consent",
    phase: "W3",
    path: ["task", "review-consent", "<task-id>"],
    summary: "Select a recorded Review with content-pinned owner consent.",
    method: "repo.task.run",
    inputs: [
      cliInput("--execution-id", "single", false, {
        code: "invalid_field",
        nextAction: "Use one named approved Review execution only when the daemon reports ambiguity.",
      }),
      cliInput("--review-id", "single", false, {
        code: "invalid_field",
        nextAction: "Use one named approved Review only when the daemon reports ambiguity.",
      }),
      cliInput("--consent-id", "single", true, {
        code: "invalid_field",
        nextAction: "Consent requires a consent id.",
      }),
      cliInput(
        "--from-file",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: [
            "Omit --from-file to pin the selected recorded Review, or supply ",
            "reviewDigest and contentDigest JSON to pin them yourself.",
          ].join(""),
        },
        { jsonFields: consentJsonFields },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-code-doc-reconcile",
    phase: "W3",
    path: ["task", "code-doc", "reconcile", "<task-id>"],
    summary: "Publish a typed code-doc witness.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineLedgerWriteCommand({
    id: "task-code-doc-repoint",
    phase: "W3",
    path: ["task", "code-doc", "repoint", "<task-id>"],
    summary: "Append an audited code-doc witness correction for a completed task.",
    method: "repo.task.run",
    inputs: [
      cliInput("--record", "single", true, {
        code: "missing_field",
        nextAction: "Repoint requires the active anchor record identifier.",
      }),
      cliInput("--path", "repeated", false, {
        code: "invalid_field",
        nextAction: "Use canonical repository-relative paths, or omit --path to mark the record known-invalid.",
      }),
      cliInput("--reason", "single", true, {
        code: "missing_field",
        nextAction: "Repoint requires an audit reason.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-complete",
    phase: "W3",
    path: ["task", "complete", "<task-id>"],
    summary: "Complete a reviewed and consented task after canonical gate checks.",
    method: "repo.task.run",
    inputs: [
      cliInput("--execution-id", "single", false, {
        code: "invalid_field",
        nextAction: "Use one closeout execution id only when the daemon reports ambiguity.",
      }),
      cliInput(
        "--ci",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use --ci passed only for a successful canonical checker result.",
        },
        { enum: ["passed"] },
      ),
      cliInput("--path", "repeated", false, {
        code: "invalid_field",
        nextAction:
          "Provide each canonical code path with --path; the submitted commit and iteration are derived automatically.",
      }),
    ],
  }),
  defineCenterForwardReadCommand({
    id: "task-show",
    phase: "W3",
    path: ["task", "show", "<task-id>"],
    summary: "Read the task projection.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "receipt-show",
    phase: "W3",
    path: ["receipt", "show", "<op-id>"],
    summary: "Read a write receipt.",
    method: "repo.task.run",
    inputs: [],
  }),
] as const);
