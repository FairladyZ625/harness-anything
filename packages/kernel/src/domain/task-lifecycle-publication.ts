import type { ExecutionV1 } from "./execution.ts";
import { approvedReviewsForCut, consentedApprovedReview } from "./review.ts";
import type { ReviewConsentV1, ReviewV1 } from "./review.ts";
import type { LifecycleDocumentClaim, TaskEventV1 } from "./task-lifecycle-event.ts";
import type { TaskLifecycleSnapshot } from "./task-lifecycle.contract.ts";
import {
  freezeDeclaredWritePlan,
  isFrozenWritePlan,
  type FrozenWritePlan,
  type WriteTarget,
} from "./write-chain.contract.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { formatRelationFlowRecord } from "./entity-relation.ts";
import { currentTaskForWrite } from "./task.ts";
import { codeDocRecordId, currentCodeDocRecord, currentCodeDocWitness } from "./code-doc-witness.ts";
export interface LifecycleDocumentState {
  readonly path: string;
  readonly body: string;
  readonly blobSha256: string;
}
export interface LifecycleContentBlob {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "text/markdown" | "application/json";
  readonly body: string;
}
// A `task_amended` event that changes the title also retitles the already-published
// `task_plan.md` through the typed lifecycle route (the same first-H1 replace renderIndex
// applies to INDEX.md). The plan claim is conditional: a plan that canonical never published
// stays unpublished and takes its first H1 from its first prose sync, so the claim list —
// and therefore this replay invariant — only names the plan when the event actually claims it.
export function lifecycleDocumentPaths(event: TaskEventV1, packagePath: string): readonly string[] {
  if (event.type === "task_created" || event.type === "lease_renewed") return [];
  const base = mutationDocumentPaths(event, packagePath);
  if (!("execution" in event.payload)) {
    const plan = retitledTaskPlanPath(event, packagePath);
    return plan !== null && event.payload.documentClaims?.some((claim) => claim.path === plan) ? [...base, plan] : base;
  }
  const paths = [`${packagePath}/INDEX.md`, `${packagePath}/executions/${event.payload.execution.executionId}.md`];
  if (event.type === "review_recorded" || event.type === "review_consent_recorded")
    paths.push(`${packagePath}/reviews/${event.payload.review.reviewId}.md`);
  if (event.type === "code_doc_reconciled" || event.type === "code_doc_repointed")
    paths.push(`${packagePath}/code-doc-anchors.json`);
  return paths;
}
// Superset of `lifecycleDocumentPaths` for callers gathering current document bodies before a
// write: it probes the retitled plan even when the event does not (yet) claim it, so the compile
// step can decide claim inclusion from whether the plan is published.
export function lifecycleDocumentFetchPaths(event: TaskEventV1, packagePath: string): readonly string[] {
  if (event.type === "task_created" || event.type === "lease_renewed") return [];
  const base = mutationDocumentPaths(event, packagePath);
  if ("execution" in event.payload) return lifecycleDocumentPaths(event, packagePath);
  const plan = retitledTaskPlanPath(event, packagePath);
  return plan !== null && !base.includes(plan) ? [...base, plan] : base;
}
function mutationDocumentPaths(event: TaskEventV1, packagePath: string): readonly string[] {
  return [
    `${packagePath}/INDEX.md`,
    `${packagePath}/task-contract.json`,
    ...(event.payload.task.metadata?.moduleKey ? [`${packagePath}/module.md`] : []),
  ];
}
export function retitledTaskPlanPath(event: TaskEventV1, packagePath: string): string | null {
  return event.type === "task_amended" && event.payload.mutation.fields.includes("title")
    ? `${packagePath}/task_plan.md`
    : null;
}
export function compileTaskLifecycleWrite(input: {
  readonly event: TaskEventV1;
  readonly snapshot: TaskLifecycleSnapshot;
  readonly packagePath: string | null;
  readonly currentDocuments: readonly LifecycleDocumentState[];
}): {
  readonly event: TaskEventV1;
  readonly plan: FrozenWritePlan;
  readonly blobs: readonly LifecycleContentBlob[];
  readonly changedPaths: readonly string[];
} {
  const sourceEvent = {
      ...input.event,
      payload: {
        ...input.event.payload,
        task: currentTaskForWrite(input.event.payload.task),
      },
    } as TaskEventV1,
    snapshot =
      input.snapshot.task === null
        ? input.snapshot
        : { ...input.snapshot, task: currentTaskForWrite(input.snapshot.task) },
    planPath = input.packagePath ? retitledTaskPlanPath(sourceEvent, input.packagePath) : null,
    invariantPaths = input.packagePath ? lifecycleDocumentPaths(sourceEvent, input.packagePath) : [],
    planBase =
      planPath === null ? null : (input.currentDocuments.find((document) => document.path === planPath) ?? null),
    paths =
      planPath !== null && planBase !== null && !invariantPaths.includes(planPath)
        ? [...invariantPaths, planPath]
        : invariantPaths,
    current = new Map(input.currentDocuments.map((value) => [value.path, value.body])),
    bodies = paths.map((path) => ({
      path,
      body: renderLifecycleDocument(sourceEvent, snapshot, path, current.get(path) ?? null),
    })),
    claims: LifecycleDocumentClaim[] = bodies.map(({ path, body }) => ({
      path,
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: path.endsWith(".json") ? "application/json" : "text/markdown",
      policyId: path === planPath ? "markdown-body-replaceable/v1" : "typed-machine-writer/v1",
    }));
  for (const claim of claims)
    if (normalizeRelativeDocumentPath(claim.path) !== claim.path)
      throw new Error(`invalid lifecycle path ${claim.path}`);
  const event = {
      ...sourceEvent,
      payload: { ...sourceEvent.payload, documentClaims: claims },
    } as TaskEventV1,
    blobs = claims.map((claim, index) => ({
      sha256: claim.sha256,
      size: claim.size,
      mediaType: claim.mediaType,
      body: bodies[index]!.body,
    }));
  return {
    event,
    plan: taskLifecycleWritePlan(event),
    blobs,
    changedPaths: claims.map((claim) => claim.path),
  };
}
export function taskLifecycleWritePlan(event: TaskEventV1): FrozenWritePlan {
  const targets: WriteTarget[] = [
    {
      kind: "event_file",
      path: eventObjectTarget(event.opId),
      operation: "create",
    },
    {
      kind: "event_head",
      path: "harness/events/head.json",
      operation: "replace",
    },
    {
      kind: "projection_invalidation",
      projection: "task-lifecycle/v1",
      key: event.taskId,
    },
  ];
  for (const claim of event.payload.documentClaims ?? [])
    targets.push(
      {
        kind: "authored_file",
        path: claim.path,
        operation: "replace",
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
      },
      {
        kind: "content_blob",
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
      },
      {
        kind: "projection_invalidation",
        projection: "document/v1",
        key: claim.path,
      },
    );
  for (const change of event.payload.carriedDocumentClaims ?? [])
    targets.push(
      {
        kind: "authored_file",
        path: change.path,
        operation: "replace",
        sha256: change.candidate.sha256,
        size: change.candidate.size,
        mediaType: change.candidate.mediaType,
      },
      {
        kind: "content_blob",
        sha256: change.candidate.sha256,
        size: change.candidate.size,
        mediaType: change.candidate.mediaType,
      },
      {
        kind: "projection_invalidation",
        projection: "document/v1",
        key: change.path,
      },
    );
  if (event.type === "execution_started")
    targets.push(lease(event.taskId, "reserve"), lease(event.taskId, "activate"), lease(event.taskId, "release"));
  if (event.type === "execution_submitted" || event.type === "lease_released")
    targets.push(lease(event.taskId, "release"));
  return freezeDeclaredWritePlan({ commandType: event.type, targets }, [event.type]);
}
export function assertTaskLifecycleWritePlan(event: TaskEventV1, plan: FrozenWritePlan | undefined): void {
  const shape = (value: FrozenWritePlan) =>
    stableStringify({
      commandType: value.commandType,
      targets: value.targets.map(stableStringify).sort(),
    });
  if (!plan || !isFrozenWritePlan(plan) || shape(plan) !== shape(taskLifecycleWritePlan(event)))
    throw new Error(
      "lifecycle write plan must exactly declare event, authored documents, blobs, lease, and projections",
    );
}
export function renderLifecycleDocument(
  event: TaskEventV1,
  snapshot: TaskLifecycleSnapshot,
  path: string,
  base: string | null,
): string {
  if (path.endsWith("/INDEX.md")) return renderIndex(event, snapshot, path, base);
  if (path.endsWith("/task-contract.json")) return renderContract(snapshot, base);
  if (path.endsWith("/module.md")) return renderModule(snapshot);
  if (path.endsWith("/task_plan.md") && retitledTaskPlanPath(event, path.slice(0, -"/task_plan.md".length)) !== null)
    return renderTaskPlan(snapshot, path, base);
  if (path.endsWith("/code-doc-anchors.json") && event.type === "code_doc_reconciled")
    return `${stableStringify(event.payload.witness)}\n`;
  if (path.endsWith("/code-doc-anchors.json") && event.type === "code_doc_repointed") {
    if (base === null) throw new Error("code-doc repoint requires an existing anchor document");
    return `${base}${base.endsWith("\n") ? "" : "\n"}${stableStringify(event.payload.record)}\n`;
  }
  if (path.includes("/reviews/")) {
    const review =
      event.type === "review_recorded" || event.type === "review_consent_recorded"
        ? event.payload.review
        : snapshot.reviews.find((value) => path.endsWith(`/${value.reviewId}.md`));
    return renderReview(
      review as ReviewV1,
      snapshot.consents.find((value) => value.reviewId === review?.reviewId) ?? null,
    );
  }
  const execution =
    "execution" in event.payload
      ? event.payload.execution
      : snapshot.executions.find((value) => path.endsWith(`/${value.executionId}.md`));
  return renderExecution(execution as ExecutionV1, snapshot);
}
// The retitle owns only the first H1 line — the same single replace renderIndex applies to the
// INDEX body. Everything else in the plan is worker prose and stays byte-for-byte.
function renderTaskPlan(snapshot: TaskLifecycleSnapshot, path: string, base: string | null): string {
  const task = snapshot.task!;
  if (base === null) throw new Error(`cannot retitle an unpublished task plan: ${path}`);
  return base.replace(/^# .*$/mu, `# ${task.title}`);
}
function renderIndex(event: TaskEventV1, snapshot: TaskLifecycleSnapshot, path: string, base: string | null): string {
  const task = snapshot.task!,
    current =
      "execution" in event.payload
        ? event.payload.execution
        : snapshot.executions.find((value) => value.iteration === task.iteration && value.state === "submitted"),
    executionId = current?.executionId ?? "",
    approved = current?.submission
      ? approvedReviewsForCut(snapshot.reviews, executionId, current.submission.commitSha, current.iteration)
      : [],
    selected = current?.submission
      ? consentedApprovedReview(
          snapshot.reviews,
          snapshot.consents,
          executionId,
          current.submission.commitSha,
          current.iteration,
        )
      : undefined,
    consentReviewId = approved.length === 1 ? approved[0]!.reviewId : "<review-id>",
    gateStatus = (gateId: string) =>
      gateId === "code-doc-reconciliation"
        ? currentCodeDocWitness(snapshot.codeDocWitnesses, executionId) !== undefined
        : snapshot.gateWitnesses.some((value) => value.executionId === executionId && value.gateId === gateId),
    missingGate = task.completionGateIds.find((gateId) => !gateStatus(gateId)),
    next =
      task.status === "active"
        ? `Run \`ha task submit ${task.taskId} --execution-id <id> --from-file <submission.json>\`.`
        : task.status === "in_review" && !approved.length
          ? [
              `Run \`ha task review-execution ${task.taskId}`,
              " --execution-id <id> --review-id <id> --from-file <review.json>`.",
            ].join("")
          : task.status === "in_review" && !selected
            ? [
                `Run \`ha task review-consent ${task.taskId} --execution-id <id>`,
                ` --review-id ${consentReviewId} --consent-id <id>\`.`,
              ].join("")
            : missingGate === "ci"
              ? `Run \`ha task complete ${task.taskId} --execution-id <id> --ci passed\`.`
              : missingGate === "code-doc-reconciliation"
                ? [
                    `Run \`ha task code-doc reconcile ${task.taskId} --execution-id <id>`,
                    " --commit-sha <sha> --iteration <n> --path <path>`.",
                  ].join("")
                : task.status === "done"
                  ? "Task complete."
                  : task.status === "cancelled"
                    ? "Task cancelled; create follow-up work with `ha task supersede`."
                    : `Run \`ha task complete ${task.taskId} --execution-id <id>\`.`,
    gates = task.completionGateIds.length
      ? task.completionGateIds.map((gateId) => `- ${gateId}: ${gateStatus(gateId) ? "pass" : "blocked"}`).join("\n")
      : "- none",
    metadata = task.metadata;
  let initial =
    base ??
    `---\ntaskId: ${task.taskId}\nstatus: ${task.status}\nowner: machine\n---\n# ${task.title}\n\n## Next\n\n${next}\n`;
  if (metadata) {
    const body = (base?.replace(/^---\n[\s\S]*?\n---\n/u, "") ?? `# ${task.title}\n\n## Next\n\n${next}\n`).replace(
        /^# .*$/mu,
        `# ${task.title}`,
      ),
      packagePath = path.slice(0, -"/INDEX.md".length);
    initial = [
      "---\n",
      "schema: task-package/v2\n",
      `task_id: ${task.taskId}\n`,
      `title: ${JSON.stringify(task.title)}\n`,
      metadata.parentTaskId ? `parent: ${metadata.parentTaskId}\n` : "",
      "lifecycle:\n  engine: kernel/task-lifecycle/v1\n",
      `  status: ${task.status}\n`,
      `packageDisposition: ${task.packageDisposition ?? "active"}\n`,
      task.supersededBy ? `supersededBy: ${task.supersededBy}\n` : "",
      metadata.workKind ? `workKind: ${metadata.workKind}\n` : "",
      metadata.riskTier ? `riskTier: ${metadata.riskTier}\n` : "",
      metadata.urgency ? `urgency: ${metadata.urgency}\n` : "",
      `vertical: ${metadata.verticalId}\n`,
      `preset: ${metadata.presetId}\n`,
      `profile: ${metadata.profileId}\n`,
      `packagePath: ${packagePath}\n`,
      "owner: machine\nrelations:\n",
      (task.relations ?? []).map(formatRelationFlowRecord).join("\n"),
      `\n---\n${body}`,
    ].join("");
  }
  return initial
    .replace(/^status:.*$/mu, `status: ${task.status}`)
    .replace(/^  status:.*$/mu, `  status: ${task.status}`)
    .replace(/## Next\n[\s\S]*$/u, `## Next\n\n${next}\n\n## Gate Checks\n\n${gates}\n`);
}
function renderContract(snapshot: TaskLifecycleSnapshot, base: string | null): string {
  const task = snapshot.task!,
    current = base ? (JSON.parse(base) as Record<string, unknown>) : {},
    metadata = JSON.parse(stableStringify(task.metadata ?? null)) as unknown,
    relations = JSON.parse(stableStringify(task.relations ?? [])) as unknown;
  return `${JSON.stringify(
    {
      ...current,
      schema: "task-contract/v1",
      contractVersion: task.contractVersion ?? 1,
      taskId: task.taskId,
      title: task.title,
      taskClass: task.taskClass,
      pinned: task.pinned ?? false,
      metadata,
      relations,
    },
    null,
    2,
  )}\n`;
}
function renderModule(snapshot: TaskLifecycleSnapshot): string {
  const key = snapshot.task?.metadata?.moduleKey ?? "unassigned";
  return `# Module\n\nModule key: ${key}\nModule title: ${key}\n`;
}
function renderExecution(value: ExecutionV1, snapshot: TaskLifecycleSnapshot): string {
  const packet = value.submission,
    reviews = snapshot.reviews.filter((candidate) => candidate.executionId === value.executionId),
    selected = packet
      ? consentedApprovedReview(
          snapshot.reviews,
          snapshot.consents,
          value.executionId,
          packet.commitSha,
          value.iteration,
        )
      : undefined,
    witness = currentCodeDocRecord(snapshot.codeDocWitnesses, value.executionId),
    gates = snapshot.gateWitnesses.filter((candidate) => candidate.executionId === value.executionId);
  return [
    `# Execution ${value.executionId}\n\n`,
    "Managed by `ha task start/submit`; hand edits are rejected.\n\n",
    `- Task: ${value.taskId}\n`,
    `- Iteration: ${value.iteration}\n`,
    `- State: ${value.state}\n`,
    `- Claimed: ${value.claimedAt}\n`,
    `- Submitted: ${value.submittedAt ?? "pending"}\n`,
    `- Closed: ${value.closedAt ?? "open"}\n`,
    `- Commit: ${packet?.commitSha ?? "pending"}\n`,
    `- Completion claim: ${packet?.completionClaim ?? "pending"}\n`,
    `- Reviews: ${
      reviews.length ? reviews.map((review) => `${review.reviewId}/${review.verdict}`).join(", ") : "pending"
    }\n`,
    `- Selected review: ${selected?.review.reviewId ?? "pending"}\n`,
    `- Consent: ${selected?.consent.consentId ?? "pending"}\n`,
    `- Checker witnesses: ${
      gates.length ? gates.map((value) => `${value.gateId}/${value.receiptId}`).join(", ") : "pending"
    }\n`,
    `- Code-doc witness: ${witness ? codeDocRecordId(witness) : "pending"}${
      witness?.schema === "code-doc-witness-repoint/v1" && witness.disposition === "known-invalid"
        ? " (known-invalid)"
        : ""
    }\n`,
    "\n## Deliverables\n\n",
    list(packet?.deliverables ?? []),
    "\n\n## Outputs\n\n",
    list(packet?.outputs ?? []),
    "\n\n## Verification\n\n",
    list(packet?.verificationNotes ?? []),
    "\n\n## Known gaps\n\n",
    list(packet?.knownGaps ?? []),
    "\n\n## Residual risks\n\n",
    list(packet?.residualRisks ?? []),
    "\n",
  ].join("");
}
function renderReview(value: ReviewV1, consent: ReviewConsentV1 | null): string {
  return [
    `# Review ${value.reviewId}\n\n`,
    "Managed by `ha task review-execution`; legacy `review.md` is not authoritative.\n\n",
    `- Task: ${value.taskId}\n`,
    `- Execution: ${value.executionId}\n`,
    `- Verdict: ${value.verdict}\n`,
    `- Commit: ${value.commitSha}\n`,
    `- Iteration: ${value.iteration}\n`,
    `- Content digest: ${value.contentDigest}\n`,
    `- Reviewed at: ${value.reviewedAt}\n`,
    `- Consent: ${consent ? consent.consentId : "pending"}\n`,
    `- Consent actor: ${consent?.actor.principal.personId ?? "pending"}\n`,
    `- Consent source: ${consent ? stableStringify(consent.source) : "pending"}\n`,
    `\n## Reason\n\n${value.reason}\n`,
    "\n## Evidence checked\n\n",
    list(value.evidenceChecked),
    "\n",
  ].join("");
}
function list(values: readonly string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "- none";
}
function lease(taskId: string, operation: "reserve" | "activate" | "release"): WriteTarget {
  return { kind: "lease_sqlite", table: "lease_cas", taskId, operation };
}
