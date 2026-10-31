import { field, cli, objectField, input } from "./task-action-input.ts";
import { SUBMISSION_V1_SCHEMA } from "./execution.ts";
import { REVIEW_V1_SCHEMA } from "./review.ts";
import { WRITE_RECEIPT_SCHEMA } from "./receipt-domain-registry.ts";
import { settingsLocales } from "./settings.ts";
import { taskClasses } from "./task.ts";
import { priorityTiers, taskWorkKinds } from "./task-metadata.ts";
import type {
  EntityActionContract,
  EntityActionInputContract,
  EntityActionInputField,
} from "./entity-kind-registry.ts";
import { withDerivedActionReturns } from "./entity-action-descriptor.ts";
import { all, equals, stateTransition } from "./task-action-state-transition.ts";

const wire = (
  value: EntityActionInputField,
  constraints: NonNullable<EntityActionInputField["wire"]>,
): EntityActionInputField => Object.freeze({ ...value, wire: Object.freeze(constraints) });

const stringArrayValue = Object.freeze({ kind: "array" as const, items: Object.freeze({ kind: "string" as const }) });
// The completion contract is resolved by the center at submit, never supplied by the caller.
const submissionFields = Object.freeze(
  SUBMISSION_V1_SCHEMA.required
    .filter((name) => name !== "completionContract")
    .map((name) =>
      Object.freeze({
        field: name,
        type: (name === "completionClaim" || name === "commitSha" ? "string" : "string-array") as
          | "string"
          | "string-array",
        required: true,
        value: name === "completionClaim" || name === "commitSha" ? { kind: "string" as const } : stringArrayValue,
      }),
    ),
);
const reviewFields = Object.freeze(
  REVIEW_V1_SCHEMA.inputRequired.map((name) =>
    Object.freeze({
      field: name,
      type: (name === "evidenceChecked" ? "string-array" : "string") as "string" | "string-array",
      required: true,
      value:
        name === "evidenceChecked"
          ? stringArrayValue
          : Object.freeze({
              kind: "string" as const,
              ...(name === "verdict" ? { enumRef: REVIEW_V1_SCHEMA.verdicts } : {}),
            }),
      ...(name === "verdict" ? { enum: REVIEW_V1_SCHEMA.verdicts } : {}),
    }),
  ),
);
const reviewPacketFields = Object.freeze([
  ...reviewFields,
  field("findings", "json-object-array", true),
  field("resolutions", "json-object-array", false),
]);
const createPacketFields = Object.freeze([
  field("squadRunId", "string", false, undefined, "^squad_[a-f0-9]{24}$"),
  field("title", "string", true),
  wire(field("taskId"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
  wire(field("decisionRef"), { pattern: "^dec_[A-Za-z0-9_-]+(?:/CH[1-9][0-9]*)?$" }),
  field("idempotencyKey"),
  wire(field("parentTaskId"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
  field("workKind", "string", false, taskWorkKinds),
  field("riskTier", "string", false, priorityTiers),
  field("urgency", "string", false, priorityTiers),
  field("verticalId"),
  wire(field("presetId"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
  wire(field("profileId"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
  field("slug", "string", false, undefined, "^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$"),
  field("surfaces", "string-array"),
  field("taskClass", "string", false, taskClasses),
  field("locale", "string", false, settingsLocales),
  wire(field("createMode", "string", false, ["migration", "import", "admin"]), { omit: true }),
]);
const packet = (schemaRef: string, fields: readonly EntityActionInputField[]) => Object.freeze({ schemaRef, fields });
const packetSources = (schemaRef: string, fields: readonly EntityActionInputField[], errorCode = "invalid_field") => [
  cli(
    "fromFile",
    "string",
    false,
    "--from-file",
    "single",
    {
      jsonSchema: packet(schemaRef, fields),
      conflictsWith: ["--json-input"],
    },
    errorCode,
  ),
  cli(
    "jsonInput",
    "string",
    false,
    "--json-input",
    "single",
    {
      jsonSchema: packet(schemaRef, fields),
      format: "<json|@->",
      conflictsWith: ["--from-file"],
    },
    errorCode,
  ),
];
const taskId = wire(field("taskId", "string", true), { pattern: "^[A-Za-z0-9_-]{1,96}$" });
const expectedVersion = field("expectedVersion", "number");
const optionalPacketFields = (fields: readonly EntityActionInputField[]) =>
  fields.map((item) => Object.freeze({ ...item, required: false }));

const createInput = input([
  field("squadRunId", "string", false, undefined, "^squad_[a-f0-9]{24}$"),
  cli("title", "string", false, "--title", "single", {}, "missing_field"),
  wire(cli("taskId", "string", false, "--id"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
  cli("idempotencyKey", "string", false, "--idempotency-key"),
  wire(cli("parentTaskId", "string", false, "--work"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
  wire(cli("decisionRef", "string", false, "--decision"), {
    pattern: "^dec_[A-Za-z0-9_-]+(?:/CH[1-9][0-9]*)?$",
  }),
  cli("workKind", "string", false, "--kind", "single", { enum: taskWorkKinds }),
  cli("riskTier", "string", false, "--risk-tier", "single", { enum: priorityTiers }),
  cli("urgency", "string", false, "--urgency", "single", { enum: priorityTiers }),
  ...packetSources("TaskCreateInput/v1", createPacketFields),
  cli("verticalId", "string", false, "--vertical"),
  wire(cli("presetId", "string", false, "--preset"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
  wire(cli("profileId", "string", false, "--profile"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
  cli("slug", "string", false, "--slug", "single", {
    regex: "^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$",
  }),
  cli("surfaces", "string-array", false, "--surface", "repeated"),
  cli("taskClass", "string", false, "--task-class", "single", { enum: taskClasses }),
  wire(cli("planFile", "string", false, "--plan-file", "single"), { omit: true }),
  cli("dryRun", "boolean", false, "--dry-run", "boolean"),
  cli("locale", "string", false, "--locale", "single", { enum: settingsLocales }),
  wire(cli("migration", "boolean", false, "--migration", "boolean"), { omit: true }),
  wire(cli("import", "boolean", false, "--import", "boolean"), { omit: true }),
  wire(cli("admin", "boolean", false, "--admin", "boolean"), { omit: true }),
  wire(field("createMode", "string", false, ["migration", "import", "admin"]), { omit: true }),
  wire(field("plan", "string"), { maxLength: 32 * 1024 }),
]);

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
const mutationConcurrency: EntityActionContract["concurrency"] = Object.freeze({
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
const criterion = (ref: string, failureCode: string, explain: string) => Object.freeze({ ref, failureCode, explain });

const lifecycleSpecs = Object.freeze({
  create: {
    ingress: "task-create",
    commandType: "CreateReplayTask",
    transitionId: "create_replay_task",
    implementation: "task-lifecycle",
    topology: "center-forward-write",
    remoteEdgeAdmission: "via-center-forward",
    coordination: "execute",
    eventType: "task_created",
    proof: ["taskIdUnique", "actorBinding", "validGraph"],
    // Creation never reaches the lifecycle runtime: its compile and graph refusals are attributed
    // by `createTask`, so no single criterion owns a rejected invocation here.
    validatorCriterionRef: null,
  },
  start: {
    ingress: "task-start",
    commandType: "StartExecution",
    transitionId: "start_execution",
    implementation: "task-lifecycle",
    topology: "center-forward-write",
    remoteEdgeAdmission: "via-center-forward",
    coordination: "reserve",
    eventType: "execution_started",
    proof: ["actorBinding", "deliveryBaseline", "reservation"],
    validatorCriterionRef: "task-lifecycle-command-transitions/start.validate",
  },
  transition: {
    ingress: "task-transition",
    commandType: "TransitionTask",
    transitionId: "transition_task",
    implementation: "task-lifecycle",
    topology: "ledger-write",
    remoteEdgeAdmission: "via-center-forward",
    coordination: "execute",
    eventType: "task_transitioned",
    proof: ["auditedReasonWhenRequired"],
    validatorCriterionRef: "lifecycle-status/explainStatusTransition",
  },
  submit: {
    ingress: "task-submit",
    commandType: "SubmitExecution",
    transitionId: "submit_execution",
    implementation: "task-lifecycle",
    topology: "ledger-write",
    remoteEdgeAdmission: "via-center-forward",
    coordination: "execute",
    eventType: "execution_submitted",
    proof: ["actorBinding", "leaseVersion-or-submitted-cut", "submission"],
    validatorCriterionRef: "task-lifecycle-command-transitions/submit.validate",
  },
  review: {
    ingress: "task-review-execution",
    commandType: "RecordReview",
    transitionId: "record_execution_review",
    implementation: "task-lifecycle",
    topology: "local-arbiter",
    remoteEdgeAdmission: "via-center-forward",
    coordination: "execute",
    eventType: "review_recorded",
    proof: ["independentActor", "execution-review@v1", "contentCut"],
    validatorCriterionRef: "task-lifecycle-review-transitions/review.validate",
  },
  respondReview: {
    ingress: "task-respond-review",
    commandType: "RespondReview",
    transitionId: "respond_review",
    implementation: "task-lifecycle",
    topology: "ledger-write",
    remoteEdgeAdmission: "via-center-forward",
    coordination: "execute",
    eventType: "task_review_responded",
    proof: ["actorBinding", "execution-review-response@v1", "contentCut"],
    validatorCriterionRef: "task-lifecycle-review-transitions/respondReview.validate",
  },
  rework: {
    ingress: "task-rework",
    commandType: "ReworkTask",
    transitionId: "rework_task",
    implementation: "task-lifecycle",
    topology: "ledger-write",
    remoteEdgeAdmission: "via-center-forward",
    coordination: "execute",
    eventType: "submission_returned",
    proof: ["ownerActor", "task-rework@v1", "exhaustedBudgetOrOwnerBlocker", "auditableReason"],
    validatorCriterionRef: "task-lifecycle-command-transitions/rework.validate",
  },
  consent: {
    ingress: "task-review-consent",
    commandType: "RecordReviewConsent",
    transitionId: "record_review_consent",
    implementation: "task-lifecycle",
    topology: "ledger-write",
    remoteEdgeAdmission: "via-center-forward",
    coordination: "execute",
    eventType: "review_consent_recorded" as "review_consent_recorded" | "review_consent_overridden",
    proof: ["ownerActor", "execution-consent@v1", "reviewDigest", "contentDigest", "submissionDigest"],
    validatorCriterionRef: "task-lifecycle-review-transitions/consent.validate",
  },
  complete: {
    ingress: "task-complete",
    commandType: "CompleteTask",
    transitionId: "complete_task",
    implementation: "task-completion",
    topology: "ledger-write",
    remoteEdgeAdmission: "via-center-forward",
    coordination: "execute",
    eventType: "task_completed",
    proof: ["ownerOrCommander", "reviewConsent", "typedGateReceipts", "noActiveLease"],
    validatorCriterionRef: "task-lifecycle-review-transitions/complete.validate",
  },
} as const);
type LifecycleId = keyof typeof lifecycleSpecs;
type LifecycleSpec = (typeof lifecycleSpecs)[LifecycleId];

interface Declaration {
  readonly id: string;
  readonly ingress: LifecycleSpec["ingress"] | `task-${string}`;
  readonly commandType: LifecycleSpec["commandType"] | null;
  readonly transitionId: LifecycleSpec["transitionId"] | null;
  readonly implementation: LifecycleSpec["implementation"] | "catalog-runtime";
  readonly topology: LifecycleSpec["topology"];
  /** Lifecycle actions always forward to the center; catalog-runtime mutations refuse edge writes. */
  readonly remoteEdgeAdmission: "via-center-forward" | "rejected";
  readonly coordination: LifecycleSpec["coordination"] | null;
  readonly eventType: LifecycleSpec["eventType"] | null;
  readonly proof: LifecycleSpec["proof"] | readonly [];
  /** The criterion a rejected invocation is attributed to; see EntityActionExecutionContract. */
  readonly validatorCriterionRef: LifecycleSpec["validatorCriterionRef"] | null;
  readonly targetIdField: string;
  readonly input: EntityActionInputContract;
  readonly criteria: EntityActionContract["criteria"];
  readonly concurrency: EntityActionContract["concurrency"];
  readonly explain: string;
}

const lifecycle = (
  id: LifecycleId,
  value: Pick<Declaration, "input" | "criteria" | "concurrency" | "explain">,
): Declaration => {
  const spec = lifecycleSpecs[id];
  return Object.freeze({
    ...value,
    id,
    ...spec,
    targetIdField: "taskId",
  });
};
const mutation = (
  id: string,
  actionInput: EntityActionInputContract,
  failureCode: string,
  criterionExplain: string,
  explain: string,
  targetIdField = "taskId",
): Declaration =>
  Object.freeze({
    id,
    ingress: `task-${id}`,
    commandType: null,
    transitionId: null,
    implementation: "catalog-runtime",
    topology: id === "release" ? "center-forward-write" : "ledger-write",
    remoteEdgeAdmission: id === "release" ? "via-center-forward" : "rejected",
    coordination: null,
    eventType: null,
    proof: Object.freeze([] as const),
    validatorCriterionRef: null,
    targetIdField,
    input: actionInput,
    criteria: Object.freeze([criterion(`repo-cell-task-mutation/${id}`, failureCode, criterionExplain)]),
    concurrency: mutationConcurrency,
    explain,
  });

export const declarations: readonly Declaration[] = Object.freeze([
  ...["claim", "settle", "revoke", "rerun"].map((operation) =>
    mutation(
      `witness-${operation}`,
      input([
        taskId,
        cli("executionId", "string", true, "--execution-id"),
        cli("gateId", "string", true, "--gate"),
        ...(operation === "claim" ? [] : [cli("runId", "string", true, "--run-id")]),
        ...(operation === "settle"
          ? [field("claimFence", "number"), field("diagnostic"), field("evidence", "json-object")]
          : []),
        ...(operation === "revoke" || operation === "rerun" ? [cli("reason", "string", true, "--reason")] : []),
      ]),
      "gate_run_stale",
      "The current submission, run identity, central source authority and claim fence agree.",
      `Apply the ${operation} transition to an Execution gate run through its owning Task.`,
    ),
  ),
  lifecycle("create", {
    input: createInput,
    criteria: Object.freeze([
      criterion(
        "preset-bootstrap/compileTaskPackage",
        "invalid_scaffold",
        "The resolved preset produces the required replay/v1 task package without path collisions.",
      ),
      criterion(
        "task-graph/validateTaskGraphV1",
        "invalid_graph_shape",
        "The task uses the canonical two-node replay/v1 graph.",
      ),
    ]),
    concurrency: mutationConcurrency,
    explain: "Create a canonical replay/v1 Task and its declared scaffold artifacts.",
  }),
  lifecycle("start", {
    input: input([
      field("squadRunId", "string", false, undefined, "^squad_[a-f0-9]{24}$"),
      taskId,
      wire(cli("stackOn", "string", false, "--stack-on"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
      expectedVersion,
      wire(cli("executionId", "string", false, "--execution-id"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
      wire(
        cli("ttlMs", "number", false, "--ttl-ms", "single", {
          regex: "^[1-9][0-9]*$",
          projection: "number",
        }),
        { minimum: 1 },
      ),
      cli("dryRun", "boolean", false, "--dry-run", "boolean"),
    ]),
    criteria: Object.freeze([
      criterion(
        "task-lifecycle-command-transitions/canStartExecution",
        "invalid_transition",
        "The task is in the implementation node with no active lease and the execution is the current round.",
      ),
      criterion(
        "task-lifecycle-command-transitions/start.validate",
        "invalid_proof",
        "The authenticated actor binding and reservation proof match the command.",
      ),
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "reserve", sameActorActiveLease: "idempotent-reuse" },
      { authority: "operation-id", sameActorActiveLease: "applied-no-op" },
    ),
    explain: "Acquire or idempotently reuse the actor's execution lease; checks out its Harness-managed worktree.",
  }),
  lifecycle("transition", {
    input: input([
      taskId,
      expectedVersion,
      wire(field("status", "string", true, ["planned", "active", "blocked", "in_review", "done", "cancelled"]), {
        enum: ["blocked"],
      }),
      wire(cli("reason", "string", false, "--reason"), { required: true }),
      cli("force", "boolean", false, "--force", "boolean"),
    ]),
    criteria: Object.freeze([
      criterion(
        "lifecycle-status/explainStatusTransition",
        "invalid_transition",
        "The requested status transition is allowed and leaves the graph cursor unchanged.",
      ),
    ]),
    concurrency: mutationConcurrency,
    explain: "Move the canonical Task status while preserving its independent graph cursor.",
  }),
  lifecycle("submit", {
    input: input([
      taskId,
      expectedVersion,
      wire(cli("executionId", "string", false, "--execution-id"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
      cli("commitSha", "string", false, "--commit", "single", { regex: "^[0-9a-f]{40}$" }),
      cli("amend", "boolean", false, "--amend", "boolean"),
      cli("asOwner", "boolean", false, "--as-owner", "boolean"),
      ...optionalPacketFields(submissionFields),
      field("submission", "json-object"),
    ]),
    criteria: Object.freeze([
      criterion(
        "task-lifecycle-command-transitions/submit.validate",
        "invalid_transition",
        "The active current execution is submitted with a valid submission packet.",
      ),
      criterion(
        "repo-cell-proof/proofFor.SubmitExecution",
        "lease_required",
        "The actor owns the active lease or the submitted execution being amended, or owns the task with --as-owner. " +
          "When no lease is held, ha task start reconnects to the active execution first.",
      ),
    ]),
    concurrency: taskConcurrency(
      {
        authority: "task-lease/v1",
        mode: "fence-and-release-on-initial-submit",
        amendment: "unleased-current-execution",
        versionProof: "leaseVersion",
      },
      { authority: "operation-id", retry: "canonical-event-replay" },
    ),
    explain: "Publish or amend the current cut and automatically dispatch its required reviewers.",
  }),
  lifecycle("review", {
    input: input(
      [
        taskId,
        expectedVersion,
        wire(cli("executionId", "string", false, "--execution-id"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
        wire(cli("reviewId", "string", true, "--review-id"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
        ...optionalPacketFields(reviewFields),
        ...packetSources(REVIEW_V1_SCHEMA.id, reviewPacketFields),
      ],
      [["fromFile", "jsonInput"]],
    ),
    criteria: Object.freeze([
      criterion(
        "task-lifecycle-review-transitions/review.validate",
        "invalid_transition",
        "The review targets the current submitted execution and its pinned content cut; " +
          "append-only Review history requires a new review id.",
      ),
      criterion(
        "repo-cell-proof/proofFor.RecordReview",
        "actor_unauthorized",
        "The reviewer is independent of the submitting executor after Policy qualification.",
      ),
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "must-be-released" },
      { authority: "operation-id", semanticKey: "reviewId" },
    ),
    explain: "Record an independent, content-pinned review; changes_requested below the rework budget reopens rework.",
  }),
  lifecycle("respondReview", {
    input: input([
      taskId,
      expectedVersion,
      wire(cli("executionId", "string", true, "--execution-id"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
      ...packetSources("TaskReviewRespondInput/v1", [field("responses", "json-object-array", true)]),
    ]),
    criteria: Object.freeze([
      criterion(
        "task-lifecycle-review-transitions/respondReview.validate",
        "invalid_transition",
        "The worker response targets every named blocking finding on a prior returned cut exactly once.",
      ),
      criterion(
        "repo-cell-proof/proofFor.RespondReview",
        "actor_unauthorized",
        "The response is written by the current implementation execution actor.",
      ),
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "held-current-execution" },
      { authority: "operation-id", semanticKey: "reviewId/findingId" },
    ),
    explain: "Respond to each blocking review finding before the next task submission freezes the responses.",
  }),
  lifecycle("rework", {
    input: input([
      taskId,
      expectedVersion,
      field("executionId", "string", false),
      field("reviewId", "string", false),
      cli("reason", "string", true, "--reason"),
    ]),
    criteria: Object.freeze([
      criterion(
        "task-lifecycle-command-transitions/rework.validate",
        "invalid_transition",
        "The owner returns any unleased in_review cut with an auditable reason.",
      ),
      criterion(
        "repo-cell-proof/proofFor.ReworkTask",
        "invalid_proof",
        "The authenticated task-owning principal supplies an auditable reason.",
      ),
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "must-be-released" },
      { authority: "operation-id", semanticKey: "taskId/executionId/reviewId" },
    ),
    explain:
      "Return exhausted, owner-blocked, or owner-consented cuts to rework with an owner reason; resume the worker.",
  }),
  lifecycle("consent", {
    input: input([
      taskId,
      expectedVersion,
      // Consent is an owner signature on a named cut and review; stating both ids is what makes
      // the write explicit, so a probing call without them never reaches the ledger.
      wire(cli("executionId", "string", true, "--execution-id"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
      wire(cli("reviewId", "string", true, "--review-id"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
      cli("dispose", "string-array", false, "--dispose", "repeated"),
      cli("rationale", "string", false, "--rationale"),
    ]),
    criteria: Object.freeze([
      criterion(
        "task-lifecycle-review-transitions/consent.validate",
        "invalid_proof",
        "Consent selects an approved review or an owner-disposed changes_requested review of the current submission and pins review, content, and submission digests; owner override requires the task owner's principal and a rationale for every disposed review.",
      ),
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "must-be-released" },
      { authority: "operation-id", semanticKey: "reviewId" },
    ),
    explain: "Select a recorded Review with content-pinned owner consent.",
  }),
  lifecycle("complete", {
    input: input([
      taskId,
      expectedVersion,
      wire(cli("executionId", "string", false, "--execution-id"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
      field("ci"),
      cli("resolvedBy", "string", false, "--resolved-by"),
      cli("resolutionRationale", "string", false, "--resolution-rationale"),
      cli("resolutionFact", "string", false, "--resolution-fact"),
      {
        ...cli("factHolds", "fact-hold-array", false, "--fact-holds", "repeated", {
          format: "<fact-id>:<rationale>",
          regex: "^(?:fact/)?F-[0-9A-HJKMNP-TV-Z]{8}:.+$",
          projection: "fact-hold-array",
        }),
        fields: [field("factRef", "string", true), field("rationale", "string", true)],
      },
    ]),
    criteria: Object.freeze([
      criterion(
        "closeout-readiness/closeoutReadiness",
        "completion_blocked",
        "The submitted execution has approved consent and every canonical completion gate is ready.",
      ),
      criterion(
        "task-lifecycle-review-transitions/complete.validate",
        "invalid_proof",
        "Completion authority, released lease, and the typed gate receipt cut are valid.",
      ),
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "must-be-released" },
      { authority: "operation-id", retry: "closeout-stage-resume" },
    ),
    explain: "Complete; use --resolved-by with rationale + Fact for sibling fixes, replacing cancel + relate.",
  }),
  mutation(
    "release",
    input([
      taskId,
      cli("reason", "string", false, "--reason"),
      field("squadRunId", "string", false, undefined, "^squad_[a-f0-9]{24}$"),
      wire(field("executionId"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
      wire(field("terminalExecutionId"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
      wire(field("terminalRuntimeSessionId"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
      field("terminalProcessGroupPid", "number", false),
    ]),
    "lease_conflict",
    "The Task has a releasable lease owned by the authenticated holder or an authorized recovery actor.",
    "Release the current Task execution lease while preserving its audit history.",
  ),
  mutation(
    "amend",
    input([taskId, cli("patches", "json-object-array", true, "--set", "repeated", { format: "<field>:<value>" })]),
    "invalid_amend",
    "The requested fields belong to the declared mutable Task metadata and no conflicting lease is active.",
    "Amend declared Task prose or metadata through the canonical Task event stream.",
  ),
  mutation(
    "archive",
    input(
      [
        wire(field("taskId"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
        field("taskIds", "string-array"),
        cli("filter", "string", false, "--filter"),
        cli("before", "string", false, "--before"),
        cli("reason", "string", true, "--reason"),
        cli("archivedBy", "string", false, "--archived-by"),
        cli("archiveField", "string", false, "--archive-field"),
      ],
      [["taskId", "taskIds", "filter"]],
    ),
    "invalid_disposition",
    "Each selected Task is active, unleased, and eligible for archival.",
    "Archive one or more Task packages while retaining canonical evidence and history.",
  ),
  mutation(
    "supersede",
    input(
      [
        field("oldTaskId", "string", true),
        cli("title", "string", false, "--title"),
        cli("slug", "string", false, "--slug"),
        cli("byTaskId", "string", false, "--by"),
        cli("confirm", "string", false, "--confirm"),
        cli("reason", "string", false, "--reason"),
        cli("deletedBy", "string", false, "--deleted-by"),
        cli("allowOpenFindings", "boolean", false, "--allow-open-findings", "boolean"),
      ],
      [["title", "byTaskId"]],
    ),
    "invalid_disposition",
    "The old Task is active, unleased, and names or creates one valid replacement.",
    "Archive old work and preserve explicit replacement lineage.",
    "oldTaskId",
  ),
  mutation(
    "delete",
    input([
      taskId,
      field("mode", "string", true, ["soft", "hard"]),
      cli("confirm", "string", false, "--confirm"),
      cli("reason", "string", false, "--reason"),
      cli("deletedBy", "string", false, "--deleted-by"),
    ]),
    "hard_delete_forbidden",
    "Production Task deletion is soft, auditable, and applies only without an active lease.",
    "Soft-delete a Task through canonical disposition authority; hard delete remains forbidden.",
  ),
  mutation(
    "reopen",
    input([taskId, cli("reason", "string", true, "--reason")]),
    "invalid_disposition",
    "The Task is nonterminal, unleased, and currently archived or tombstoned.",
    "Reopen an archived or tombstoned nonterminal Task package.",
  ),
  mutation(
    "contract-migrate",
    input([
      wire(field("taskId"), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
      field("mode", "string", true, ["dry-run", "apply"]),
      field("repairPresetSnapshotDigest"),
      field("repairTaskContractBody"),
      field("repairPresetId"),
      field("repairTaskClass"),
    ]),
    "contract_current",
    "Each selected legacy Task has one deterministic task-contract/v1 backfill or repair.",
    "Plan or apply deterministic Task contract backfills through the catalog runtime.",
  ),
]);

const receiptFields: readonly EntityActionInputField[] = Object.freeze(
  [...WRITE_RECEIPT_SCHEMA.required, ...WRITE_RECEIPT_SCHEMA.optional].map((name) => {
    if (name === "next") return field(name, "json-object-array");
    if (name !== "proof")
      return field(
        name,
        name === "revision" || name === "expectedVersion"
          ? "number"
          : name === "outcome" || name === "opId" || name === "status"
            ? "string"
            : "json-object",
        WRITE_RECEIPT_SCHEMA.required.includes(name as never),
        name === "outcome" ? WRITE_RECEIPT_SCHEMA.outcomes : undefined,
      );
    const fields = Object.freeze([
      field("committedRevision", "number"),
      field("appliedCut", "number"),
      field("ackCut", "number"),
      field("durable", "boolean", true),
      field("canonicalVisible", "boolean", true),
      field("worktreeVisible", "boolean", true),
    ]);
    return objectField(name, fields);
  }),
);
const lifecycleResult = Object.freeze({
  schema: "entity-action-result/v2" as const,
  baseSchemaRef: WRITE_RECEIPT_SCHEMA.id,
  fields: receiptFields,
  obligations: Object.freeze([]),
});
const createResult = Object.freeze({
  ...lifecycleResult,
  fields: Object.freeze([
    ...receiptFields,
    wire(field("taskId", "string", true), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
    field("taskStatus", "string", true, ["planned"]),
    field("packagePath", "string", true),
    field("generatedPaths", "string-array", true),
    field("presetDigest", "string", true),
    field("scaffoldDigest", "string", true),
    wire(field("presetId", "string", true), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
    wire(field("profileId", "string", true), { pattern: "^[A-Za-z0-9_-]{1,96}$" }),
    field("outputShape", "string", true),
    field("completionGates", "string-array", true),
    field("dryRun", "boolean", true),
  ]),
  obligations: Object.freeze([
    Object.freeze({ kind: "repository-diff" as const, when: equals("result.outputShape", "repository-diff") }),
  ]),
});

const createFailureCodes = Object.freeze([
  "missing_field",
  "decision_required",
  "decision_not_found",
  "decision_not_in_effect",
  "decision_clause_not_found",
  "invalid_field",
  "invalid_command",
  "invalid_title",
  "invalid_task_class",
  "task_class_required",
  "task_class_mismatch",
  "invalid_task_scaffold",
  "settings_projection_unavailable",
  "snapshot_mismatch",
  "invalid_scaffold",
  "invalid_bootstrap",
  "invalid_node_set",
  "invalid_graph_shape",
  "invalid_return_edge",
  "invalid_forward_path",
  "forward_fan_out",
  "forward_cycle",
]);

function failureCodes(declaration: Declaration): EntityActionContract["failureCodes"] {
  const inputs = declaration.input.fields.flatMap((item) => (item.cli ? [item.cli.error.code] : [])),
    transitions = declaration.transitionId
      ? [
          "invalid_transition",
          "invalid_proof",
          "invalid_schema",
          ...(declaration.id === "transition" ? ["missing_field", "force_reason_required"] : []),
          ...(declaration.id === "review" ? ["manual_intervention_required"] : []),
        ]
      : [],
    codes = [
      ...(declaration.id === "create" ? createFailureCodes : []),
      ...inputs,
      ...transitions,
      ...declaration.criteria.map(({ failureCode }) => failureCode),
    ];
  return Object.freeze(
    [...new Set(codes)].map((code) =>
      Object.freeze({
        code,
        source: (inputs.includes(code) ? "input" : transitions.includes(code) ? "transition" : "criterion") as
          | "input"
          | "transition"
          | "criterion",
        explain: `${declaration.id} may reject with ${code}.`,
        nextCapabilityRef: null,
      }),
    ),
  );
}

const artifact = (
  slot: string,
  role: string,
  pathTemplate: string,
  owner: "machine" | "doc-sync",
  policyId: string,
  editCapabilityRef: string | null,
  scaffoldRequired: boolean,
) => Object.freeze({ slot, role, pathTemplate, owner, policyId, editCapabilityRef, scaffoldRequired });
const document = (
  slot: string,
  pathTemplate: string,
  authority: "typed-machine-writer" | "doc-sync",
  directEdit: boolean,
  readinessRequired: boolean,
  scaffoldRequired: boolean,
) => Object.freeze({ slot, pathTemplate, authority, directEdit, readinessRequired, scaffoldRequired });

export function descriptorFacets(id: string) {
  const create = id === "create";
  return {
    stateTransition: stateTransition(id),
    result: create ? createResult : lifecycleResult,
    publication: create
      ? Object.freeze({
          preview: equals("result.dryRun", true),
          canonicalVisible: all(equals("result.dryRun", false), equals("result.proof.canonicalVisible", true)),
          pendingCanonical: all(equals("result.dryRun", false), equals("result.proof.canonicalVisible", false)),
          receiptLookupCapabilityRef: "receipt.show" as const,
        })
      : null,
    ownedArtifacts: create
      ? Object.freeze([
          artifact(
            "task.plan",
            "plan",
            "{packagePath}/task_plan.md",
            "doc-sync",
            "markdown-body-replaceable/v1",
            "doc.edit",
            true,
          ),
          artifact(
            "task.contract",
            "contract",
            "{packagePath}/task-contract.json",
            "machine",
            "typed-machine-writer/v1",
            null,
            false,
          ),
          artifact(
            "task.artifacts.keep",
            "artifacts.keep",
            "{packagePath}/artifacts/.gitkeep",
            "machine",
            "typed-machine-writer/v1",
            null,
            true,
          ),
        ])
      : Object.freeze([]),
    managedDocuments: create
      ? Object.freeze([
          document("task.index", "INDEX.md", "typed-machine-writer", false, false, false),
          document("task.closeout", "closeout.md", "doc-sync", false, false, true),
        ])
      : id === "start"
        ? Object.freeze([document("task.plan", "task_plan.md", "doc-sync", true, true, false)])
        : Object.freeze([]),
    followUps: create
      ? Object.freeze([
          Object.freeze({
            capabilityRef: "task.start",
            role: "primary" as const,
            when: all(equals("result.dryRun", false), equals("result.proof.canonicalVisible", true)),
            args: Object.freeze({
              packagePath: Object.freeze({ resultPath: "result.packagePath" }),
              ledgerPackagePath: "{ledgerPackagePath}",
              taskId: Object.freeze({ resultPath: "result.taskId" }),
            }),
          }),
          Object.freeze({
            capabilityRef: "task.artifacts",
            role: "artifact" as const,
            when: null,
            args: Object.freeze({
              packagePath: Object.freeze({ resultPath: "result.packagePath" }),
            }),
          }),
        ])
      : Object.freeze([]),
  };
}

export function createTaskActionCatalog(baseAction: (id: string) => EntityActionContract) {
  return Object.freeze({
    ref: "kernel/task-action/v1",
    actions: Object.freeze(
      declarations.map((declaration): EntityActionContract => {
        // A declared validator that is not one of the Action's own criteria cannot be attributed:
        // the settlement layer rejects the mismatch as an invalid store, and the runtime would have
        // to invent a criterion. Fail at declaration time, where the name is still in view.
        if (
          declaration.validatorCriterionRef !== null &&
          !declaration.criteria.some(({ ref }) => ref === declaration.validatorCriterionRef)
        )
          throw new Error(
            `Task Action ${declaration.id} declares invocation validator ` +
              `${declaration.validatorCriterionRef}, which is not one of its criteria.`,
          );
        return withDerivedActionReturns(
          Object.freeze({
            ...baseAction(declaration.id),
            ...descriptorFacets(declaration.id),
            input: input(
              [
                ...declaration.input.fields,
                ...(["submit", "complete"].includes(declaration.id)
                  ? [field("verb", "string", false, [declaration.ingress.slice("task-".length)])]
                  : []),
                ...(declaration.commandType ? [field("commandType", "string", false, [declaration.commandType])] : []),
              ],
              declaration.input.exactlyOneOf,
            ),
            criteria: Object.freeze([
              ...(declaration.transitionId
                ? [
                    criterion(
                      "task-lifecycle-contract-support/revisionIssues",
                      "invalid_transition",
                      "The command expectedVersion equals the canonical Task projection revision at commit time.",
                    ),
                  ]
                : []),
              ...declaration.criteria,
            ]),
            failureCodes: failureCodes(declaration),
            concurrency: declaration.concurrency,
            effects: Object.freeze(
              declaration.transitionId
                ? [
                    { ref: "task-lifecycle-publication/compileTaskLifecycleWrite", projection: "TaskProjection" },
                    { ref: `task-lifecycle-transitions/${declaration.transitionId}`, projection: "TaskProjection" },
                  ]
                : [{ ref: `repo-cell-task-mutation/${declaration.id}`, projection: "TaskProjection" }],
            ),
            explain: declaration.explain,
            execution: Object.freeze({
              ingress: declaration.ingress,
              compile: null,
              read: false,
              implementation: declaration.implementation,
              topology: declaration.topology,
              remoteEdgeAdmission: declaration.remoteEdgeAdmission,
              targetIdField: declaration.targetIdField,
              ...(declaration.transitionId && declaration.commandType && declaration.coordination
                ? {
                    lifecycle: Object.freeze({
                      transitionId: declaration.transitionId,
                      commandType: declaration.commandType,
                      targetIdField: "executionId",
                      coordination: declaration.coordination,
                      eventType: declaration.eventType!,
                      proof: declaration.proof,
                      validatorCriterionRef: declaration.validatorCriterionRef,
                    }),
                  }
                : {}),
            }),
          }),
        );
      }),
    ),
  });
}
