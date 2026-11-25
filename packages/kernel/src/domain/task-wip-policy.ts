import type { ProjectedExecution } from "./execution.ts";
import type { DomainStatus } from "./lifecycle-status.ts";
import type { TaskClass } from "./task.ts";
import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

/**
 * Default execution work-in-progress limit. This is a default, not the truth:
 * the effective limit is resolved per workspace from HARNESS_TASK_WIP_LIMIT or
 * settings.tasks.wipLimit before every admission check.
 */
export const DEFAULT_TASK_WIP_LIMIT = 30;
export const DEFAULT_TASK_ROOT_THRESHOLD = 3;

export const taskWipOccupyingStatuses = [
  "active",
  "submitted",
  "blocked",
  "in_review",
] as const satisfies ReadonlyArray<DomainStatus>;
export type TaskWipOccupyingStatus = (typeof taskWipOccupyingStatuses)[number];

export interface TaskWipSnapshotEntryV1 {
  readonly taskId: string;
  readonly title: string;
  readonly status: DomainStatus;
  readonly taskClass: TaskClass;
  readonly packageDisposition: "active" | "archived" | "tombstoned";
  /**
   * Canonical delivery evidence already recorded on the task (a submitted
   * native execution, or a migrated archived execution carrying outputs or an
   * archived submission). Existing delivery evidence makes a planned task a
   * closeout backfill: activating it writes existing work off instead of
   * adding parallel work, so it never enters the WIP count.
   */
  readonly hasCloseoutEvidence: boolean;
  /** Whether this task has an active/submitted execution or an active lease. */
  readonly hasOwnExecution: boolean;
  /** Number of direct children in the existing task projection. */
  readonly directChildCount: number;
}

export type TaskRootDerivation =
  | {
      readonly isRoot: true;
      readonly reason: "declared";
      readonly directChildCount: number;
      readonly threshold: number;
    }
  | { readonly isRoot: true; readonly reason: "derived"; readonly directChildCount: number; readonly threshold: number }
  | { readonly isRoot: false; readonly reason: "none"; readonly directChildCount: number; readonly threshold: number };

export function deriveTaskRoot(
  entry: TaskWipSnapshotEntryV1,
  threshold = DEFAULT_TASK_ROOT_THRESHOLD,
): TaskRootDerivation {
  const directChildCount =
    Number.isSafeInteger(entry.directChildCount) && entry.directChildCount >= 0 ? entry.directChildCount : 0;
  if (entry.taskClass === "work" || entry.taskClass === "long_running") {
    return { isRoot: true, reason: "declared", directChildCount, threshold };
  }
  if (directChildCount >= threshold && !entry.hasOwnExecution)
    return { isRoot: true, reason: "derived", directChildCount, threshold };
  return { isRoot: false, reason: "none", directChildCount, threshold };
}

/**
 * One serialized root row of the task WIP snapshot. The daemon producer emits exactly these
 * fields and the daemon protocol validator requires exactly these fields; both are derived
 * from this single declaration so the wire shape cannot drift between the two ends.
 */
export interface TaskWipRootRow {
  readonly taskId: string;
  readonly reason: "declared" | "derived";
  readonly directChildCount: number;
  readonly threshold: number;
}

export const taskWipRootRowFields = Object.freeze([
  "taskId",
  "reason",
  "directChildCount",
  "threshold",
] as const satisfies readonly (keyof TaskWipRootRow)[]);

/** Serializes a root assessment for the wire, or null when the task is not a root. */
export function serializeTaskWipRootRow(taskId: string, assessment: TaskRootDerivation): TaskWipRootRow | null {
  if (!assessment.isRoot) return null;
  return {
    taskId,
    reason: assessment.reason,
    directChildCount: assessment.directChildCount,
    threshold: assessment.threshold,
  };
}

export function hasCloseoutEvidence(executions: readonly ProjectedExecution[]): boolean {
  return executions.some((execution) =>
    execution.schema === "execution/v1"
      ? execution.submission !== null
      : execution.archivedSubmission !== null || execution.outputs.length > 0,
  );
}

