import { SUBMISSION_V1_SCHEMA } from "./execution.ts";
import { REVIEW_CONSENT_V1_SCHEMA, REVIEW_V1_SCHEMA } from "./review.ts";
import { WRITE_RECEIPT_SCHEMA } from "./receipt-domain-registry.ts";
import { settingsLocales } from "./settings.ts";
import { taskClasses } from "./task.ts";
import { priorityTiers, taskWorkKinds } from "./task-metadata.ts";
import {
  type EntityActionContract,
  type EntityActionInputContract,
  type EntityActionInputField,
} from "./entity-kind-registry.ts";
import { withDerivedActionReturns } from "./entity-action-descriptor.ts";

type FieldType = NonNullable<EntityActionInputField["type"]>;
type FieldValue = NonNullable<EntityActionInputField["value"]>;
type Cli = NonNullable<EntityActionInputField["cli"]>;
type CliExtra = Omit<Cli, "name" | "kind" | "error"> & Pick<EntityActionInputField, "enum" | "regex">;

function value(type: FieldType, enumRef?: readonly string[], regex?: string): FieldValue {
  if (type === "number" || type === "boolean") return { kind: type };
  if (type === "json-object") return { kind: "object", fields: [] };
  if (type.endsWith("-array"))
    return type === "json-object-array"
      ? { kind: "array", items: { kind: "object", fields: [] } }
      : { kind: "array", items: { kind: "string" } };
  return { kind: "string", ...(enumRef ? { enumRef } : {}), ...(regex ? { regex } : {}) };
}

function field(
  name: string,
  type: FieldType = "string",
  required = false,
  enumRef?: readonly string[],
  regex?: string,
): EntityActionInputField {
  return Object.freeze({
    field: name,
    type,
    required,
    value: value(type, enumRef, regex),
    ...(enumRef ? { enum: enumRef } : {}),
    ...(regex ? { regex } : {}),
  });
}

function cli(
  name: string,
  type: FieldType,
  required: boolean,
  flag: string,
  kind: Cli["kind"] = "single",
  extra: CliExtra = {},
  errorCode = required ? "missing_field" : "invalid_field",
): EntityActionInputField {
  const { enum: enumRef, regex, ...binding } = extra;
  return Object.freeze({
    ...field(name, type, required, enumRef, regex),
    cli: Object.freeze({ ...binding, name: flag, kind, error: Object.freeze({ code: errorCode }) }),
  });
}

function objectField(
  name: string,
  fields: readonly EntityActionInputField[],
  required = false,
): EntityActionInputField {
  return Object.freeze({
    field: name,
    type: "json-object",
    required,
    fields,
    value: Object.freeze({ kind: "object", fields }),
  });
}

function input(
  fields: readonly EntityActionInputField[],
  exactlyOneOf: readonly (readonly string[])[] = [],
): EntityActionInputContract {
  return Object.freeze({
    schema: "entity-action-input/v2",
    fields: Object.freeze(fields),
    exactlyOneOf: Object.freeze(exactlyOneOf.map((group) => Object.freeze(group))),
  });
}

