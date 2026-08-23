import {
  cliInput,
  consentJsonFields,
  defineCliCommand,
  reviewJsonFields,
  taskSubmissionJsonFields,
} from "../../../preset/src/preset-command-contract.ts";

export const taskExecutionProtocolCommands = Object.freeze([
  defineCliCommand({
    id: "task-start",
    phase: "W3",
    path: ["task", "start", "<task-id>"],
    summary: "Acquire the task execution lease.",
    method: "repo.task.run",
    commandClass: "repo-write",
    inputs: [
      cliInput("--execution-id", "single", true, {
        code: "missing_field",
        nextAction: "Add --execution-id <execution-id>.",
      }),
    ],
  }),
  defineCliCommand({
    id: "task-progress-append",
    phase: "W3",
    path: ["task", "progress", "append", "<task-id>"],
    summary: "Append typed progress through the active task lease.",
    method: "repo.task.run",
    commandClass: "repo-write",
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
  defineCliCommand({
    id: "task-artifact-add",
    phase: "W3",
    path: ["task", "artifact", "add", "<task-id>"],
    summary: "Publish an untracked UTF-8 artifact through canonical doc sync.",
    method: "repo.task.run",
    commandClass: "repo-write",
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
  defineCliCommand({
    id: "task-submit",
    phase: "W3",
    path: ["task", "submit", "<task-id>"],
    summary: "Atomically finalize an Execution and enter review.",
    method: "repo.task.run",
    commandClass: "repo-write",
    inputs: [
      cliInput("--execution-id", "single", false, {
        code: "invalid_field",
        nextAction: "Use one execution id only to assert the authenticated active lease explicitly.",
      }),
      cliInput(
        "--from-file",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Submit requires a complete submission JSON packet.",
        },
        { jsonFields: taskSubmissionJsonFields },
      ),
    ],
  }),
  defineCliCommand({
    id: "task-closeout",
    phase: "W3",
    path: ["task", "closeout", "<task-id>"],
    summary: [
      "Run submission, independent review, owner consent, and completion in ",
      "canonical order, resuming from the current closeout stage.",
    ].join(""),
    method: "repo.task.run",
    commandClass: "repo-write",
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
  defineCliCommand({
    id: "task-review-execution",
    phase: "W3",
    path: ["task", "review-execution", "<task-id>"],
    summary: "Append a canonical Execution Review.",
    method: "repo.task.run",
    commandClass: "arbiter",
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
  defineCliCommand({
    id: "task-review-consent",
    phase: "W3",
    path: ["task", "review-consent", "<task-id>"],
    summary: "Select a recorded Review with content-pinned owner consent.",
    method: "repo.task.run",
    commandClass: "repo-write",
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
  defineCliCommand({
    id: "task-code-doc-reconcile",
    phase: "W3",
    path: ["task", "code-doc", "reconcile", "<task-id>"],
    summary: "Publish a typed code-doc witness.",
    method: "repo.task.run",
    commandClass: "repo-write",
    inputs: [
      cliInput("--execution-id", "single", true, {
        code: "invalid_field",
        nextAction: "Reconcile requires execution-id, commit-sha, iteration, and path.",
      }),
      cliInput(
        "--commit-sha",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Reconcile requires a full commit sha.",
        },
        { regex: "^[0-9a-f]{40}$" },
      ),
      cliInput(
        "--iteration",
        "single",
        true,
        { code: "invalid_field", nextAction: "Iteration must be 0 or 1." },
        { enum: ["0", "1"] },
      ),
      cliInput("--path", "repeated", true, {
        code: "invalid_field",
        nextAction: "Reconcile requires at least one canonical path.",
      }),
    ],
  }),
  defineCliCommand({
    id: "task-complete",
    phase: "W3",
    path: ["task", "complete", "<task-id>"],
    summary: "Complete a reviewed and consented task after canonical gate checks.",
    method: "repo.task.run",
    commandClass: "repo-write",
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
  defineCliCommand({
    id: "task-show",
    phase: "W3",
    path: ["task", "show", "<task-id>"],
    summary: "Read the task projection.",
    method: "repo.task.run",
    commandClass: "repo-read",
    inputs: [],
  }),
  defineCliCommand({
    id: "receipt-show",
    phase: "W3",
    path: ["receipt", "show", "<op-id>"],
    summary: "Read a write receipt.",
    method: "repo.task.run",
    commandClass: "repo-read",
    inputs: [],
  }),
] as const);
