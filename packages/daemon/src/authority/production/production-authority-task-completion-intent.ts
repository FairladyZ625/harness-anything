import {
  decodeTaskLifecycleTransitionCheckpoint,
  encodeTaskLifecycleTransitionCommandPayloadV2,
  evaluateTaskCompletionAuthority,
  makeTaskHolderService,
  parseTaskContractSnapshot,
  resolveTaskCompletionGates,
  resolveTaskCurrentRound,
  taskLifecycleTransitionId,
  TaskLifecycleTransitionService,
  type CanonicalTaskMutationPlan,
  type ExistingTaskLifecycleTransition,
  type ProductionAuthorityCommand,
  type TaskCompleteTransitionCommand
} from "@harness-anything/application";
import {
  consentDeclaration,
  makeLocalVersionControlSystem,
  reviewDeclaration,
  sha256Text,
  type ConsentRecord,
  type ExecutionRecord,
  type RegistryEntityRefV2,
  type ReviewRecord
} from "@harness-anything/kernel";
import type { CanonicalAttemptIntent } from "./production-authority-attempt-compiler.ts";
import {
  absentLifecycleSnapshot,
  lifecycleIntent,
  lifecycleMutation,
  lifecycleRef,
  optionalLifecycleSnapshot,
  portableLifecyclePaths,
  readTaskDocuments,
  requiredLifecycleSnapshot,
  resolvedTaskRoot,
  taskLifecyclePath
} from "./production-authority-lifecycle-support.ts";
import {
  resolveVerifiedTaskCompleteWitnesses,
  verifyTaskCompleteWitnessRefs
} from "./task-complete-prepublish-witness.ts";

export async function taskCompletionIntent(
  authoredRoot: string,
  rootDir: string,
  layoutOverrides: ProductionAuthorityCommand["layoutOverrides"],
  completedAt: string,
  sessionId: string,
  action: Extract<ProductionAuthorityCommand["action"], { readonly kind: "task-complete" }>,
  canonicalEntityId: string,
  actor: ExecutionRecord["primary_actor"]
): Promise<CanonicalAttemptIntent> {
  const taskId = action.taskId;
  const taskRoot = resolvedTaskRoot(authoredRoot, taskId);
  const documents = readTaskDocuments(taskRoot);
  const taskPath = taskLifecyclePath(authoredRoot, taskId, "INDEX.md");
  const taskSnapshot = requiredLifecycleSnapshot(authoredRoot, taskPath.logical, taskPath.physical);
  const status = /^  status:\s*(\S+)$/mu.exec(taskSnapshot.body)?.[1] ?? "unknown";
  const contractPath = taskLifecyclePath(authoredRoot, taskId, "task-contract.json");
  const contractSnapshot = optionalLifecycleSnapshot(authoredRoot, contractPath.logical, contractPath.physical);
  const contractBodySha256 = contractSnapshot ? sha256Text(contractSnapshot.body) : null;
  const completionGates = resolveLifecycleCompletionGates(contractSnapshot?.body);
  const command = action as TaskCompleteTransitionCommand;
  const holder = await makeTaskHolderService({ rootInput: { rootDir, layoutOverrides } }).holder({ taskId });
  const currentRound = resolveTaskCurrentRound({ taskId, executionId: command.executionId, documents });
  const transitionId = taskLifecycleTransitionId(command.callerIdempotencyKey);
  const existing = existingLifecycleTransition(documents, taskId, transitionId, command.callerIdempotencyKey);
  const witnessInput = {
    rootDir, authoredRoot, taskId, documents, command,
    requireCodeDoc: completionGates.includes("code-doc-reconciliation")
  };
  const witnesses = existing
    ? verifyTaskCompleteWitnessRefs({ ...witnessInput, refs: existing.externalCheckpointRefs, snapshotMode: "committed" })
    : resolveVerifiedTaskCompleteWitnesses(witnessInput);
  assertLifecycleCompletionPrerequisites(documents, command, completionGates);
  const selectedReplayApproval = !existing && currentRound.kind === "accepted-replay"
    ? acceptedReplayApproval(documents, taskId, currentRound.execution)
    : undefined;
  const commitEvidence = !existing && command.evidenceMode === "commit-anchor"
    ? commitCompletionEvidence({
        taskId,
        command,
        status,
        documents,
        actor,
        sessionId,
        completedAt,
        completionGates,
        rootDir,
        resolvedCommit: resolveLifecycleCommit(rootDir, command.commitRef ?? "HEAD")
      })
    : undefined;
  const plan = TaskLifecycleTransitionService.plan({
    taskId,
    taskStatus: status,
    currentRound,
    holder,
    sessionBinding: { sessionId, actor },
    verifiedExternalWitnesses: witnesses,
    completionContractBodySha256: contractBodySha256,
    ...(existing ? { existingTransition: existing.transition } : {}),
    ...(selectedReplayApproval ? { acceptedReplayApproval: selectedReplayApproval } : {}),
    ...(commitEvidence ? { commitEvidence } : {})
  }, command);
  const checkpointPath = taskLifecyclePath(authoredRoot, taskId, `transitions/${plan.transitionId}.json`);
  const snapshots = lifecyclePlanSnapshots(authoredRoot, taskId, documents, plan, checkpointPath);
  return lifecycleIntent(
    "task.lifecycle-complete",
    encodeTaskLifecycleTransitionCommandPayloadV2({ schema: "task.lifecycle-complete/v1", plan }),
    lifecyclePlanMutations(plan),
    lifecyclePlanRefs(plan),
    lifecyclePlanPortablePaths(authoredRoot, taskId, plan),
    canonicalEntityId,
    snapshots
  );
}