export function isExecutionWipTask(
  entry: TaskWipSnapshotEntryV1,
  rootThreshold = DEFAULT_TASK_ROOT_THRESHOLD,
): boolean {
  return (
    entry.packageDisposition === "active" &&
    entry.taskClass === "standard" &&
    !deriveTaskRoot(entry, rootThreshold).isRoot &&
    (taskWipOccupyingStatuses as readonly string[]).includes(entry.status)
  );
}

export interface TaskWipAdmissionInput {
  readonly limit: number;
  /** Names the setting that produced the limit, e.g. settings.tasks.wipLimit or HARNESS_TASK_WIP_LIMIT. */
  readonly limitLabel: string;
  readonly tasks: readonly TaskWipSnapshotEntryV1[];
  readonly activatingTaskId: string;
  readonly nextStatus: DomainStatus;
  readonly rootThreshold?: number;
}

export type TaskWipAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "TASK_WIP_LIMIT_REACHED"; readonly message: string };

export function admitTaskExecutionWip(input: TaskWipAdmissionInput): TaskWipAdmission {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    return {
      ok: false,
      code: "TASK_WIP_LIMIT_REACHED",
      message: `TASK_WIP_POLICY_INVALID: ${input.limitLabel} must be a positive integer.`,
    };
  }
  const rootThreshold = input.rootThreshold ?? DEFAULT_TASK_ROOT_THRESHOLD;
  if (!Number.isSafeInteger(rootThreshold) || rootThreshold < 1) {
    return {
      ok: false,
      code: "TASK_WIP_LIMIT_REACHED",
      message: "TASK_WIP_POLICY_INVALID: root threshold must be a positive integer.",
    };
  }
  const activating = input.tasks.find((task) => task.taskId === input.activatingTaskId);
  // Unknown task: the task surface owns the not-found error. Already occupying:
  // re-entering the same worktable slot (rejoin, resume) adds nothing.
  if (!activating || !enteringExecutionWip(activating, input.nextStatus, rootThreshold)) return { ok: true };
  // Closeout backfill: activating recorded delivery evidence writes existing work off.
  // This is part of the counting rule, not an exemption layer on top of it.
  if (activating.hasCloseoutEvidence) return { ok: true };
  const occupying = input.tasks
    .filter((task) => isExecutionWipTask(task, rootThreshold))
    .sort(compareTaskWipSuggestions);
  if (occupying.length < input.limit) return { ok: true };
  const suggestions = occupying
    .filter(
      (task) =>
        task.directChildCount === 0 &&
        !task.hasOwnExecution &&
        (task.status === "in_review" || task.status === "blocked"),
    )
    .slice(0, 3)
    .map((task) => `${task.taskId} ${JSON.stringify(task.title)} (${task.status})`)
    .join(", ");
  return {
    ok: false,
    code: "TASK_WIP_LIMIT_REACHED",
    message:
      `TASK_WIP_LIMIT_REACHED: Execution worktable is full (${occupying.length}/${input.limit}; ${input.limitLabel}=${input.limit}). ` +
      `${formatWipComposition(input.tasks, rootThreshold)} ` +
      `Before starting ${input.activatingTaskId}, close one existing task. Suggested: ${suggestions}. ` +
      `Next: complete, cancel (\`ha task transition <task-id> cancelled --force --reason <reason>\`), or archive one of those tasks, then retry \`ha task start ${input.activatingTaskId}\`. ` +
      "Derived root exemption applies only to pure containers. " +
      "Planned tasks stay in the idea backlog and are never counted or removed.",
  };
}

/** True when the move takes the task from a non-occupying state into an occupying one. */
export function enteringExecutionWip(
  current: TaskWipSnapshotEntryV1,
  nextStatus: DomainStatus,
  rootThreshold = DEFAULT_TASK_ROOT_THRESHOLD,
): boolean {
  // Entering active takes the worktable: task-start creates the execution and reserve
  // takes the lease, so a container stops being a pure container at that moment.
  const next = { ...current, status: nextStatus, hasOwnExecution: current.hasOwnExecution || nextStatus === "active" };
  return !isExecutionWipTask(current, rootThreshold) && isExecutionWipTask(next, rootThreshold);
}

