import { submissionDigest } from "./execution.ts";
import { digest } from "./digest.ts";
import type { ExecutionV1 } from "./execution.ts";
import { reviewDigest } from "./review.ts";
import { validateReviewFindings, validateReviewResolutions, validateTaskReviewResponseV1 } from "./review.ts";
import type { ReviewConsentV1, ReviewDispositionV1, ReviewV1, TaskReviewResponseV1 } from "./review.ts";
import { describeReviewConsentConflicts, reviewConsentConflicts } from "./review-consent-validity.ts";
import type { ContractValidationIssue, TaskV2 } from "./task.ts";
import type { TaskEdgeTaken } from "./task-graph.ts";
import { isNonEmptyString } from "./write-chain.contract.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import type {
  ReviewConsentRecordedEvent,
  ReviewConsentOverrideRecordedEvent,
  ReviewRecordedEvent,
  TaskReviewRespondedEvent,
  TaskCompletedEvent,
} from "./task-lifecycle-event.ts";
import { isSameExecution } from "./actor-domain-services.ts";
import { closeoutReadiness } from "./closeout-readiness.ts";
import { isValidCloseoutGateRecord } from "./settings-closeout.ts";
import { validFactStillHoldsAttestation } from "./fact-retirement-readiness.ts";
import type {
  CompleteTaskCommand,
  CompleteTaskProof,
  RecordReviewCommand,
  RecordReviewConsentCommand,
  RespondReviewCommand,
  ReviewConsentProof,
  ReviewProof,
  ReviewResponseProof,
  TaskLifecycleSnapshot,
  Transition,
} from "./task-lifecycle-contract-internal-types.ts";
import {
  canonicalGateReceipts,
  envelope,
  execution,
  lifecycleContractIssue,
  replaceExecution,
  revisionIssues,
  takeEdge,
} from "./task-lifecycle-contract-support.ts";

// Review, consent, and completion transition definitions.
function reviewIssues(
  snapshot: TaskLifecycleSnapshot,
  command: RecordReviewCommand,
  proof: Partial<ReviewProof>,
): ContractValidationIssue[] {
  const issues = revisionIssues(snapshot, command),
    current = execution(snapshot, command.executionId);
  if (
    snapshot.task?.status !== "in_review" ||
    snapshot.task.currentNode !== "review" ||
    current?.state !== "submitted" ||
    !current.submission
  )
    issues.push(lifecycleContractIssue("invalid_transition", "Review requires the current submitted execution"));
  else if (snapshot.reviews.some((value) => value.reviewId === command.reviewId))
    issues.push(lifecycleContractIssue("invalid_transition", "append-only Review history requires a new review id"));
  else if (
    command.commitSha !== current.submission.commitSha ||
    command.iteration !== current.iteration ||
    command.submissionDigest !== submissionDigest(current.submission)
  )
    issues.push(lifecycleContractIssue("invalid_proof", "Review must bind the current content cut"));
  if (
    !proof.actorBinding ||
    !isSameExecution(command.actor, proof.actorBinding) ||
    proof.capability !== "execution-review@v1" ||
    !isNonEmptyString(proof.capabilityRef) ||
    !isNonEmptyString(command.reviewId) ||
    !isNonEmptyString(command.reason) ||
    !Array.isArray(command.evidenceChecked) ||
    !digest(command.contentDigest) ||
    !Number.isSafeInteger(proof.reworkBudget) ||
    (proof.reworkBudget as number) < 1
  )
    issues.push(
      lifecycleContractIssue(
        "invalid_proof",
        "transport-bound execution review proof, content digest, and repository rework budget are required",
      ),
    );
  if (!Array.isArray(command.findings))
    issues.push(lifecycleContractIssue("missing_field", "new Review records must include a findings array"));
  else issues.push(...validateReviewFindings(command.findings));
  if (!Array.isArray(command.resolutions))
    issues.push(lifecycleContractIssue("missing_field", "new Review records must include a resolutions array"));
  else issues.push(...validateReviewResolutions(command.resolutions));
  const priorRebuttedFindings = priorRebuttedFindingKeys(snapshot, command.iteration),
    suppliedResolutionKeys = new Map<string, number>();
  for (const resolution of command.resolutions ?? []) {
    const key = `${resolution.reviewId}\0${resolution.findingId}`;
    suppliedResolutionKeys.set(key, (suppliedResolutionKeys.get(key) ?? 0) + 1);
    if (!priorRebuttedFindings.includes(key))
      issues.push(
        lifecycleContractIssue(
          "invalid_review",
          `resolution ${resolution.reviewId}/${resolution.findingId} does not address a rebutted finding from the prior review round`,
        ),
      );
  }
  for (const key of priorRebuttedFindings) {
    if (suppliedResolutionKeys.get(key) !== 1)
      issues.push(
        lifecycleContractIssue(
          "invalid_review",
          `re-review must include exactly one resolution for rebutted finding ${key.replace("\0", "/")}`,
        ),
      );
  }
  if (
    command.verdict === "changes_requested" &&
    command.findings !== undefined &&
    !command.findings.some((item) => item.blocking)
  )
    issues.push(lifecycleContractIssue("invalid_review", "changes_requested review requires a blocking finding"));
  return issues;
}