function resolveLifecycleCompletionGates(contractBody: string | undefined): ReadonlyArray<string> {
  const resolved = resolveTaskCompletionGates({
    ...(contractBody ? { snapshot: parseTaskContractSnapshot(contractBody) } : {})
  });
  if (!resolved.ok) throw new Error(`AUTHORITY_TASK_COMPLETE_CONTRACT_INVALID:${resolved.message}`);
  return resolved.gates;
}

function existingLifecycleTransition(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  taskId: string,
  transitionId: string,
  callerIdempotencyKey: string
): {
  readonly transition: ExistingTaskLifecycleTransition;
  readonly externalCheckpointRefs: ReadonlyArray<import("@harness-anything/application").TaskCompleteExternalCheckpointRef>;
} | undefined {
  const document = documents.find((entry) => entry.path === `transitions/${transitionId}.json`);
  if (!document) return undefined;
  const decoded = decodeTaskLifecycleTransitionCheckpoint(document.body);
  if (decoded.transition.taskId !== taskId
    || decoded.transition.transitionId !== transitionId
    || decoded.transition.callerIdempotencyKey !== callerIdempotencyKey) {
    throw new Error("AUTHORITY_TASK_COMPLETE_TRANSITION_IDEMPOTENCY_CONFLICT");
  }
  return decoded;
}

function assertLifecycleCompletionPrerequisites(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  command: TaskCompleteTransitionCommand,
  completionGates: ReadonlyArray<string>
): void {
  const closeout = documents.find((document) => document.path === "closeout.md");
  if (!closeout || !closeout.body.trim()) throw new Error("AUTHORITY_TASK_COMPLETE_CLOSEOUT_REQUIRED");
  if (completionGates.includes("ci") && command.ciGate !== "passed") {
    throw new Error(`AUTHORITY_TASK_COMPLETE_CI_GATE_REQUIRED:${command.ciGate ?? "missing"}`);
  }
}