const stringArrayValue = Object.freeze({ kind: "array" as const, items: Object.freeze({ kind: "string" as const }) });
const submissionFields = Object.freeze(
  SUBMISSION_V1_SCHEMA.required.map((name) =>
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
const consentFields = Object.freeze(
  REVIEW_CONSENT_V1_SCHEMA.required
    .filter((name) => name === "reviewDigest" || name === "contentDigest")
    .map((name) => field(name, "string", true)),
);
const registerModuleFields = Object.freeze(
  ["key", "title", "prefix", "scope"].map((name) => field(name, "string", true)),
);
const createPacketFields = Object.freeze([
  field("title", "string", true),
  field("taskId"),
  field("idempotencyKey"),
  field("parentTaskId"),
  field("workKind", "string", false, taskWorkKinds),
  field("riskTier", "string", false, priorityTiers),
  field("urgency", "string", false, priorityTiers),
  field("verticalId"),
  field("presetId"),
  field("profileId"),
  field("moduleKey"),
  objectField("registerModule", registerModuleFields),
  field("slug", "string", false, undefined, "^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$"),
  field("surfaces", "string-array"),
  field("taskClass", "string", false, taskClasses),
  field("locale", "string", false, settingsLocales),
  field("fromLegacyId"),
  field("createMode", "string", false, ["migration", "import", "admin"]),
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
const taskId = field("taskId", "string", true);
const expectedVersion = field("expectedVersion", "number");
const optionalPacketFields = (fields: readonly EntityActionInputField[]) =>
  fields.map((item) => Object.freeze({ ...item, required: false }));

const createInput = input([
  cli("title", "string", false, "--title", "single", {}, "missing_field"),
  cli("taskId", "string", false, "--id"),
  cli("idempotencyKey", "string", false, "--idempotency-key"),
  cli("parentTaskId", "string", false, "--parent"),
  cli("workKind", "string", false, "--kind", "single", { enum: taskWorkKinds }),
  cli("riskTier", "string", false, "--risk-tier", "single", { enum: priorityTiers }),
  cli("urgency", "string", false, "--urgency", "single", { enum: priorityTiers }),
  ...packetSources("TaskCreateInput/v1", createPacketFields),
  cli("verticalId", "string", false, "--vertical"),
  cli("presetId", "string", false, "--preset"),
  cli("profileId", "string", false, "--profile"),
  cli("moduleKey", "string", false, "--module"),
  cli("registerModuleKey", "string", false, "--register-module"),
  cli("moduleTitle", "string", false, "--module-title"),
  cli("modulePrefix", "string", false, "--module-prefix"),
  cli("moduleScope", "string", false, "--module-scope"),
  cli("slug", "string", false, "--slug", "single", {
    regex: "^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$",
  }),
  cli("surfaces", "string-array", false, "--surface", "repeated"),
  cli("taskClass", "string", false, "--task-class", "single", { enum: taskClasses }),
  cli("dryRun", "boolean", false, "--dry-run", "boolean"),
  cli("locale", "string", false, "--locale", "single", { enum: settingsLocales }),
  cli("fromLegacyId", "string", false, "--from-legacy"),
  cli("migration", "boolean", false, "--migration", "boolean"),
  cli("import", "boolean", false, "--import", "boolean"),
  cli("admin", "boolean", false, "--admin", "boolean"),
  objectField("registerModule", registerModuleFields),
  field("createMode", "string", false, ["migration", "import", "admin"]),
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

interface Declaration {
  readonly id: string;
  readonly ingress: string;
  readonly commandType: string | null;
  readonly transitionId: string | null;
  readonly implementation: "task-lifecycle" | "task-completion" | "catalog-runtime";
  readonly topology: "center-forward-write" | "ledger-write" | "local-arbiter";
  readonly coordination: "reserve" | "execute" | null;
  readonly eventType: string | null;
  readonly proof: readonly string[];
  readonly targetIdField: string;
  readonly input: EntityActionInputContract;
  readonly policyAction: string;
  readonly criteria: EntityActionContract["criteria"];
  readonly concurrency: EntityActionContract["concurrency"];
  readonly explain: string;
}

const lifecycleSpecs = Object.freeze({
  create: [
    "task-create",
    "CreateReplayTask",
    "create_replay_task",
    "task-lifecycle",
    "center-forward-write",
    "execute",
    "task_created",
    ["taskIdUnique", "actorBinding", "validGraph"],
  ],
  start: [
    "task-start",
    "StartExecution",
    "start_execution",
    "task-lifecycle",
    "center-forward-write",
    "reserve",
    "execution_started",
    ["actorBinding", "reservation"],
  ],
  transition: [
    "task-transition",
    "TransitionTask",
    "transition_task",
    "task-lifecycle",
    "ledger-write",
    "execute",
    "task_transitioned",
    ["auditedReasonWhenRequired"],
  ],
  submit: [
    "task-submit",
    "SubmitExecution",
    "submit_execution",
    "task-lifecycle",
    "ledger-write",
    "execute",
    "execution_submitted",
    ["actorBinding", "leaseVersion-or-submitted-cut", "submission"],
  ],
  review: [
    "task-review-execution",
    "RecordReview",
    "record_execution_review",
    "task-lifecycle",
    "local-arbiter",
    "execute",
    "review_recorded",
    ["independentActor", "execution-review@v1", "contentCut"],
  ],
  consent: [
    "task-review-consent",
    "RecordReviewConsent",
    "record_review_consent",
    "task-lifecycle",
    "ledger-write",
    "execute",
    "review_consent_recorded",
    ["ownerActor", "execution-consent@v1", "reviewDigest", "contentDigest", "submissionDigest"],
  ],
  reconcile: [
    "task-code-doc-reconcile",
    "ReconcileCodeDoc",
    "reconcile_code_doc",
    "task-lifecycle",
    "ledger-write",
    "execute",
    "code_doc_reconciled",
    ["actorBinding", "code-doc-reconcile@v1", "commitPaths"],
  ],
  repoint: [
    "task-code-doc-repoint",
    "RepointCodeDoc",
    "repoint_code_doc",
    "task-lifecycle",
    "ledger-write",
    "execute",
    "code_doc_repointed",
    ["actorBinding", "code-doc-repoint@v1", "commitPaths"],
  ],
  complete: [
    "task-complete",
    "CompleteTask",
    "complete_task",
    "task-completion",
    "ledger-write",
    "execute",
    "task_completed",
    ["ownerOrCommander", "reviewConsent", "typedGateReceipts", "noActiveLease"],
  ],
} as const);
type LifecycleId = keyof typeof lifecycleSpecs;
const lifecycle = (
  id: LifecycleId,
  value: Pick<Declaration, "input" | "criteria" | "concurrency" | "explain">,
): Declaration => {
  const [ingress, commandType, transitionId, implementation, topology, coordination, eventType, proof] =
    lifecycleSpecs[id];
  return Object.freeze({
    ...value,
    id,
    ingress,
    commandType,
    transitionId,
    implementation,
    topology,
    coordination,
    eventType,
    proof,
    targetIdField: "taskId",
    policyAction: ingress,
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
    coordination: null,
    eventType: null,
    proof: Object.freeze([]),
    targetIdField,
    input: actionInput,
    policyAction: `task-${id}`,
    criteria: Object.freeze([criterion(`repo-cell-task-mutation/${id}`, failureCode, criterionExplain)]),
    concurrency: mutationConcurrency,
    explain,
  });

const declarations: readonly Declaration[] = Object.freeze([
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
      taskId,
      expectedVersion,
      cli("executionId", "string", false, "--execution-id"),
      cli("ttlMs", "number", false, "--ttl-ms", "single", {
        regex: "^[1-9][0-9]*$",
        projection: "number",
      }),
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
    explain: "Acquire or idempotently reuse the authenticated actor's execution lease.",
  }),
  lifecycle("transition", {
    input: input([
      taskId,
      expectedVersion,
      field("status", "string", true, ["planned", "active", "blocked", "in_review", "done", "cancelled"]),
      cli("reason", "string", false, "--reason"),
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
    input: input(
      [
        taskId,
        expectedVersion,
        cli("executionId", "string", false, "--execution-id"),
        cli("amend", "boolean", false, "--amend", "boolean"),
        ...optionalPacketFields(submissionFields),
        ...packetSources(SUBMISSION_V1_SCHEMA.id, submissionFields),
      ],
      [["fromFile", "jsonInput"]],
    ),
    criteria: Object.freeze([
      criterion(
        "task-lifecycle-command-transitions/submit.validate",
        "invalid_transition",
        "The active current execution is submitted with a valid submission packet.",
      ),
      criterion(
        "repo-cell-proof/proofFor.SubmitExecution",
        "lease_required",
        "The authenticated actor owns the active lease or the submitted execution being amended.",
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
    explain: "Publish the initial submission or amend the current submitted execution without replacing its history.",
  }),
  lifecycle("review", {
    input: input(
      [
        taskId,
        expectedVersion,
        cli("executionId", "string", false, "--execution-id"),
        cli("reviewId", "string", true, "--review-id"),
        ...optionalPacketFields(reviewFields),
        ...packetSources(REVIEW_V1_SCHEMA.id, reviewFields),
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
    explain: "Record an independent, content-pinned review for the submitted execution.",
  }),
  lifecycle("consent", {
    input: input(
      [
        taskId,
        expectedVersion,
        cli("executionId", "string", false, "--execution-id"),
        cli("reviewId", "string", false, "--review-id"),
        cli("consentId", "string", true, "--consent-id", "single", {}, "invalid_field"),
        ...optionalPacketFields(consentFields),
        ...packetSources(REVIEW_CONSENT_V1_SCHEMA.id, consentFields),
      ],
      [["fromFile", "jsonInput"]],
    ),
    criteria: Object.freeze([
      criterion(
        "task-lifecycle-review-transitions/consent.validate",
        "invalid_proof",
        "Owner consent selects the current approved review and pins review, content, and submission digests.",
      ),
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "must-be-released" },
      { authority: "operation-id", semanticKey: "consentId" },
    ),
    explain: "Select a recorded Review with content-pinned owner consent.",
  }),
  lifecycle("reconcile", {
    input: input([
      taskId,
      expectedVersion,
      field("executionId"),
      field("witnessId"),
      field("commitSha"),
      field("iteration", "number"),
      cli("paths", "string-array", true, "--path", "repeated"),
    ]),
    criteria: Object.freeze([
      criterion(
        "task-lifecycle-review-transitions/reconcile.validate",
        "invalid_proof",
        "The witness binds canonical document paths to the submitted commit.",
      ),
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "must-be-released" },
      { authority: "operation-id", semanticKey: "witnessId" },
    ),
    explain: "Publish a typed code-doc witness.",
  }),
  lifecycle("repoint", {
    input: input([
      taskId,
      expectedVersion,
      cli("record", "string", true, "--record"),
      field("repointId"),
      field("commitSha"),
      cli("paths", "string-array", false, "--path", "repeated"),
      cli("reason", "string", true, "--reason"),
    ]),
    criteria: Object.freeze([
      criterion(
        "task-lifecycle-review-transitions/repoint.validate",
        "invalid_proof",
        "The correction names an existing witness and a valid replacement commit/path set.",
      ),
    ]),
    concurrency: taskConcurrency(
      { authority: "task-lease/v1", mode: "must-be-released" },
      { authority: "operation-id", semanticKey: "repointId" },
    ),
    explain: "Append an audited code-doc witness correction for a completed task.",
  }),
  lifecycle("complete", {
    input: input([
      taskId,
      expectedVersion,
      cli("executionId", "string", false, "--execution-id"),
      cli("ci", "string", false, "--ci", "single", { enum: ["passed"] }),
      cli("paths", "string-array", false, "--path", "repeated"),
      cli("factHolds", "fact-hold-array", false, "--fact-holds", "repeated", {
        format: "<fact-id>:<rationale>",
        regex: "^(?:fact/)?F-[0-9A-HJKMNP-TV-Z]{8}:.+$",
        projection: "fact-hold-array",
      }),
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
    explain: "Complete the reviewed execution after canonical closeout readiness and gate checks.",
  }),
  mutation(
    "release",
    input([
      taskId,
      cli("reason", "string", false, "--reason"),
      field("terminalExecutionId"),
      field("terminalRuntimeSessionId"),
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
        field("taskId"),
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
      field("taskId"),
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
    if (name !== "proof")
      return field(
        name,
        name === "revision" ? "number" : name === "outcome" || name === "opId" ? "string" : "json-object",
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
    field("taskId", "string", true),
    field("status", "string", true, ["planned"]),
    field("packagePath", "string", true),
    field("generatedPaths", "string-array", true),
    field("presetDigest", "string", true),
    field("scaffoldDigest", "string", true),
    field("presetId", "string", true),
    field("profileId", "string", true),
    field("outputShape", "string", true),
    field("completionGates", "string-array", true),
    field("dryRun", "boolean", true),
  ]),
  obligations: Object.freeze([
    Object.freeze({ kind: "repository-diff" as const, when: equals("result.outputShape", "repository-diff") }),
  ]),
});

function equals(path: string, value: string | number | boolean) {
  return Object.freeze({ fieldEquals: Object.freeze({ path, value }) });
}
const all = (...predicates: ReturnType<typeof equals>[]) => Object.freeze({ all: Object.freeze(predicates) });
const not = (predicate: ReturnType<typeof equals>) => Object.freeze({ not: predicate });
const coordinate = (
  status: string | null,
  currentNode: string | null,
  extra: Readonly<Record<string, string | null>> = {},
) => Object.freeze({ status, currentNode, ...extra });
type StateCoordinate = NonNullable<EntityActionContract["stateTransition"]>["from"][number];
type StatePredicate = NonNullable<EntityActionContract["stateTransition"]>["to"][number]["when"];
const branch = (state: StateCoordinate, when: StatePredicate = null) => Object.freeze({ when, coordinate: state });
const transition = (
  from: readonly StateCoordinate[],
  to: readonly ReturnType<typeof branch>[],
): NonNullable<EntityActionContract["stateTransition"]> =>
  Object.freeze({ from: Object.freeze(from), to: Object.freeze(to) });

function stateTransition(id: string): EntityActionContract["stateTransition"] {
  if (id === "create")
    return transition(
      [Object.freeze({ existence: "missing" as const, status: null, currentNode: null })],
      [branch(Object.freeze({ existence: "present" as const, status: "planned", currentNode: "implementation" }))],
    );
  if (id === "start")
    return transition(
      [coordinate("planned", "implementation")],
      [branch(coordinate("active", "implementation", { executionState: "active" }))],
    );
  if (id === "transition") {
    const statuses = ["planned", "active", "blocked", "in_review", "done", "cancelled"];
    return transition(
      statuses.filter((status) => status !== "done").map((status) => coordinate(status, null)),
      statuses.map((status) => branch(coordinate(status, null), equals("input.status", status))),
    );
  }
  if (id === "submit")
    return transition(
      [
        coordinate("active", "implementation", { executionState: "active" }),
        coordinate("in_review", "review", { executionState: "submitted" }),
      ],
      [
        branch(coordinate("in_review", "review", { executionState: "submitted" }), equals("input.amend", true)),
        branch(coordinate("in_review", "review", { executionState: "submitted" }), not(equals("input.amend", true))),
      ],
    );
  if (id === "review")
    return transition(
      [coordinate("in_review", "review", { executionState: "submitted" })],
      [
        branch(
          coordinate("active", "implementation", { executionState: "changes_requested" }),
          equals("input.verdict", "changes_requested"),
        ),
        branch(
          coordinate("in_review", "review", { executionState: "submitted" }),
          not(equals("input.verdict", "changes_requested")),
        ),
      ],
    );
  if (id === "consent" || id === "reconcile") return unchanged("in_review", "review", "submitted");
  if (id === "repoint") return unchanged("done", "review", "accepted");
  if (id === "complete")
    return transition(
      [
        Object.freeze({
          status: "in_review",
          currentNode: "review",
          executionState: "submitted",
          readiness: "ready" as const,
        }),
      ],
      [branch(coordinate("done", "review", { executionState: "accepted" }))],
    );
  return null;
}

function unchanged(status: string, currentNode: string, executionState: string) {
  const state = coordinate(status, currentNode, { executionState });
  return transition([state], [branch(state)]);
}

const createFailureCodes = Object.freeze([
  "missing_field",
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

function descriptorFacets(id: string) {
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
        : id === "complete"
          ? Object.freeze([document("task.closeout", "closeout.md", "doc-sync", true, true, false)])
          : Object.freeze([]),
    followUps: create
      ? Object.freeze([
          Object.freeze({
            capabilityRef: "task.start",
            role: "primary" as const,
            when: all(equals("result.dryRun", false), equals("result.proof.canonicalVisible", true)),
            args: Object.freeze({
              packagePath: Object.freeze({ resultPath: "result.packagePath" }),
              taskId: Object.freeze({ resultPath: "result.taskId" }),
            }),
          }),
          Object.freeze({
            capabilityRef: "task.pin",
            role: "agenda" as const,
            when: null,
            args: Object.freeze({ taskId: Object.freeze({ resultPath: "result.taskId" }) }),
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
            policy: Object.freeze({ ref: "default@5", action: declaration.policyAction }),
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
