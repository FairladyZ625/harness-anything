import type {
  EntityActionContract,
  EntityActionInputContract,
  EntityActionInputField,
} from "./entity-kind-registry.ts";

export const TASK_SUBMISSION_JSON_FIELDS = Object.freeze([
  "completionClaim",
  "deliverables",
  "outputs",
  "verificationNotes",
  "knownGaps",
  "residualRisks",
  "commitSha",
] as const);
export const TASK_REVIEW_JSON_FIELDS = Object.freeze(["verdict", "reason", "evidenceChecked"] as const);

const actionInput = (
  fields: readonly EntityActionInputField[],
  exactlyOneOf: readonly (readonly string[])[] = [],
): EntityActionInputContract =>
  Object.freeze({
    schema: "entity-action-input/v1",
    fields: Object.freeze(fields.map((field) => Object.freeze(field))),
    exactlyOneOf: Object.freeze(exactlyOneOf.map((group) => Object.freeze(group))),
  });
const taskIdInput: EntityActionInputField = Object.freeze({ field: "taskId", type: "string", required: true });
const expectedVersionInput: EntityActionInputField = Object.freeze({
  field: "expectedVersion",
  type: "number",
  required: false,
});
const cliField = (
  field: string,
  type: EntityActionInputField["type"],
  required: boolean,
  name: string,
  kind: NonNullable<EntityActionInputField["cli"]>["kind"],
  nextAction: string,
  extra: Omit<NonNullable<EntityActionInputField["cli"]>, "name" | "kind" | "error"> &
    Pick<EntityActionInputField, "enum" | "regex"> = {},
): EntityActionInputField => {
  const { enum: values, regex, ...cli } = extra;
  return Object.freeze({
    field,
    type,
    required,
    ...(values ? { enum: values } : {}),
    ...(regex ? { regex } : {}),
    cli: Object.freeze({
      ...cli,
      name,
      kind,
      error: Object.freeze({ code: required ? "missing_field" : "invalid_field", nextAction }),
    }),
  });
};

type TaskActionDeclaration = {
  readonly id: "start" | "submit" | "review" | "complete";
  readonly ingress: "task-start" | "task-submit" | "task-review-execution" | "task-complete";
  readonly commandType: "StartExecution" | "SubmitExecution" | "RecordReview" | "CompleteTask";
  readonly transitionId: "start_execution" | "submit_execution" | "record_execution_review" | "complete_task";
  readonly implementation: "task-lifecycle" | "task-completion";
  readonly topology: "center-forward-write" | "ledger-write" | "local-arbiter";
  readonly coordination: "reserve" | "execute";
  readonly input: EntityActionInputContract;
  readonly policyAction: string | null;
  readonly criteria: EntityActionContract["criteria"];
  readonly concurrency: EntityActionContract["concurrency"];
  readonly explain: string;
};

const taskConcurrency = (
  leasePolicy: Readonly<Record<string, unknown>>,
  idempotency: Readonly<Record<string, unknown>>,
): EntityActionContract["concurrency"] =>
  Object.freeze({
    expectedVersion: Object.freeze({
      authority: "task-lifecycle/revisionIssues",
      input: "expectedVersion",
      default: "daemon-bound-projection-revision",
      conflict: "invalid_transition",
    }),
    leasePolicy: Object.freeze(leasePolicy),
    occurrenceClaim: Object.freeze({ authority: "not-applicable" }),
    idempotency: Object.freeze(idempotency),
    artifactOwnership: Object.freeze({ owner: "execution", refTemplate: "execution/{executionId}" }),
  });

