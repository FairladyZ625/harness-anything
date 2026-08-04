import type { CurrentSessionRef, ExecutionRecord } from "@harness-anything/kernel";
import {
  executionBoundConsentTranscriptCandidates,
  reviewCurrentConsentTranscriptCandidate,
  type ConsentTranscriptCandidate
} from "../consent-source-resolution.ts";

export function authorityConsentTranscriptCandidatesV2(
  execution: ExecutionRecord,
  currentSession: CurrentSessionRef | undefined,
  reviewedAt: string,
  authenticatedSessionId: string
): ReadonlyArray<ConsentTranscriptCandidate> {
  if (currentSession && currentSession.sessionId !== authenticatedSessionId) {
    throw new Error("authority compiler current session does not match the authenticated session axis");
  }
  return [
    ...(currentSession ? [reviewCurrentConsentTranscriptCandidate({
      execution,
      session: currentSession,
      reviewedAt
    })] : []),
    ...executionBoundConsentTranscriptCandidates(execution)
  ];
}
