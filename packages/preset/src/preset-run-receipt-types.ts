import type { AuthorizationDecision } from "../../kernel/src/index.ts";

export type PresetRunPhaseV1 =
  | "admitted"
  | "spawned"
  | "running"
  | "publishing"
  | "applied"
  | "op_rejected"
  | "failed"
  | "outcome_unknown";
export type PresetRunOutcomeV1 = "started" | "running" | "applied" | "op_rejected" | "failed" | "outcome_unknown";

export interface PresetRunReceiptV1 {
  readonly schema: "preset-run-receipt/v1";
  readonly runId: string;
  readonly outcome: PresetRunOutcomeV1;
  readonly phase: PresetRunPhaseV1;
  readonly phases: readonly PresetRunPhaseV1[];
  readonly snapshotDigest?: `sha256:${string}`;
  readonly resultDigest?: `sha256:${string}`;
  readonly code?: string;
  readonly nextAction?: string;
  readonly rejectionExplanation?: string;
  readonly authorizationDecision?: AuthorizationDecision;
}