const taskActionDeclarations = Object.freeze([
  {
    id: "start",
    ingress: "task-start",
    commandType: "StartExecution",
    transitionId: "start_execution",
    implementation: "task-lifecycle",
    topology: "center-forward-write",
    coordination: "reserve",
    input: actionInput([
      taskIdInput,
      expectedVersionInput,
      cliField(
        "executionId",
        "string",
        false,
        "--execution-id",
        "single",
        "Use one execution id, or omit it for deterministic allocation.",
      ),
      cliField("ttlMs", "number", false, "--ttl-ms", "single", "Use a positive lease duration in milliseconds.", {
        regex: "^[1-9][0-9]*$",
        projection: "number",
      }),
      cliField("dryRun", "boolean", false, "--dry-run", "boolean", "Use --dry-run once to preview lease admission."),
    ]),
    policyAction: "execution.start",
    criteria: Object.freeze([
      {
        ref: "task-lifecycle-command-transitions/canStartExecution",
        failureCode: "invalid_transition",
        explain: "The task is in the implementation node with no active lease and the execution is the current round.",
      },
      {
        ref: "task-lifecycle-command-transitions/start.validate",
        failureCode: "invalid_proof",
        explain: "The authenticated actor binding and reservation proof match the command.",
      },
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "reserve", sameActorActiveLease: "idempotent-reuse" },
      { authority: "operation-id", sameActorActiveLease: "applied-no-op" },
    ),
    explain: "Acquire or idempotently reuse the authenticated actor's execution lease.",
  },
  {
    id: "submit",
    ingress: "task-submit",
    commandType: "SubmitExecution",
    transitionId: "submit_execution",
    implementation: "task-lifecycle",
    topology: "ledger-write",
    coordination: "execute",
    input: actionInput(
      [
        taskIdInput,
        expectedVersionInput,
        cliField(
          "executionId",
          "string",
          false,
          "--execution-id",
          "single",
          "Use one execution id only to assert the authenticated active lease explicitly.",
        ),
        cliField(
          "fromFile",
          "string",
          false,
          "--from-file",
          "single",
          "Use exactly one submission source: --json-input <json> or workspace-local --from-file <path>.",
          { jsonFields: TASK_SUBMISSION_JSON_FIELDS, conflictsWith: ["--json-input"] },
        ),
        cliField(
          "jsonInput",
          "string",
          false,
          "--json-input",
          "single",
          "Use exactly one submission source: --json-input <json> or workspace-local --from-file <path>.",
          { jsonFields: TASK_SUBMISSION_JSON_FIELDS, conflictsWith: ["--from-file"] },
        ),
      ],
      [["fromFile", "jsonInput"]],
    ),
    policyAction: null,
    criteria: Object.freeze([
      {
        ref: "task-lifecycle-command-transitions/submit.validate",
        failureCode: "invalid_transition",
        explain: "The active current execution is submitted with a valid submission packet.",
      },
      {
        ref: "actor-domain-services/heldLeaseForExecutionActor",
        failureCode: "lease_required",
        explain: "The authenticated actor owns the active execution lease at its current version.",
      },
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "fence-and-release", versionProof: "leaseVersion" },
      { authority: "operation-id", retry: "canonical-event-replay" },
    ),
    explain: "Atomically fence and release the execution lease while publishing its submission.",
  },
  {
    id: "review",
    ingress: "task-review-execution",
    commandType: "RecordReview",
    transitionId: "record_execution_review",
    implementation: "task-lifecycle",
    topology: "local-arbiter",
    coordination: "execute",
    input: actionInput([
      taskIdInput,
      expectedVersionInput,
      cliField(
        "executionId",
        "string",
        false,
        "--execution-id",
        "single",
        "Use one named current submitted execution only when the daemon reports ambiguity.",
      ),
      cliField("reviewId", "string", true, "--review-id", "single", "Review requires a review id."),
      cliField("fromFile", "string", true, "--from-file", "single", "Review requires a complete review JSON packet.", {
        jsonFields: TASK_REVIEW_JSON_FIELDS,
      }),
    ]),
    policyAction: "execution.review",
    criteria: Object.freeze([
      {
        ref: "task-lifecycle-review-transitions/review.validate",
        failureCode: "invalid_transition",
        explain: "The review targets the current submitted execution and its pinned content cut.",
      },
      {
        ref: "repo-cell-proof/proofFor.RecordReview",
        failureCode: "actor_unauthorized",
        explain: "The reviewer has the arbiter capability and is independent of the submitting executor.",
      },
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "must-be-released" },
      { authority: "operation-id", semanticKey: "reviewId" },
    ),
    explain: "Record an independent, content-pinned review for the submitted execution.",
  },
  {
    id: "complete",
    ingress: "task-complete",
    commandType: "CompleteTask",
    transitionId: "complete_task",
    implementation: "task-completion",
    topology: "ledger-write",
    coordination: "execute",
    input: actionInput([
      taskIdInput,
      expectedVersionInput,
      cliField(
        "executionId",
        "string",
        false,
        "--execution-id",
        "single",
        "Use one closeout execution id only when the daemon reports ambiguity.",
      ),
      cliField(
        "ci",
        "string",
        false,
        "--ci",
        "single",
        "Use --ci passed only for a successful canonical checker result.",
        {
          enum: ["passed"],
        },
      ),
      cliField(
        "paths",
        "string-array",
        false,
        "--path",
        "repeated",
        "Provide each canonical code path; the submitted commit and iteration are derived automatically.",
      ),
      cliField(
        "factHolds",
        "fact-hold-array",
        false,
        "--fact-holds",
        "repeated",
        "Use --fact-holds F-XXXXXXXX:<non-empty-rationale> once per standing upstream Fact.",
        {
          format: "<fact-id>:<rationale>",
          regex: "^(?:fact/)?F-[0-9A-HJKMNP-TV-Z]{8}:.+$",
          projection: "fact-hold-array",
        },
      ),
    ]),
    policyAction: "task.complete",
    criteria: Object.freeze([
      {
        ref: "closeout-readiness/closeoutReadiness",
        failureCode: "completion_blocked",
        explain: "The submitted execution has approved consent and every canonical completion gate is ready.",
      },
      {
        ref: "task-lifecycle-review-transitions/complete.validate",
        failureCode: "invalid_proof",
        explain: "Completion authority, released lease, and the typed gate receipt cut are valid.",
      },
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "must-be-released" },
      { authority: "operation-id", retry: "closeout-stage-resume" },
    ),
    explain: "Complete the reviewed execution after canonical closeout readiness and gate checks.",
  },
] as const satisfies readonly TaskActionDeclaration[]);

