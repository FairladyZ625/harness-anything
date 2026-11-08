// Positive control (dec_6B912A63D279A922FA1288536D CH2): an edge protocol invents a candidate word
// that the status register does not carry. The status-vocabulary gate must refuse it.
export type EdgeDocCandidateState = "eligible" | "candidate_v2";

export interface EdgeDocumentReadinessRow {
  readonly path: string;
  readonly readinessState: "ready" | "awaiting_center";
}