function priorRebuttedFindingKeys(snapshot: TaskLifecycleSnapshot, iteration: number): readonly string[] {
  const priorReviews = snapshot.reviews.filter((review) => review.iteration < iteration);
  if (priorReviews.length === 0) return [];
  const priorIteration = Math.max(...priorReviews.map((review) => review.iteration)),
    priorReviewIds = new Set(
      priorReviews.filter((review) => review.iteration === priorIteration).map((review) => review.reviewId),
    );
  return (snapshot.reviewResponses ?? [])
    .filter((response) => response.disposition === "rebut" && priorReviewIds.has(response.reviewId))
    .map((response) => `${response.reviewId}\0${response.findingId}`);
}
function reviewFrom(command: RecordReviewCommand, proof: ReviewProof): ReviewV1 {
  const qualificationEvidence =
    command.externalCompletionAnchor === undefined
      ? command.noIndependentReview === true
        ? [`NO INDEPENDENT REVIEW: ${command.noIndependentReviewReason}`]
        : []
      : [
          `external completion anchor: ${command.externalCompletionAnchor}`,
          `no dispatch reason: ${command.noDispatchReason}`,
        ];
  return {
    schema: "review/v1",
    reviewId: command.reviewId,
    taskId: command.taskId,
    executionId: command.executionId,
    verdict: command.verdict,
    actor: command.actor,
    capabilityRef: proof.capabilityRef,
    reason: command.reason,
    evidenceChecked: [...command.evidenceChecked, ...qualificationEvidence],
    commitSha: command.commitSha,
    iteration: command.iteration,
    contentDigest: command.contentDigest,
    submissionDigest: command.submissionDigest,
    reviewedAt: command.occurredAt,
    findings: [...(command.findings ?? [])],
    resolutions: [...(command.resolutions ?? [])],
  };
}
export const review: Transition = {
  actionId: "review",
  matches: (command) => command.type === "RecordReview",
  validate: (snapshot, raw, proof) => reviewIssues(snapshot, raw as RecordReviewCommand, proof as Partial<ReviewProof>),
  reduce: (snapshot, raw, rawProof) => {
    const command = raw as RecordReviewCommand,
      current = execution(snapshot, command.executionId) as ExecutionV1,
      recorded = reviewFrom(command, rawProof as ReviewProof),
      rework = reworkReopen(snapshot, command, recorded, rawProof as ReviewProof);
    // A changes_requested verdict is the return order itself: below the repository rework budget the
    // same transition that records the review reopens the implementation iteration, and the daemon
    // continues the submitting worker with the report (dec_E369B8616F50A6208B293997E7 CH3). At or
    // beyond the budget the verdict only records — the cut stays at the review gate for the owner.
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        ...(rework
          ? {
              task: rework.task,
              executions: replaceExecution(snapshot.executions, rework.execution),
              edgesTaken: [...snapshot.edgesTaken, rework.edge],
            }
          : {}),
        reviews: [...snapshot.reviews, recorded],
      },
      event: envelope<ReviewRecordedEvent>(command, "review_recorded", {
        task: rework ? rework.task : (snapshot.task as TaskV2),
        execution: rework ? rework.execution : current,
        review: recorded,
        ...(rework ? { edge: rework.edge } : {}),
      }),
    };
  },
};

/**
 * The automatic rework round a changes_requested verdict reopens, or null when the repository
 * rework budget is exhausted. The budget counts every returned cut this task has already taken
 * (executions closed as changes_requested), so legacy owner returns consume it too.
 */