function formatWipComposition(tasks: readonly TaskWipSnapshotEntryV1[], rootThreshold: number): string {
  const active = tasks.filter(
    (task) =>
      task.packageDisposition === "active" && (taskWipOccupyingStatuses as readonly string[]).includes(task.status),
  );
  const declaredRoots = active.filter((task) => deriveTaskRoot(task, rootThreshold).reason === "declared").length;
  const derivedRoots = active.filter((task) => deriveTaskRoot(task, rootThreshold).reason === "derived").length;
  const leaves = active.filter((task) => isExecutionWipTask(task, rootThreshold)).length;
  return `Occupancy composition: ${leaves} leaf tasks occupying; ${declaredRoots} declared roots and ${derivedRoots} derived roots excluded.`;
}

export function parseTaskWipLimit(value: unknown): number | undefined {
  if (typeof value === "string" && !/^[0-9]+$/u.test(value)) return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function compareTaskWipSuggestions(left: TaskWipSnapshotEntryV1, right: TaskWipSnapshotEntryV1): number {
  const rank = { in_review: 0, blocked: 1 } as const;
  const leftRank = left.status in rank ? rank[left.status as keyof typeof rank] : 3;
  const rightRank = right.status in rank ? rank[right.status as keyof typeof rank] : 3;
  return leftRank - rightRank || left.taskId.localeCompare(right.taskId);
}

// dec_7E44897ECDCAEF2B92EC66A260/CH1: the worktable defaults are declared beside the constants they bind.
export const taskExecutionWipPolicy = {
  id: "task-execution-wip",
  ownerRef: "task/start",
  unit: "occupying tasks",
  bounds:
    "The resolved limit and root threshold must be positive safe integers; the default limit is 30 open execution tasks and a task with at least 3 direct children and no own execution is a derived root that does not occupy the worktable. Entering execution is refused once the occupying count reaches the limit, unless closeout evidence writes the work off.",
  defaultValue: { openExecutionTasks: DEFAULT_TASK_WIP_LIMIT, derivedRootChildren: DEFAULT_TASK_ROOT_THRESHOLD },
  version: 1,
  scope: "Task execution worktable admission",
  reason: "Workspace settings and the environment override the declared defaults; the counting rule is unchanged.",
  fixtures: ["packages/kernel/test/domain/task-wip-policy.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/task-wip-policy.ts#DEFAULT_TASK_WIP_LIMIT:d7fd6df8fc166c8ee7990ffdf37f35d0",
    "policy:packages/kernel:packages/kernel/src/domain/task-wip-policy.ts#DEFAULT_TASK_ROOT_THRESHOLD:6a2085b082b9ac2f198e32b0b1da73f0",
    "policy:packages/kernel:packages/kernel/src/domain/task-wip-policy.ts#admitTaskExecutionWip:750d34e0e433a86d9139e7942f502c01",
    "policy:packages/kernel:packages/kernel/src/domain/task-wip-policy.ts#admitTaskExecutionWip:453898490fcb824f7f8237a9aad9e2b1",
  ].map((candidateId) => ({ candidateId, route: "admitTaskExecutionWip" })),
} as const satisfies OntologyPolicyDeclaration;

export const nodeTaskMaterializationPolicies = Object.freeze(["none", "in_flight", "include_done"] as const);
export type NodeTaskMaterializationPolicy = (typeof nodeTaskMaterializationPolicies)[number];

export function normalizeNodeTaskMaterializationPolicy(value: unknown): NodeTaskMaterializationPolicy {
  if (!(nodeTaskMaterializationPolicies as readonly unknown[]).includes(value))
    throw new TypeError(`nodeTaskMaterializationPolicy must be one of ${nodeTaskMaterializationPolicies.join(", ")}`);
  return value as NodeTaskMaterializationPolicy;
}

/** A node-local choice; canonical Task state and content remain complete in storage. */
export const nodeTaskMaterializationPolicy = {
  id: "node-task-materialization",
  ownerRef: "task",
  unit: "node working-tree document set",
  bounds: "none, in_flight, or include_done; only follower settlement is filtered and no center document is retired",
  defaultValue: nodeTaskMaterializationPolicies[2],
  version: 1,
  scope: "node-local task follower materialization",
  reason:
    "Headless centers avoid disk work, edge workers retain in-flight work, and operator nodes retain completed active packages.",
  fixtures: [
    "packages/kernel/test/domain/task-wip-policy.test.ts",
    "packages/storage/test/store/terminal-materialization.integration.test.ts",
    "packages/storage/test/postgres/terminal-materialization.integration.test.ts",
    "packages/daemon/test/task-documents-list.integration.test.ts",
    "packages/daemon/test/node-materialization-settings.integration.test.ts",
    "packages/daemon/test/fleet-node-materialization.integration.test.ts",
  ],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/task-wip-policy.ts#taskIncludedByNodeMaterializationPolicy:673356004ac1c02b75205dd3c6783a0c",
    "policy:packages/daemon:packages/daemon/src/daemon-host/repo-cell.ts#initializeRepoCell.readMaterializationDocuments:9a714b70cf67f888ae307125343c97fa",
    "policy:packages/daemon:packages/daemon/src/daemon-host/settings-action-runtime.ts#makeSettingsActionRuntime:8e1d8434a580108b635c966467bd1b7a",
    "policy:packages/application:packages/application/src/commands/write-receipt-settlement.ts#settleWriteReceipt.materialized.reconcileNodePolicy:c5013c8bee363a83b667529a7565ec7e",
    "policy:packages/application:packages/application/src/commands/write-receipt-settlement.ts#settleWriteReceipt:c1050a89beabf37ca312e1e554782a72",
    "policy:packages/daemon:packages/daemon/src/daemon-host/doc-sync-candidate-scanner.ts#scanDocCandidates.scanOne:27054bed81347e56f9081d7397c65e4a",
    "policy:packages/application:packages/application/src/queries/doc-sync-reads.ts#readDocAction.materializationState:71a3d721091e8253a10a63913edca6d1",
    "policy:packages/application:packages/application/src/commands/entity-action-catalog-executor.ts#withNodeMaterializationState:daf168a4166c963e3e6de1d64c76c6fb",
    "policy:packages/storage:packages/storage/src/pg/pg-git-outbox-publisher.ts#attachPgGitFollower.prepareConfirmedFollower:407c341920002a2adc2e1081acbee44c",
    "policy:packages/storage:packages/storage/src/storage-backend.ts#readNodeMaterializationDocuments:9c89aee9a882cdd6835efd2f47f68e6c",
    "policy:packages/storage:packages/storage/src/storage-backend.ts#readNodeMaterializationDocuments:556bd90fc717033e0511b5a53b769ad9",
    "policy:packages/storage:packages/storage/src/store/sqlite-task-event-materialize.ts#closureFiles:89aa5d86146431326c9455e6a628d353",
    "policy:packages/storage:packages/storage/src/store/sqlite-git-outbox-publisher.ts#attachSqliteGitFollower.skipByNodePolicyReceipt:d5aab3bdfacd5f9ec794ed0598fd43ed",
    "policy:packages/daemon:packages/daemon/src/daemon-host/daemon-host-repository-api.ts#createDaemonHostRepositoryApi.run:5bb3c44b8278704b9bdbb0b6090c4259",
    "policy:packages/daemon:packages/daemon/src/daemon-host/fleet-edge-materialization.ts#reconcileFleetNodeMaterialization.result.request.reconcileNodePolicy:c5013c8bee363a83b667529a7565ec7e",
    "policy:packages/daemon:packages/daemon/src/daemon-host/fleet-edge-mirror.ts#materializeFleetMirrorView:c14ca311a5add40e1dcb3097f2178730",
    "policy:packages/daemon:packages/daemon/src/fleet-sync/cloud-domain-routes.ts#createCloudDomainRoutes.nodeTaskMaterializationPolicy:cddf6b639e6e476dc9a3afb2d5b76802",
  ].map((candidateId) => ({ candidateId, route: "nodeTaskMaterializationPolicy" })),
} as const satisfies OntologyPolicyDeclaration;