function commitCompletionEvidence(input: {
  readonly taskId: string;
  readonly command: TaskCompleteTransitionCommand;
  readonly status: string;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  readonly actor: ExecutionRecord["primary_actor"];
  readonly sessionId: string;
  readonly completedAt: string;
  readonly completionGates: ReadonlyArray<string>;
  readonly rootDir: string;
  readonly resolvedCommit: string;
}) {
  const evaluation = evaluateTaskCompletionAuthority({
    taskId: input.taskId,
    mode: "commit-anchor",
    status: input.status,
    documents: input.documents,
    actor: input.actor,
    sessionRef: `session/${input.sessionId}`,
    judgedAt: input.completedAt,
    applicableGates: input.completionGates,
    ciGate: input.command.ciGate ?? undefined,
    commitRef: input.resolvedCommit,
    judgment: input.command.judgment ?? undefined,
    rootDir: input.rootDir,
    versionControlSystem: makeLocalVersionControlSystem()
  });
  if (!evaluation.ok || evaluation.evidenceMode !== "commit-anchor") {
    const issues = evaluation.ok ? ["evidence_mode_mismatch"] : evaluation.issues.map((issue) => issue.code);
    throw new Error(`AUTHORITY_TASK_COMPLETE_REJECTED:${issues.join(",")}`);
  }
  return evaluation.evidence;
}

function acceptedReplayApproval(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  taskId: string,
  execution: ExecutionRecord
): { readonly reviewId: string; readonly consentId: string } | undefined {
  const executionRef = `execution/${taskId}/${execution.execution_id}`;
  const approvals = documents
    .filter((document) => /^reviews\/[^/]+\.md$/u.test(document.path))
    .map((document) => reviewDeclaration.documentCodec.decode(document.body) as ReviewRecord)
    .filter((review) => review.task_ref === `task/${taskId}`
      && review.execution_ref === executionRef
      && review.verdict === "approved"
      && review.approval_basis?.kind === "human-consent")
    .map((review) => {
      const basis = review.approval_basis;
      if (!basis || basis.kind !== "human-consent") return null;
      const match = /^consent\/[^/]+\/(cns_[^/]+)$/u.exec(basis.consent_ref);
      const consentId = match?.[1];
      if (!consentId) return null;
      const consentDocument = documents.find((document) => document.path === `consents/${consentId}.md`);
      if (!consentDocument) return null;
      const consent = consentDeclaration.documentCodec.decode(consentDocument.body) as ConsentRecord;
      return consent.state === "consumed" && consent.consumed_by === `review/${taskId}/${review.review_id}`
        ? { reviewId: review.review_id, consentId }
        : null;
    })
    .filter((entry): entry is { readonly reviewId: string; readonly consentId: string } => entry !== null);
  if (approvals.length > 1) {
    throw new Error(`AUTHORITY_TASK_COMPLETE_ACCEPTED_REPLAY_APPROVAL_AMBIGUOUS:${approvals.map((entry) => entry.reviewId).join(",")}`);
  }
  return approvals[0];
}

function resolveLifecycleCommit(rootDir: string, ref: string): string {
  const resolved = makeLocalVersionControlSystem().resolveCommit(rootDir, ref);
  if (!resolved.ok) throw new Error(`AUTHORITY_TASK_COMPLETE_COMMIT_REF_INVALID:${ref}:${resolved.reason}`);
  return resolved.sha;
}

function lifecyclePlanMutations(plan: CanonicalTaskMutationPlan): CanonicalAttemptIntent["mutations"] {
  switch (plan.kind) {
    case "execution-review": {
      const recorded = plan.command.approval?.consentSource.kind === "recorded-consent";
      return [
        ...(recorded ? [] : [lifecycleMutation("consent", `consent/${plan.taskId}/${plan.consentId}`, "grant")]),
        lifecycleMutation("consent", `consent/${plan.taskId}/${plan.consentId}`, "consume"),
        lifecycleMutation("review", `review/${plan.taskId}/${plan.reviewId}`, "record"),
        lifecycleMutation("execution", `execution/${plan.taskId}/${plan.executionId}`, "close"),
        lifecycleMutation("task", `task/${plan.taskId}`, "transition"),
        lifecycleMutation("task", `task/${plan.taskId}`, "document")
      ];
    }
    case "accepted-replay":
    case "commit-anchor":
      return [
        lifecycleMutation("task", `task/${plan.taskId}`, "transition"),
        lifecycleMutation("task", `task/${plan.taskId}`, "document")
      ];
    case "already-committed":
      return [lifecycleMutation("task", `task/${plan.taskId}`, "transition")];
    default:
      return lifecyclePlanNever(plan);
  }
}