function reworkReopen(
  snapshot: TaskLifecycleSnapshot,
  command: RecordReviewCommand,
  recorded: ReviewV1,
  proof: ReviewProof,
): { readonly task: TaskV2; readonly execution: ExecutionV1; readonly edge: TaskEdgeTaken } | null {
  if (command.verdict !== "changes_requested") return null;
  const resolutions = recorded.resolutions ?? [],
    upheld = resolutions.some((resolution) => resolution.resolution === "upheld"),
    newBlocking = (recorded.findings ?? []).some(
      (finding) =>
        finding.blocking &&
        !resolutions.some(
          (resolution) =>
            resolution.reviewId === recorded.reviewId &&
            resolution.findingId === finding.findingId &&
            resolution.resolution === "withdrawn",
        ),
    );
  // A re-review that upholds an earlier finding belongs to CEO disposition. Only a newly blocking
  // finding without an upheld resolution reopens the worker; legacy reviews without arrays retain
  // the W2 automatic-return behavior.
  if ((command.findings !== undefined || command.resolutions !== undefined) && (upheld || !newBlocking)) return null;
  const returned = snapshot.executions.filter((value) => value.state === "changes_requested").length;
  if (returned >= proof.reworkBudget) return null;
  const current = execution(snapshot, command.executionId) as ExecutionV1;
  return {
    task: {
      ...(snapshot.task as TaskV2),
      status: "active",
      currentNode: "implementation",
      iteration: (snapshot.task?.iteration ?? 0) + 1,
    },
    execution: { ...current, state: "changes_requested", closedAt: command.occurredAt },
    edge: takeEdge(
      snapshot.task as TaskV2,
      "changes_requested",
      recorded.reason,
      recorded.commitSha,
      current.iteration,
    ),
  };
}

function responseIssues(
  snapshot: TaskLifecycleSnapshot,
  command: RespondReviewCommand,
  proof: Partial<ReviewResponseProof>,
): ContractValidationIssue[] {
  const issues = revisionIssues(snapshot, command),
    current = execution(snapshot, command.executionId),
    currentResponses = snapshot.reviewResponses ?? [];
  if (
    snapshot.task?.status !== "active" ||
    snapshot.task.currentNode !== "implementation" ||
    current?.state !== "active"
  )
    issues.push(
      lifecycleContractIssue("invalid_transition", "Review responses require the active implementation execution"),
    );
  if (
    !current ||
    !proof.actorBinding ||
    !isSameExecution(proof.actorBinding, command.actor) ||
    proof.capability !== "execution-review-response@v1" ||
    !isNonEmptyString(proof.capabilityRef) ||
    !Array.isArray(command.responses) ||
    command.responses.length === 0
  )
    issues.push(
      lifecycleContractIssue("invalid_proof", "review response proof and a non-empty response packet are required"),
    );
  const seen = new Set<string>();
  for (const response of command.responses ?? []) {
    issues.push(
      ...validateTaskReviewResponseV1({ ...response, actor: command.actor, respondedAt: command.occurredAt }),
    );
    const key = `${response.reviewId}\0${response.findingId}`;
    if (seen.has(key) || currentResponses.some((value) => `${value.reviewId}\0${value.findingId}` === key))
      issues.push(
        lifecycleContractIssue(
          "invalid_transition",
          `review response ${response.reviewId}/${response.findingId} already exists`,
        ),
      );
    seen.add(key);
    const review = snapshot.reviews.find((value) => value.reviewId === response.reviewId);
    const finding = review?.findings?.find((value) => value.findingId === response.findingId);
    if (!review || review.verdict !== "changes_requested" || !finding || !finding.blocking)
      issues.push(
        lifecycleContractIssue(
          "invalid_transition",
          `blocking finding ${response.reviewId}/${response.findingId} does not exist`,
        ),
      );
  }
  return issues;
}