export function taskIncludedByNodeMaterializationPolicy(
  policy: NodeTaskMaterializationPolicy,
  task: { readonly status: string; readonly packageDisposition?: string | null },
): boolean {
  if (policy === "none" || task.packageDisposition === "archived") return false;
  const inFlight = ["planned", "active", "blocked", "submitted", "in_review"].includes(task.status);
  return inFlight || (policy === "include_done" && task.status === "done");
}

export function nodeMaterializationPolicyForMode(
  mode: string = "local",
  configured?: NodeTaskMaterializationPolicy,
): NodeTaskMaterializationPolicy {
  return (
    configured ??
    (mode === "remote-center" || mode === "remote-proxy"
      ? "none"
      : mode === "remote-edge"
        ? "in_flight"
        : nodeTaskMaterializationPolicy.defaultValue)
  );
}

// Source identities and values for daemon policy declarations registered by EntityKindContract.
export const daemonTaskPolicySources = [
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-action-catalog-runtime.ts#runTaskActionCatalogRuntime:b69d13b514af328daf564ac55d1c6015",
    "packages/daemon/src/daemon-host/task-action-catalog-runtime.ts#runTaskActionCatalogRuntime",
    'if (contract && typeof action.executionId === "string" && action.executionId !== activeLease.executionId)',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-action-catalog-runtime.ts#runTaskActionCatalogRuntime:844a029d42e6171a54a17caccabb180f",
    "packages/daemon/src/daemon-host/task-action-catalog-runtime.ts#runTaskActionCatalogRuntime",
    "if (",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-action-catalog-runtime.ts#runTaskActionCatalogRuntime:8ea6f2158720434d2acc3b6ec2c98d98",
    "packages/daemon/src/daemon-host/task-action-catalog-runtime.ts#runTaskActionCatalogRuntime",
    'if (action.kind === "task-submit" && submitLeaseUnmet && contract)',
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-action-explanation-read.ts#readTaskActionExplanation.personService.authorize.policyRef:e4a2c2e1cc3a90fa0deb08fc7cd49d9d",
    "packages/application/src/queries/task-action-explanation-read.ts#readTaskActionExplanation.personService.authorize.policyRef",
    'policyRef: "authorization-provider@1",',
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-action-explanation-read.ts#readTaskActionExplanation.subjects.snapshot.lease:604b0c933f01414f14bbc867d23eb635",
    "packages/application/src/queries/task-action-explanation-read.ts#readTaskActionExplanation.subjects.snapshot.lease",
    'snapshot = { ...row.snapshot, lease: lease?.phase === "released" ? null : lease },',
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-action-explanation-read.ts#missingExplanationDecision.policyRef:e4a2c2e1cc3a90fa0deb08fc7cd49d9d",
    "packages/application/src/queries/task-action-explanation-read.ts#missingExplanationDecision.policyRef",
    'policyRef: "authorization-provider@1",',
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-claimable-read.ts#readClaimableTasks.page.limit:566e0d0917d2d5e10ead25ab3a9e3260",
    "packages/application/src/queries/task-claimable-read.ts#readClaimableTasks.page.limit",
    "const page = await input.page({ activePackagesOnly: true, limit: 500, ...(cursor ? { cursor } : {}) });",
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-completion-read.ts#factRetirementAssessment.taskRelationReads.limit:566e0d0917d2d5e10ead25ab3a9e3260",
    "packages/application/src/queries/task-completion-read.ts#factRetirementAssessment.taskRelationReads.limit",
    'projection.readRelationQuery({ source: taskRef, state: "active", limit: 500 }),',
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-completion-read.ts#factRetirementAssessment.taskRelationReads.limit:566e0d0917d2d5e10ead25ab3a9e3260:2",
    "packages/application/src/queries/task-completion-read.ts#factRetirementAssessment.taskRelationReads.limit",
    'projection.readRelationQuery({ target: taskRef, state: "active", limit: 500 }),',
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-completion-read.ts#factRetirementAssessment.narrowReads.limit:566e0d0917d2d5e10ead25ab3a9e3260",
    "packages/application/src/queries/task-completion-read.ts#factRetirementAssessment.narrowReads.limit",
    'projection.readRelationQuery({ source, state: "active", limit: 500 }),',
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-completion-read.ts#factRetirementAssessment.livenessReads.limit:566e0d0917d2d5e10ead25ab3a9e3260",
    "packages/application/src/queries/task-completion-read.ts#factRetirementAssessment.livenessReads.limit",
    'projection.readRelationQuery({ target, relationType: "supersedes-fact", state: "active", limit: 500 }),',
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-delivery-stage.ts#taskDeliveryStage:eacd53e4de81103e4d4a95f2a16af6cb",
    "packages/application/src/queries/task-delivery-stage.ts#taskDeliveryStage",
    "if (",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-dispatch-admission.ts#taskDispatchLeaseQualifies:8bc607039aaf7be1fd1fffd79ba7ffd5",
    "packages/daemon/src/daemon-host/task-dispatch-admission.ts#taskDispatchLeaseQualifies",
    'if (lease === null || lease.phase === "released" || lease.phase === "orphaned") return canHandoff;',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-dispatch-recovery.ts#admitTaskDispatch:f2597b61eb8caf0b98371ee69cd21467",
    "packages/daemon/src/daemon-host/task-dispatch-recovery.ts#admitTaskDispatch",
    'lifecycle?.policy.capacityDisposition === "busy"',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-merged-closeout.ts#mergedCloseoutCandidates:239b73d6a9f16dc234611e5bb23b87c6",
    "packages/daemon/src/daemon-host/task-merged-closeout.ts#mergedCloseoutCandidates",
    "if (",
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-query-read.ts#makeTaskQueryReadModel.agenda.cut.limit:0dd585c292e12f6bf0b47a1d330750d6",
    "packages/application/src/queries/task-query-read.ts#makeTaskQueryReadModel.agenda.cut.limit",
    "...(reads.length === 0 ? [projection.readRelationQuery({ limit: 1 })] : reads),",
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-query-read.ts#projectedRuntimeHeaders.page.limit:566e0d0917d2d5e10ead25ab3a9e3260",
    "packages/application/src/queries/task-query-read.ts#projectedRuntimeHeaders.page.limit",
    "limit: 500,",
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-query-read.ts#unsubmittedDeliveryAttentionRows:f7063f5a94745e5c7a036f2b015da0c4",
    "packages/application/src/queries/task-query-read.ts#unsubmittedDeliveryAttentionRows",
    "if (",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-return-dispatch.ts#dispatchContinuation.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
    "packages/daemon/src/daemon-host/task-return-dispatch.ts#dispatchContinuation.attempt",
    "for (let attempt = 0; ; attempt += 1) {",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-return-dispatch.ts#dispatchContinuation.mode:ec84e5d1b7726ce72ce7f0113e3f99f0",
    "packages/daemon/src/daemon-host/task-return-dispatch.ts#dispatchContinuation.mode",
    'mode = attempt > 0 || hasIdentityOverride ? "fresh" : previous?.resume !== undefined ? "resume" : "fresh",',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-review-dispatch.ts#dispatchDecisionReview.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
    "packages/daemon/src/daemon-host/task-review-dispatch.ts#dispatchDecisionReview.attempt",
    "let attempt = 0,",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-review-dispatch.ts#reviewAttemptKey:903de205b0c3881de568df07a3e028df",
    "packages/daemon/src/daemon-host/task-review-dispatch.ts#reviewAttemptKey",
    "return attempt === 0 ? base : `${base}:attempt${String(attempt)}`;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-review-dispatch.ts#reviewDispatchPrompt:3d5f4ab6838400a97d45ac29bf69661f",
    "packages/daemon/src/daemon-host/task-review-dispatch.ts#reviewDispatchPrompt",
    ': execution.submission?.riskTierAssessment?.effectiveTier === "high"',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-review-dispatch.ts#reviewDispatchPrompt:c504f0a00ee4082c41de61c21fe1442c",
    "packages/daemon/src/daemon-host/task-review-dispatch.ts#reviewDispatchPrompt",
    '...(execution.submission?.riskTierAssessment?.effectiveTier === "medium"',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-review-dispatch.ts#reviewDispatchAttempt.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
    "packages/daemon/src/daemon-host/task-review-dispatch.ts#reviewDispatchAttempt.attempt",
    "let attempt = 0,",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-risk-tier.ts#assessTaskRiskTier.timeoutMs:56d92d560ecf5a3d099f43ff3d944a05",
    "packages/daemon/src/daemon-host/task-risk-tier.ts#assessTaskRiskTier.timeoutMs",
    "{ timeoutMs: 30_000 },",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-risk-tier.ts#parseScriptResult:e8a26bd283318bd82de0eceded942e78",
    "packages/daemon/src/daemon-host/task-risk-tier.ts#parseScriptResult",
    "if (",
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-wip-settings.ts#TASK_WIP_LIMIT_ENV:16ffd4614d6fa6ada495e4d22273380d",
    "packages/application/src/queries/task-wip-settings.ts#TASK_WIP_LIMIT_ENV",
    'export const TASK_WIP_LIMIT_ENV = "HARNESS_TASK_WIP_LIMIT";',
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-wip-settings.ts#TASK_WIP_LIMIT_SETTING:ca330956d3d92d07a920b97f0da879bb",
    "packages/application/src/queries/task-wip-settings.ts#TASK_WIP_LIMIT_SETTING",
    'export const TASK_WIP_LIMIT_SETTING = "settings.tasks.wipLimit";',
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-wip-settings.ts#TASK_ROOT_THRESHOLD_ENV:e5fa06bb160922f2ebb87e290f707a20",
    "packages/application/src/queries/task-wip-settings.ts#TASK_ROOT_THRESHOLD_ENV",
    'export const TASK_ROOT_THRESHOLD_ENV = "HARNESS_TASK_ROOT_THRESHOLD";',
  ],
  [
    "policy:packages/application:packages/application/src/queries/task-wip-settings.ts#TASK_ROOT_THRESHOLD_SETTING:a2f17901d8c0aacdaf78ede58d60cc42",
    "packages/application/src/queries/task-wip-settings.ts#TASK_ROOT_THRESHOLD_SETTING",
    'export const TASK_ROOT_THRESHOLD_SETTING = "settings.tasks.rootThreshold";',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-witness-runner.ts#runCompletionSources:b2f92acbcdf6380e9663d32b2b651924",
    "packages/daemon/src/daemon-host/task-witness-runner.ts#runCompletionSources",
    'if (claim.receipt.outcome !== "no_changes")',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-witness-runner.ts#runCompletionSources:dbe1ef073d3d43df94994cc5a79467ef",
    "packages/daemon/src/daemon-host/task-witness-runner.ts#runCompletionSources",
    'if (claim.receipt.outcome !== "applied" || !claim.execution) {',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-worktree-candidates.ts#taskWorktreeCandidateInventory.rows:cc006e6b730d177d3e6345641bec0b4f",
    "packages/daemon/src/daemon-host/task-worktree-candidates.ts#taskWorktreeCandidateInventory.rows",
    'if (row.path.endsWith("/.gitkeep") || !resolveDocRoute(documentPath(row.path)).allowed) return [];',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-worktree-candidates.ts#taskWorktreeCandidateInventory.rows.limit:0dd585c292e12f6bf0b47a1d330750d6",
    "packages/daemon/src/daemon-host/task-worktree-candidates.ts#taskWorktreeCandidateInventory.rows.limit",
    "history.store.queryEvents({ revisionBound: current.workspaceRevision + 1, limit: 1 })[0],",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-worktree.ts#checkoutTaskWorktree.git.timeoutMs:56d92d560ecf5a3d099f43ff3d944a05",
    "packages/daemon/src/daemon-host/task-worktree.ts#checkoutTaskWorktree.git.timeoutMs",
    "{ timeoutMs: 30_000 },",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-worktree.ts#ensurePinnedCommit.hasCommit.timeoutMs:56d92d560ecf5a3d099f43ff3d944a05",
    "packages/daemon/src/daemon-host/task-worktree.ts#ensurePinnedCommit.hasCommit.timeoutMs",
    "{ timeoutMs: 30_000 },",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-worktree.ts#ensurePinnedCommit.timeoutMs:56d92d560ecf5a3d099f43ff3d944a05",
    "packages/daemon/src/daemon-host/task-worktree.ts#ensurePinnedCommit.timeoutMs",
    "{ timeoutMs: 30_000 },",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-worktree.ts#reviewGit.timeoutMs:56d92d560ecf5a3d099f43ff3d944a05",
    "packages/daemon/src/daemon-host/task-worktree.ts#reviewGit.timeoutMs",
    "{ timeoutMs: 30_000 },",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-worktree.ts#verifyReviewCheckout.head.timeoutMs:56d92d560ecf5a3d099f43ff3d944a05",
    "packages/daemon/src/daemon-host/task-worktree.ts#verifyReviewCheckout.head.timeoutMs",
    "{ timeoutMs: 30_000 },",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/task-worktree.ts#verifyHandoffWorktree.git.timeoutMs:56d92d560ecf5a3d099f43ff3d944a05",
    "packages/daemon/src/daemon-host/task-worktree.ts#verifyHandoffWorktree.git.timeoutMs",
    "{ timeoutMs: 30_000 },",
  ],
  [
    "policy:packages/application:packages/application/src/queries/work-briefs-read.ts#SENTENCE_PART_LIMIT:6004892579075d641e89f338dfbb4a10",
    "packages/application/src/queries/work-briefs-read.ts#SENTENCE_PART_LIMIT",
    "SENTENCE_PART_LIMIT = 2,",
  ],
  [
    "policy:packages/application:packages/application/src/queries/work-briefs-read.ts#OPEN_TASK_LIMIT:dfde5a19a31503a81f6669566b2fedac",
    "packages/application/src/queries/work-briefs-read.ts#OPEN_TASK_LIMIT",
    "OPEN_TASK_LIMIT = 50,",
  ],
  [
    "policy:packages/application:packages/application/src/queries/work-briefs-read.ts#DELIVERED_TASK_LIMIT:363e7e393b64beafdfca36b5d4fd905d",
    "packages/application/src/queries/work-briefs-read.ts#DELIVERED_TASK_LIMIT",
    "DELIVERED_TASK_LIMIT = 10,",
  ],
  [
    "policy:packages/application:packages/application/src/queries/work-read.ts#WORK_RECEIPT_CANDIDATE_LIMIT:cf0a7ed8b22335b75ba7a32d6618d5e7",
    "packages/application/src/queries/work-read.ts#WORK_RECEIPT_CANDIDATE_LIMIT",
    "const WORK_RECEIPT_CANDIDATE_LIMIT = 3,",
  ],
  [
    "policy:packages/application:packages/application/src/queries/work-read.ts#workShowFromProjection.scope.limit:566e0d0917d2d5e10ead25ab3a9e3260",
    "packages/application/src/queries/work-read.ts#workShowFromProjection.scope.limit",
    "const scope = workspaceStructureFromProjection(projection, { rootTaskId: input.taskId, limit: 500 }),",
  ],
  [
    "policy:packages/application:packages/application/src/queries/work-topology-read.ts#TASK_INDEX_PAGE_LIMIT:ae9c739e12cfbdbd828ba77247fae0fe",
    "packages/application/src/queries/work-topology-read.ts#TASK_INDEX_PAGE_LIMIT",
    "const TASK_INDEX_PAGE_LIMIT = 500;",
  ],
  [
    "policy:packages/application:packages/application/src/queries/work-topology-read.ts#workTopologyFromProjection.rootRead.limit:0dd585c292e12f6bf0b47a1d330750d6",
    "packages/application/src/queries/work-topology-read.ts#workTopologyFromProjection.rootRead.limit",
    "rootRead = projection.readTaskIndex({ taskIds: [input.workRootTaskId], limit: 1 });",
  ],
] as const;