function lifecyclePlanRefs(plan: CanonicalTaskMutationPlan): ReadonlyArray<RegistryEntityRefV2> {
  switch (plan.kind) {
    case "execution-review":
      return [
        lifecycleRef("execution", `execution/${plan.taskId}/${plan.executionId}`),
        lifecycleRef("consent", `consent/${plan.taskId}/${plan.consentId}`),
        lifecycleRef("review", `review/${plan.taskId}/${plan.reviewId}`),
        lifecycleRef("task", `task/${plan.taskId}`)
      ];
    case "accepted-replay":
      return [
        lifecycleRef("execution", `execution/${plan.taskId}/${plan.executionId}`),
        lifecycleRef("review", `review/${plan.taskId}/${plan.approvedReviewId}`),
        lifecycleRef("consent", `consent/${plan.taskId}/${plan.consumedConsentId}`),
        lifecycleRef("task", `task/${plan.taskId}`)
      ];
    case "commit-anchor":
    case "already-committed":
      return [lifecycleRef("task", `task/${plan.taskId}`)];
    default:
      return lifecyclePlanNever(plan);
  }
}

function lifecyclePlanSnapshots(
  authoredRoot: string,
  taskId: string,
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  plan: CanonicalTaskMutationPlan,
  checkpointPath: ReturnType<typeof taskLifecyclePath>
): CanonicalAttemptIntent["declaredPathCas"] {
  const snapshots: Array<CanonicalAttemptIntent["declaredPathCas"][number]> = [];
  for (const targetPath of lifecyclePlanReadPaths(plan)) {
    const entry = targetPath === `transitions/${plan.transitionId}.json`
      ? checkpointPath
      : taskLifecyclePath(authoredRoot, taskId, targetPath);
    const document = documents.find((candidate) => candidate.path === targetPath);
    snapshots.push(document
      ? requiredLifecycleSnapshot(authoredRoot, entry.logical, entry.physical)
      : absentLifecycleSnapshot(entry.logical));
  }
  return [...new Map(snapshots.map((snapshot) => [snapshot.path, snapshot])).values()];
}

function lifecyclePlanPortablePaths(
  authoredRoot: string,
  taskId: string,
  plan: CanonicalTaskMutationPlan
): ReadonlyArray<string> {
  const paths = lifecyclePlanWritePaths(plan).map((relativePath) =>
    taskLifecyclePath(authoredRoot, taskId, relativePath));
  return portableLifecyclePaths(...paths);
}

function lifecyclePlanReadPaths(plan: CanonicalTaskMutationPlan): ReadonlyArray<string> {
  const common = ["INDEX.md", `transitions/${plan.transitionId}.json`, "task-contract.json"];
  switch (plan.kind) {
    case "execution-review":
      return [...common, `executions/${plan.executionId}.md`, `reviews/${plan.reviewId}.md`, `consents/${plan.consentId}.md`];
    case "accepted-replay":
      return [...common, `executions/${plan.executionId}.md`, `reviews/${plan.approvedReviewId}.md`, `consents/${plan.consumedConsentId}.md`];
    case "commit-anchor":
      return [...common, "completion-evidence.json"];
    case "already-committed":
      return [...common, ...(plan.executionId ? [`executions/${plan.executionId}.md`] : [])];
    default:
      return lifecyclePlanNever(plan);
  }
}

function lifecyclePlanWritePaths(plan: CanonicalTaskMutationPlan): ReadonlyArray<string> {
  const common = ["INDEX.md", `transitions/${plan.transitionId}.json`];
  switch (plan.kind) {
    case "execution-review":
      return [...common, `executions/${plan.executionId}.md`, `reviews/${plan.reviewId}.md`, `consents/${plan.consentId}.md`];
    case "accepted-replay":
      return [...common, `executions/${plan.executionId}.md`];
    case "commit-anchor":
      return [...common, "completion-evidence.json"];
    case "already-committed":
      return ["INDEX.md"];
    default:
      return lifecyclePlanNever(plan);
  }
}

function lifecyclePlanNever(value: never): never {
  throw new Error(`AUTHORITY_TASK_LIFECYCLE_PLAN_EXHAUSTIVENESS_BREACH:${String(value)}`);
}
