// Positive-control fixture: daemon-owned definitions must fail the single-definition gate.
export function canStartExecution(): boolean {
  return true;
}

export function queryPayloadValidation(): readonly string[] {
  return [];
}

export const statusVocabularies = ["copied"] as const;

// Positive-control fixture: a second bilingual closeout judgment in the daemon must fail the gate.
export function missingChineseCloseoutSections(): readonly string[] {
  return ["摘要", "验证"];
}

// Positive-control fixture: a second aggregate authored-document readiness judgment must fail.
export function assessAuthoredDocumentReadiness(): { readonly state: string } {
  return { state: "ready" };
}

// Positive-control fixture: a second section-level authored-document readiness judgment must fail.
export function assessTransitionDocument(): { readonly ready: boolean } {
  return { ready: true };
}

export function forwardingIntentIssue(): string | null {
  return "duplicate";
}

export function copiedDecisionReviewerIndependence(
  decision: { amendments?: { actor: unknown }[] } | null,
  isIndependentFrom: (a: unknown, b: unknown) => boolean,
  reviewer: unknown,
): boolean {
  return Boolean(decision?.amendments?.some((amendment) => !isIndependentFrom(amendment.actor, reviewer)));
}

export function copiedHasCurrentApprovedReview(
  disposed: Set<string>,
  dispositions: { disposedReviewIds: string[] }[],
  reviews: { reviewId: string; verdict: string }[],
): boolean {
  const ids = dispositions.flatMap((d) => d.disposedReviewIds);
  void ids;
  return !reviews.some((review) => review.verdict === "changes_requested" && !disposed.has(review.reviewId));
}

export function copiedSubmittedCutOpen(task: { currentNode?: string }, current?: { state?: string }): boolean {
  return task.currentNode === "review" && current?.state === "submitted";
}

export function copiedCutReturningRework(command: { handoffId?: string; takeover?: boolean }): boolean {
  return command.handoffId === undefined && (command.takeover !== true || false);
}
