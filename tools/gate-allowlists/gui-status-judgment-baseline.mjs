// Stable source-attached identities for frozen GUI status-judgment sites.
//
// Identity is the @gate-identity marker attached to the governed syntax node.
// The marker moves with its subject across formatting, reorder, split, and rename.
// Baseline membership still rejects unmarked additions, unknown ids, duplicate ids,
// and stale identities.
// prettier-ignore
export const guiStatusJudgmentBaseline = Object.freeze([
  { key: "gui-status-005", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["covered"] }, // point-comparison: covered @ FactInspector.coveredDecisionIds
  { key: "gui-status-016", classification: "domain-judgment", kind: "group", shape: "proper-subset", words: ["active","done","in_review","planned"] }, // proper-subset: active, done, in_review, planned @ STEP_FLOW
  { key: "gui-status-017", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["blocked"] }, // point-comparison: blocked @ PhaseSteps.note
  { key: "gui-status-018", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["cancelled"] }, // point-comparison: cancelled @ PhaseSteps.note
  { key: "gui-status-019", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ decisionHasReachableEvidence
  { key: "gui-status-020", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["proposed"] }, // point-comparison: proposed @ useDecisionActions.propose.finish.visible
  { key: "gui-status-030", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["covered"] }, // point-comparison: covered @ computeFactTriageSignals.citingDecisionIdSet
  { key: "gui-status-031", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["uncovered"] }, // point-comparison: uncovered @ coverageSignal.uncovered
  { key: "gui-status-032", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ activeIncomingRelations
  { key: "gui-status-034", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["cancelled"] }, // point-comparison: cancelled @ matchesTask
  { key: "gui-status-035", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["unknown"] }, // point-comparison: unknown @ matchesTask
  { key: "gui-status-037", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ spawningDecisionOf.decisionIds
  { key: "gui-status-038", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ derivedTasks.taskIds
  { key: "gui-status-055", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["superseded_fact"] }, // point-comparison: superseded_fact @ buildTriadicRendererData.facts.invalidated
  { key: "gui-status-056", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ adaptRelationRows
  { key: "gui-status-057", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ adaptDecisionRows
  { key: "gui-status-062", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["proposed"] }, // point-comparison: proposed @ DecisionPoolView
  { key: "gui-status-063", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["proposed"] }, // point-comparison: proposed @ DecisionsView.queue.proposed
  { key: "gui-status-068", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ activeProducesFactRefs
  { key: "gui-status-069", classification: "domain-judgment", kind: "group", shape: "proper-subset", words: ["in_effect","proposed"] }, // proper-subset: in_effect, proposed @ DEBT_SCOPE_DECISION_STATES
]);
