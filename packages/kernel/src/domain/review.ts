import type { ExecutionActor } from "./execution.ts";

export const reviewVerdicts = ["approved", "changes_requested", "dismissed"] as const;
export type ReviewVerdict = (typeof reviewVerdicts)[number];

export interface ReviewRecord {
  readonly schema: "review/v2";
  readonly review_id: string;
  readonly task_ref: string;
  readonly execution_ref: string;
  readonly reviewer_actor: ExecutionActor;
  readonly reviewer_session_ref: string;
  readonly findings: string;
  readonly evidence_checked: ReadonlyArray<string>;
  readonly rationale: string;
  readonly verdict: ReviewVerdict;
  readonly archive_warnings_acknowledged: boolean;
  readonly reviewed_at: string;
}