export const respondReview: Transition = {
  actionId: "respondReview",
  matches: (command) => command.type === "RespondReview",
  validate: (snapshot, raw, proof) =>
    responseIssues(snapshot, raw as RespondReviewCommand, proof as Partial<ReviewResponseProof>),
  reduce: (snapshot, raw) => {
    const command = raw as RespondReviewCommand,
      current = execution(snapshot, command.executionId) as ExecutionV1,
      responses: readonly TaskReviewResponseV1[] = command.responses.map((response) => ({
        ...response,
        actor: command.actor,
        respondedAt: command.occurredAt,
      }));
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        reviewResponses: [...(snapshot.reviewResponses ?? []), ...responses],
      },
      event: envelope<TaskReviewRespondedEvent>(command, "task_review_responded", {
        task: snapshot.task as TaskV2,
        execution: current,
        responses,
      }),
    };
  },
};
export const consent: Transition = {
  actionId: "consent",
  matches: (command) => command.type === "RecordReviewConsent",
  validate: (snapshot, raw, rawProof) => {
    const command = raw as RecordReviewConsentCommand,
      proof = rawProof as Partial<ReviewConsentProof>,
      issues = revisionIssues(snapshot, command),
      current = execution(snapshot, command.executionId),
      recorded = snapshot.reviews.find(
        (value) => value.reviewId === command.reviewId && value.executionId === command.executionId,
      ),
      currentSubmissionDigest = current?.submission ? submissionDigest(current.submission) : undefined,
      consentAlreadyCurrent =
        !command.disposedReviewIds?.length &&
        currentSubmissionDigest !== undefined &&
        snapshot.consents.some(
          (value) =>
            value.reviewId === command.reviewId &&
            value.executionId === command.executionId &&
            (value.submissionDigest === currentSubmissionDigest ||
              (value.submissionDigest === undefined &&
                Date.parse(value.consentedAt) >= Date.parse(current?.submittedAt ?? ""))),
        ),
      proposedDisposition: ReviewDispositionV1 | undefined =
        current?.submission && command.disposedReviewIds?.length
          ? {
              schema: "review-disposition/v1",
              dispositionId: `disposition-${command.consentId}`,
              taskId: command.taskId,
              executionId: command.executionId,
              iteration: current.iteration,
              submissionDigest: submissionDigest(current.submission),
              disposedReviewIds: command.disposedReviewIds,
              rationale: command.rationale ?? "",
              actor: command.actor,
              source: command.source,
              disposedAt: command.occurredAt,
            }
          : undefined,
      conflicts = current?.submission
        ? reviewConsentConflicts({
            selectedReview: recorded,
            allowSelectedChangesRequested: true,
            reviews: snapshot.reviews.filter(
              (value) => value.executionId === command.executionId && value.iteration === current.iteration,
            ),
            dispositions: [
              ...(snapshot.reviewDispositions ?? []),
              ...(proposedDisposition ? [proposedDisposition] : []),
            ],
            currentSubmissionDigest: currentSubmissionDigest!,
          })
        : [],
      currentChanges = new Set(
        snapshot.reviews
          .filter(
            (value) =>
              value.executionId === command.executionId &&
              value.iteration === current?.iteration &&
              value.verdict === "changes_requested" &&
              value.submissionDigest === currentSubmissionDigest,
          )
          .map((value) => value.reviewId),
      );
    if (
      command.disposedReviewIds?.length &&
      command.actor.principal.personId !== snapshot.task?.createdBy.principal.personId
    )
      issues.push(
        lifecycleContractIssue("invalid_proof", "review override consent requires the task owner's principal"),
      );
    if (
      snapshot.task?.status !== "in_review" ||
      current?.state !== "submitted" ||
      (recorded?.verdict !== "approved" &&
        !(recorded?.verdict === "changes_requested" && command.disposedReviewIds?.includes(recorded.reviewId))) ||
      recorded?.iteration !== current?.iteration ||
      consentAlreadyCurrent
    )
      issues.push(
        lifecycleContractIssue("invalid_transition", "consent must select an unconsented approved current Review"),
      );
    if (
      (command.disposedReviewIds !== undefined && command.disposedReviewIds.length === 0) ||
      (command.disposedReviewIds?.length && !isNonEmptyString(command.rationale))
    )
      issues.push(
        lifecycleContractIssue("invalid_proof", "review disposition requires named review ids and rationale"),
      );
    if (
      command.disposedReviewIds?.length &&
      (new Set(command.disposedReviewIds).size !== command.disposedReviewIds.length ||
        command.disposedReviewIds.some((reviewId) => !currentChanges.has(reviewId)))
    )
      issues.push(
        lifecycleContractIssue(
          "invalid_proof",
          "review disposition may name each current changes_requested review exactly once",
        ),
      );
    if (conflicts.length)
      issues.push(
        lifecycleContractIssue(
          "invalid_proof",
          `review consent conflicts: ${describeReviewConsentConflicts(conflicts)}; dispose the conflicting review(s) ` +
            `with ha task review-consent ${command.taskId} --execution-id ${command.executionId} ` +
            `--review-id ${command.reviewId} ${conflicts.map((value) => `--dispose ${value.reviewId}`).join(" ")} ` +
            "--rationale <why>",
        ),
      );
    if (
      !recorded ||
      command.reviewDigest !== reviewDigest(recorded) ||
      command.contentDigest !== recorded.contentDigest ||
      !proof.actorBinding ||
      !isSameExecution(command.actor, proof.actorBinding) ||
      !snapshot.task ||
      proof.capability !== "execution-consent@v1" ||
      !isNonEmptyString(proof.capabilityRef) ||
      !isNonEmptyString(command.consentId)
    )
      issues.push(
        lifecycleContractIssue("invalid_proof", "owner consent must bind the Review and reviewed content digests"),
      );
    return issues;
  },
  reduce: (snapshot, raw) => {
    const command = raw as RecordReviewConsentCommand,
      current = execution(snapshot, command.executionId) as ExecutionV1,
      recorded = snapshot.reviews.find((value) => value.reviewId === command.reviewId) as ReviewV1,
      value: ReviewConsentV1 = {
        schema: "review-consent/v1",
        consentId: command.consentId,
        taskId: command.taskId,
        executionId: command.executionId,
        reviewId: command.reviewId,
        reviewDigest: command.reviewDigest,
        contentDigest: command.contentDigest,
        submissionDigest: submissionDigest(current.submission as NonNullable<ExecutionV1["submission"]>),
        actor: command.actor,
        source: command.source,
        consentedAt: command.occurredAt,
      },
      disposition: ReviewDispositionV1 | undefined = command.disposedReviewIds?.length
        ? {
            schema: "review-disposition/v1",
            dispositionId: `disposition-${command.consentId}`,
            taskId: command.taskId,
            executionId: command.executionId,
            iteration: current.iteration,
            submissionDigest: submissionDigest(current.submission!),
            disposedReviewIds: [...command.disposedReviewIds],
            rationale: command.rationale!,
            actor: command.actor,
            source: command.source,
            disposedAt: command.occurredAt,
          }
        : undefined;
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        consents: [...snapshot.consents, value],
        ...(disposition ? { reviewDispositions: [...(snapshot.reviewDispositions ?? []), disposition] } : {}),
      },
      event: disposition
        ? envelope<ReviewConsentOverrideRecordedEvent>(command, "review_consent_overridden", {
            task: snapshot.task as TaskV2,
            execution: current,
            review: recorded,
            consent: value,
            disposition,
          })
        : envelope<ReviewConsentRecordedEvent>(command, "review_consent_recorded", {
            task: snapshot.task as TaskV2,
            execution: current,
            review: recorded,
            consent: value,
          }),
    };
  },
};

