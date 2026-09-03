import type {
  EntityActionContract,
  EntityActionInputContract,
  EntityActionInputField,
} from "./entity-kind-registry.ts";
import { REVIEW_V1_SCHEMA } from "./review.ts";

const TASK_SUBMISSION_JSON_FIELDS = Object.freeze([
  "completionClaim",
  "deliverables",
  "outputs",
  "verificationNotes",
  "knownGaps",
  "residualRisks",
  "commitSha",
] as const);
const TASK_REVIEW_JSON_FIELDS = Object.freeze(["verdict", "reason", "evidenceChecked"] as const);

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
      error: Object.freeze({ code: required ? "missing_field" : "invalid_field" }),
    }),
  });
};

type TaskActionDeclaration = {
  readonly id:
    | "start"
    | "submit"
    | "review"
    | "complete"
    | "release"
    | "amend"
    | "archive"
    | "supersede"
    | "delete"
    | "reopen"
    | "contract-migrate";
  readonly ingress: string;
  readonly commandType: "StartExecution" | "SubmitExecution" | "RecordReview" | "CompleteTask" | null;
  readonly transitionId: "start_execution" | "submit_execution" | "record_execution_review" | "complete_task" | null;
  readonly implementation: "task-lifecycle" | "task-completion" | "catalog-runtime";
  readonly topology: "center-forward-write" | "ledger-write" | "local-arbiter";
  readonly coordination: "reserve" | "execute" | null;
  readonly targetIdField: "taskId" | "oldTaskId";
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

const taskMutationConcurrency: EntityActionContract["concurrency"] = Object.freeze({
  expectedVersion: Object.freeze({
    authority: "task/v2 canonical projection",
    default: "daemon-bound-projection-revision",
    conflict: "revision_conflict",
  }),
  leasePolicy: Object.freeze({ authority: "task-lease/v1", mode: "mutation-specific" }),
  occurrenceClaim: Object.freeze({ authority: "not-applicable" }),
  idempotency: Object.freeze({ authority: "operation-id", retry: "canonical-event-replay" }),
  artifactOwnership: Object.freeze({ owner: "task", refTemplate: "task/{taskId}" }),
});

const mutationCriterion = (id: string, failureCode: string, explain: string): EntityActionContract["criteria"] =>
  Object.freeze([{ ref: `repo-cell-task-mutation/${id}`, failureCode, explain }]);

const taskActionDeclarations = Object.freeze([
  {
    id: "start",
    ingress: "task-start",
    commandType: "StartExecution",
    transitionId: "start_execution",
    implementation: "task-lifecycle",
    topology: "center-forward-write",
    coordination: "reserve",
    targetIdField: "taskId",
    input: actionInput([
      taskIdInput,
      expectedVersionInput,
      cliField("executionId", "string", false, "--execution-id", "single"),
      cliField("ttlMs", "number", false, "--ttl-ms", "single", {
        regex: "^[1-9][0-9]*$",
        projection: "number",
      }),
      cliField("dryRun", "boolean", false, "--dry-run", "boolean"),
    ]),
    policyAction: "task-start",
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
    targetIdField: "taskId",
    input: actionInput(
      [
        taskIdInput,
        expectedVersionInput,
        cliField("executionId", "string", false, "--execution-id", "single"),
        cliField(
          "fromFile",
          "string",
          false,
          "--from-file",
          "single",

          { jsonFields: TASK_SUBMISSION_JSON_FIELDS, conflictsWith: ["--json-input"] },
        ),
        cliField(
          "jsonInput",
          "string",
          false,
          "--json-input",
          "single",

          { jsonFields: TASK_SUBMISSION_JSON_FIELDS, format: "<json|@->", conflictsWith: ["--from-file"] },
        ),
      ],
      [["fromFile", "jsonInput"]],
    ),
    policyAction: "task-submit",
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
    targetIdField: "taskId",
    input: actionInput([
      taskIdInput,
      expectedVersionInput,
      cliField("executionId", "string", false, "--execution-id", "single"),
      cliField("reviewId", "string", true, "--review-id", "single"),
      cliField("fromFile", "string", true, "--from-file", "single", {
        jsonFields: TASK_REVIEW_JSON_FIELDS,
        jsonEnums: { verdict: REVIEW_V1_SCHEMA.verdicts },
      }),
    ]),
    policyAction: "task-review-execution",
    criteria: Object.freeze([
      {
        ref: "task-lifecycle-review-transitions/review.validate",
        failureCode: "invalid_transition",
        explain:
          "The review targets the current submitted execution and its pinned content cut; " +
          "append-only Review history requires a new review id.",
      },
      {
        ref: "repo-cell-proof/proofFor.RecordReview",
        failureCode: "actor_unauthorized",
        explain: "The reviewer is independent of the submitting executor after Policy qualification.",
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
    targetIdField: "taskId",
    input: actionInput([
      taskIdInput,
      expectedVersionInput,
      cliField("executionId", "string", false, "--execution-id", "single"),
      cliField(
        "ci",
        "string",
        false,
        "--ci",
        "single",

        {
          enum: ["passed"],
        },
      ),
      cliField("paths", "string-array", false, "--path", "repeated"),
      cliField(
        "factHolds",
        "fact-hold-array",
        false,
        "--fact-holds",
        "repeated",

        {
          format: "<fact-id>:<rationale>",
          regex: "^(?:fact/)?F-[0-9A-HJKMNP-TV-Z]{8}:.+$",
          projection: "fact-hold-array",
        },
      ),
    ]),
    policyAction: "task-complete",
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
  {
    id: "release",
    ingress: "task-release",
    commandType: null,
    transitionId: null,
    implementation: "catalog-runtime",
    topology: "center-forward-write",
    coordination: null,
    targetIdField: "taskId",
    input: actionInput([
      taskIdInput,
      cliField("reason", "string", false, "--reason", "single"),
      { field: "terminalExecutionId", type: "string", required: false },
      { field: "terminalRuntimeSessionId", type: "string", required: false },
    ]),
    policyAction: "task-release",
    criteria: mutationCriterion(
      "release",
      "lease_conflict",
      "The Task has a releasable lease owned by the authenticated holder or an authorized recovery actor.",
    ),
    concurrency: taskMutationConcurrency,
    explain: "Release the current Task execution lease while preserving its audit history.",
  },
  {
    id: "amend",
    ingress: "task-amend",
    commandType: null,
    transitionId: null,
    implementation: "catalog-runtime",
    topology: "ledger-write",
    coordination: null,
    targetIdField: "taskId",
    input: actionInput([
      taskIdInput,
      cliField("patches", "json-object-array", true, "--set", "repeated", {
        format: "<field>:<value>",
      }),
    ]),
    policyAction: "task-amend",
    criteria: mutationCriterion(
      "amend",
      "invalid_amend",
      "The requested fields belong to the declared mutable Task metadata and no conflicting lease is active.",
    ),
    concurrency: taskMutationConcurrency,
    explain: "Amend declared Task prose or metadata through the canonical Task event stream.",
  },
  {
    id: "archive",
    ingress: "task-archive",
    commandType: null,
    transitionId: null,
    implementation: "catalog-runtime",
    topology: "ledger-write",
    coordination: null,
    targetIdField: "taskId",
    input: actionInput(
      [
        { ...taskIdInput, required: false },
        { field: "taskIds", type: "string-array", required: false },
        cliField("filter", "string", false, "--filter", "single"),
        cliField("before", "string", false, "--before", "single"),
        cliField("reason", "string", true, "--reason", "single"),
        cliField("archivedBy", "string", false, "--archived-by", "single"),
        cliField("archiveField", "string", false, "--archive-field", "single"),
      ],
      [["taskId", "taskIds", "filter"]],
    ),
    policyAction: "task-archive",
    criteria: mutationCriterion(
      "archive",
      "invalid_disposition",
      "Each selected Task is active, unleased, and eligible for archival.",
    ),
    concurrency: taskMutationConcurrency,
    explain: "Archive one or more Task packages while retaining canonical evidence and history.",
  },
  {
    id: "supersede",
    ingress: "task-supersede",
    commandType: null,
    transitionId: null,
    implementation: "catalog-runtime",
    topology: "ledger-write",
    coordination: null,
    targetIdField: "oldTaskId",
    input: actionInput(
      [
        { field: "oldTaskId", type: "string", required: true },
        cliField("title", "string", false, "--title", "single"),
        cliField("slug", "string", false, "--slug", "single"),
        cliField("byTaskId", "string", false, "--by", "single"),
        cliField("confirm", "string", false, "--confirm", "single"),
        cliField("reason", "string", false, "--reason", "single"),
        cliField("deletedBy", "string", false, "--deleted-by", "single"),
        cliField("allowOpenFindings", "boolean", false, "--allow-open-findings", "boolean"),
      ],
      [["title", "byTaskId"]],
    ),
    policyAction: "task-supersede",
    criteria: mutationCriterion(
      "supersede",
      "invalid_disposition",
      "The old Task is active, unleased, and names or creates one valid replacement.",
    ),
    concurrency: taskMutationConcurrency,
    explain: "Archive old work and preserve explicit replacement lineage.",
  },
  {
    id: "delete",
    ingress: "task-delete",
    commandType: null,
    transitionId: null,
    implementation: "catalog-runtime",
    topology: "ledger-write",
    coordination: null,
    targetIdField: "taskId",
    input: actionInput([
      taskIdInput,
      { field: "mode", type: "string", required: true, enum: ["soft", "hard"] },
      cliField("confirm", "string", false, "--confirm", "single"),
      cliField("reason", "string", false, "--reason", "single"),
      cliField("deletedBy", "string", false, "--deleted-by", "single"),
    ]),
    policyAction: "task-delete",
    criteria: mutationCriterion(
      "delete",
      "hard_delete_forbidden",
      "Production Task deletion is soft, auditable, and applies only without an active lease.",
    ),
    concurrency: taskMutationConcurrency,
    explain: "Soft-delete a Task through canonical disposition authority; hard delete remains forbidden.",
  },
  {
    id: "reopen",
    ingress: "task-reopen",
    commandType: null,
    transitionId: null,
    implementation: "catalog-runtime",
    topology: "ledger-write",
    coordination: null,
    targetIdField: "taskId",
    input: actionInput([taskIdInput, cliField("reason", "string", true, "--reason", "single")]),
    policyAction: "task-reopen",
    criteria: mutationCriterion(
      "reopen",
      "invalid_disposition",
      "The Task is nonterminal, unleased, and currently archived or tombstoned.",
    ),
    concurrency: taskMutationConcurrency,
    explain: "Reopen an archived or tombstoned nonterminal Task package.",
  },
  {
    id: "contract-migrate",
    ingress: "task-contract-migrate",
    commandType: null,
    transitionId: null,
    implementation: "catalog-runtime",
    topology: "ledger-write",
    coordination: null,
    targetIdField: "taskId",
    input: actionInput([
      { field: "taskId", type: "string", required: false },
      { field: "mode", type: "string", required: true, enum: ["dry-run", "apply"] },
      { field: "repairPresetSnapshotDigest", type: "string", required: false },
      { field: "repairTaskContractBody", type: "string", required: false },
      { field: "repairPresetId", type: "string", required: false },
      { field: "repairTaskClass", type: "string", required: false },
    ]),
    policyAction: "task-contract-migrate",
    criteria: mutationCriterion(
      "contract-migrate",
      "contract_current",
      "Each selected legacy Task has one deterministic task-contract/v1 backfill or repair.",
    ),
    concurrency: taskMutationConcurrency,
    explain: "Plan or apply deterministic Task contract backfills through the catalog runtime.",
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
                ...(declaration.commandType
                  ? [
                      {
                        field: "commandType" as const,
                        type: "string" as const,
                        required: false,
                        enum: [declaration.commandType],
                      },
                    ]
                  : []),
              ],
              declaration.input.exactlyOneOf,
            ),
            policy: Object.freeze({ ref: "default@5", action: declaration.policyAction }),
            criteria: Object.freeze([
              ...(declaration.transitionId
                ? [
                    {
                      ref: "task-lifecycle-contract-support/revisionIssues",
                      failureCode: "invalid_transition",
                      explain:
                        "The command expectedVersion equals the canonical Task projection revision at commit time.",
                    },
                  ]
                : []),
              ...declaration.criteria,
            ]),
            concurrency: declaration.concurrency,
            effects: Object.freeze(
              declaration.transitionId
                ? [
                    { ref: "task-lifecycle-publication/compileTaskLifecycleWrite", projection: "TaskProjection" },
                    { ref: `task-lifecycle-transitions/${declaration.transitionId}`, projection: "TaskProjection" },
                  ]
                : [{ ref: `repo-cell-task-mutation/${declaration.id}`, projection: "TaskProjection" }],
            ),
            returns: actionResultContract,
            explain: declaration.explain,
            execution: Object.freeze({
              ingress: declaration.ingress,
              compile: null,
              read: false,
              implementation: declaration.implementation,
              topology: declaration.topology,
              targetIdField: declaration.targetIdField,
              ...(declaration.transitionId && declaration.commandType && declaration.coordination
                ? {
                    lifecycle: Object.freeze({
                      transitionId: declaration.transitionId,
                      commandType: declaration.commandType,
                      targetIdField: "executionId",
                      coordination: declaration.coordination,
                    }),
                  }
                : {}),
            }),
          }),
      ),
    ),
  });
}