export function createTaskActionCatalog(
  baseAction: (id: TaskActionDeclaration["id"]) => EntityActionContract,
  actionResultContract: EntityActionContract["returns"],
) {
  return Object.freeze({
    ref: "kernel/task-action/v1",
    actions: Object.freeze(
      taskActionDeclarations.map(
        (declaration): EntityActionContract =>
          Object.freeze({
            ...baseAction(declaration.id),
            input: actionInput(
              [
                ...declaration.input.fields,
                ...(declaration.id === "submit" || declaration.id === "complete"
                  ? [
                      {
                        field: "verb" as const,
                        type: "string" as const,
                        required: false,
                        enum: [declaration.ingress.slice("task-".length)],
                      },
                    ]
                  : []),
                { field: "commandType", type: "string", required: false, enum: [declaration.commandType] },
              ],
              declaration.input.exactlyOneOf,
            ),
            policy: Object.freeze({ ref: "default@3", action: declaration.policyAction }),
            criteria: Object.freeze([
              {
                ref: "task-lifecycle-contract-support/revisionIssues",
                failureCode: "invalid_transition",
                explain: "The command expectedVersion equals the canonical Task projection revision at commit time.",
              },
              ...declaration.criteria,
            ]),
            concurrency: declaration.concurrency,
            effects: Object.freeze([
              { ref: "task-lifecycle-publication/compileTaskLifecycleWrite", projection: "TaskProjection" },
              { ref: `task-lifecycle-transitions/${declaration.transitionId}`, projection: "TaskProjection" },
            ]),
            returns: actionResultContract,
            explain: declaration.explain,
            execution: Object.freeze({
              ingress: declaration.ingress,
              compile: null,
              read: false,
              implementation: declaration.implementation,
              topology: declaration.topology,
              lifecycle: Object.freeze({
                transitionId: declaration.transitionId,
                commandType: declaration.commandType,
                targetIdField: "executionId",
                coordination: declaration.coordination,
              }),
            }),
          }),
      ),
    ),
  });
}
