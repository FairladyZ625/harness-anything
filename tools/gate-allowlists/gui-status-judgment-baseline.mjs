// Stable source-attached identities for frozen GUI status-judgment sites.
//
// Identity is the @gate-identity marker attached to the governed syntax node.
// The marker moves with its subject across formatting, reorder, split, and rename.
// Baseline membership still rejects unmarked additions, unknown ids, duplicate ids,
// and stale identities.
// prettier-ignore
export const guiStatusJudgmentBaseline = Object.freeze([
  { key: "gui-status-019", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ decisionHasReachableEvidence
  { key: "gui-status-032", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ activeIncomingRelations
  { key: "gui-status-034", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["cancelled"] }, // point-comparison: cancelled @ matchesTask
  { key: "gui-status-035", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["unknown"] }, // point-comparison: unknown @ matchesTask
  { key: "gui-status-037", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ spawningDecisionOf.decisionIds
  { key: "gui-status-038", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ derivedTasks.taskIds
  { key: "gui-status-055", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["superseded_fact"] }, // point-comparison: superseded_fact @ buildTriadicRendererData.facts.invalidated
  { key: "gui-status-056", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ adaptRelationRows
  { key: "gui-status-057", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ adaptDecisionRows
  { key: "gui-status-068", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ activeProducesFactRefs
]);