export function isReadyToComplete(snapshot: TaskLifecycleSnapshot): boolean {
  return closeoutReadiness(snapshot).readiness === "ready";
}
export const complete: Transition = {
  actionId: "complete",
  matches: (command) => command.type === "CompleteTask",
  validate: (snapshot, raw, rawProof) => {
    const command = raw as CompleteTaskCommand,
      proof = rawProof as Partial<CompleteTaskProof>,
      issues = revisionIssues(snapshot, command),
      task = snapshot.task,
      current = execution(snapshot, command.executionId),
      gatesValid = isValidCloseoutGateRecord(proof.closeoutGates),
      assessment = closeoutReadiness(snapshot, undefined, gatesValid ? proof.closeoutGates : undefined, proof.delivery),
      currentDigest = current?.submission ? submissionDigest(current.submission) : undefined,
      selectedConsent =
        current && [...snapshot.consents].reverse().find((value) => value.executionId === current.executionId),
      selectedReview = selectedConsent
        ? snapshot.reviews.find((value) => value.reviewId === selectedConsent.reviewId)
        : undefined,
      conflicts = currentDigest
        ? reviewConsentConflicts({
            selectedReview,
            allowSelectedChangesRequested: true,
            reviews: snapshot.reviews.filter(
              (value) => value.executionId === command.executionId && value.iteration === current?.iteration,
            ),
            dispositions: snapshot.reviewDispositions ?? [],
            currentSubmissionDigest: currentDigest,
          })
        : [];
    if (command.resolution) {
      if (
        !isNonEmptyString(command.resolution.resolvedByTaskId) ||
        !isNonEmptyString(command.resolution.rationale) ||
        !/^fact\/F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(command.resolution.factRef)
      )
        issues.push(
          lifecycleContractIssue("invalid_schema", "Sibling resolution requires source task, rationale, and Fact"),
        );
      if (
        !proof.siblingResolution?.sourceDone ||
        proof.siblingResolution.sourceTaskId !== command.resolution.resolvedByTaskId ||
        proof.siblingResolution.factRef !== command.resolution.factRef
      )
        issues.push(
          lifecycleContractIssue("invalid_transition", "Sibling task must be durably done before resolution"),
        );
      if (
        !task ||
        ["done", "cancelled"].includes(task.status) ||
        command.resolution.resolvedByTaskId === command.taskId
      )
        issues.push(
          lifecycleContractIssue(
            "invalid_transition",
            "Sibling resolution requires an open task and a different source task",
          ),
        );
      if (
        snapshot.lease ||
        proof.noActiveLease !== true ||
        proof.capability !== "task-complete@v1" ||
        !isNonEmptyString(proof.capabilityRef) ||
        !["owner", "commander"].includes(String(proof.actorRole))
      )
        issues.push(lifecycleContractIssue("invalid_proof", "completion authority and released lease are required"));
      return issues;
    }
    if (!gatesValid)
      issues.push(lifecycleContractIssue("invalid_proof", "CompleteTask requires the effective closeout gate set"));
    if (
      command.factRetirementAttestations !== undefined &&
      (!Array.isArray(command.factRetirementAttestations) ||
        command.factRetirementAttestations.length === 0 ||
        command.factRetirementAttestations.some((attestation) => !validFactStillHoldsAttestation(attestation)))
    )
      issues.push(lifecycleContractIssue("invalid_schema", "CompleteTask Fact retirement attestations are invalid"));
    if (
      !task ||
      !["submitted", "in_review"].includes(task.status) ||
      task.currentNode !== "review" ||
      current?.state !== "submitted" ||
      assessment.readiness !== "ready"
    )
      issues.push(
        lifecycleContractIssue(
          "invalid_transition",
          assessment.blocker === "lineage" && task
            ? `CompleteTask for a ${task.taskClass} task requires an active decision derives edge; ` +
                "run ha relation relate --source-ref decision/<decision-id>/<claim-id> --type derives " +
                `--target-ref task/${task.taskId} --rationale <why this decision authorises the task> --expected-version 0`
            : conflicts.length
              ? `CompleteTask review consent conflicts: ${describeReviewConsentConflicts(conflicts)}`
              : "CompleteTask requires a consent-selected approved Review",
        ),
      );
    if (
      snapshot.lease ||
      proof.noActiveLease !== true ||
      proof.capability !== "task-complete@v1" ||
      !isNonEmptyString(proof.capabilityRef) ||
      !["owner", "commander"].includes(String(proof.actorRole))
    )
      issues.push(lifecycleContractIssue("invalid_proof", "completion authority and released lease are required"));
    if (task && current) {
      const receipts = [...(proof.gateReceipts ?? [])].sort((left, right) => left.gateId.localeCompare(right.gateId)),
        canonical = [...canonicalGateReceipts(snapshot, current, proof.delivery)].sort((left, right) =>
          left.gateId.localeCompare(right.gateId),
        );
      if (stableStringify(canonical) !== stableStringify(receipts))
        issues.push(
          lifecycleContractIssue(
            "invalid_proof",
            "CompleteTask may reference only L2-verified gate witnesses for this execution cut",
          ),
        );
    }
    return issues;
  },
  reduce: (snapshot, raw, rawProof) => {
    const command = raw as CompleteTaskCommand,
      proof = rawProof as CompleteTaskProof,
      current = execution(snapshot, command.executionId) as ExecutionV1,
      nextExecution: ExecutionV1 = {
        ...current,
        state: "accepted",
        closedAt: command.occurredAt,
      },
      task: TaskV2 = {
        ...(snapshot.task as TaskV2),
        status: "done",
        pinned: false,
      };
    const siblingResolution = command.resolution
      ? {
          sourceTaskId: command.resolution.resolvedByTaskId,
          rationale: command.resolution.rationale,
          factRef: command.resolution.factRef,
        }
      : undefined;
    const payload: Omit<TaskCompletedEvent["payload"], "documentClaims"> = siblingResolution
      ? { task, siblingResolution }
      : {
          task,
          execution: nextExecution,
          closeoutGates: proof.closeoutGates,
          ...(command.factRetirementAttestations?.length
            ? { factRetirementAttestations: command.factRetirementAttestations }
            : {}),
        };
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        task,
        ...(siblingResolution
          ? { siblingResolution }
          : { executions: replaceExecution(snapshot.executions, nextExecution) }),
      },
      event: envelope<TaskCompletedEvent>(command, "task_completed", payload),
    };
  },
};
