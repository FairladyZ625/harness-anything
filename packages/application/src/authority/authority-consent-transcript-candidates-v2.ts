import type { CurrentSessionRef, ExecutionRecord } from "@harness-anything/kernel";
import {
  executionBoundConsentTranscriptCandidates,
  reviewCurrentConsentTranscriptCandidate,
  type ConsentTranscriptCandidate
} from "../consent-source-resolution.ts";

export class LegacyAuthorityReviewCurrentUnavailableV2 extends Error {}
export class AuthorityCompilerSessionContextMismatchV2 extends Error {}

export function authorityConsentTranscriptCandidatesV2(
  execution: ExecutionRecord,
  currentSession: CurrentSessionRef | undefined,
  reviewedAt: string,
  authenticatedSessionId: string,
  ttlMs: number,
  requiresReviewCurrent: boolean
): ReadonlyArray<ConsentTranscriptCandidate> {
  if (currentSession && currentSession.sessionId !== authenticatedSessionId) {
    throw new AuthorityCompilerSessionContextMismatchV2(
      "authority compiler current session does not match the authenticated session axis"
    );
  }
  if (!requiresReviewCurrent) return [];
  const executionBound = executionBoundConsentTranscriptCandidates(execution);
  if (!currentSession && requiresReviewCurrent
    && !executionBound.some((candidate) => candidate.session.sessionId === authenticatedSessionId)) {
    throw new LegacyAuthorityReviewCurrentUnavailableV2(
      "legacy authority token cannot verify review-current transcript consent; choose asserted consent or standing-policy"
    );
  }
  const prioritizedExecutionBound = currentSession ? executionBound : [
    ...executionBound.filter((candidate) => candidate.session.sessionId === authenticatedSessionId),
    ...executionBound.filter((candidate) => candidate.session.sessionId !== authenticatedSessionId)
  ];
  return [
    ...(currentSession ? [reviewCurrentConsentTranscriptCandidate({
      execution,
      session: currentSession,
      reviewedAt,
      ttlMs
    })] : []),
    ...prioritizedExecutionBound
  ];
}
