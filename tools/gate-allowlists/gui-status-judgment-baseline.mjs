// Stable source-attached identities for frozen GUI status-judgment sites.
//
// Identity is the @gate-identity marker attached to the governed syntax node.
// The marker moves with its subject across formatting, reorder, split, and rename.
// Baseline membership still rejects unmarked additions, unknown ids, duplicate ids,
// and stale identities.
// prettier-ignore
export const guiStatusJudgmentBaseline = Object.freeze([
  { key: "gui-status-001", classification: "domain-judgment", kind: "group", shape: "proper-subset", words: ["blocked","in_review","open","terminal","unknown"] }, // proper-subset: blocked, in_review, open, terminal, unknown @ boardOrder
  { key: "gui-status-002", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["ready"] }, // point-comparison: ready @ buildGuiViewModel.reviewQueue
  { key: "gui-status-003", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ buildGuiViewModelFromTaskProjection
  { key: "gui-status-004", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ readGuiTaskListResult
  { key: "gui-status-005", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["covered"] }, // point-comparison: covered @ FactInspector.coveredDecisionIds
  { key: "gui-status-006", classification: "domain-judgment", kind: "group", shape: "proper-subset", words: ["unknown"] }, // proper-subset: unknown @ FULFILLMENT_ORDER
  { key: "gui-status-007", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["unknown"] }, // point-comparison: unknown @ TaskStream
  { key: "gui-status-008", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ TaskControlPanel.reason
  { key: "gui-status-009", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["in_review"] }, // point-comparison: in_review @ TaskControlPanel.reason
  { key: "gui-status-010", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["done"] }, // point-comparison: done @ TaskControlPanel.reason
  { key: "gui-status-011", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["planned"] }, // point-comparison: planned @ TaskControlPanel.reason
  { key: "gui-status-012", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["blocked"] }, // point-comparison: blocked @ TaskControlPanel.reason
  { key: "gui-status-013", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ TaskControlPanel.reason
  { key: "gui-status-014", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ TaskControlPanel
  { key: "gui-status-015", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ TaskControlPanel
  { key: "gui-status-016", classification: "domain-judgment", kind: "group", shape: "proper-subset", words: ["active","done","in_review","planned"] }, // proper-subset: active, done, in_review, planned @ STEP_FLOW
  { key: "gui-status-017", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["blocked"] }, // point-comparison: blocked @ PhaseSteps.note
  { key: "gui-status-018", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["cancelled"] }, // point-comparison: cancelled @ PhaseSteps.note
  { key: "gui-status-019", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ decisionHasReachableEvidence
  { key: "gui-status-020", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["proposed"] }, // point-comparison: proposed @ useDecisionActions.propose.finish.visible
  { key: "gui-status-021", classification: "domain-judgment", kind: "group", shape: "proper-subset", words: ["unknown"] }, // proper-subset: unknown @ PLACEHOLDER_MODULES
  { key: "gui-status-022", classification: "domain-judgment", kind: "group", shape: "proper-subset", words: ["superseded"] }, // proper-subset: superseded @ partitionFactsByAnomaly.order
  { key: "gui-status-023", classification: "domain-judgment", kind: "switch", shape: "point-comparison", words: ["active","blocked","done","in_review","planned"] }, // point-comparison: active, blocked, done, in_review, planned @ deriveZoneProgress
  { key: "gui-status-024", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["done"] }, // point-comparison: done @ statusBucket
  { key: "gui-status-025", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ statusBucket
  { key: "gui-status-026", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["blocked"] }, // point-comparison: blocked @ statusBucket
  { key: "gui-status-027", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["in_review"] }, // point-comparison: in_review @ statusBucket
  { key: "gui-status-028", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["planned"] }, // point-comparison: planned @ statusBucket
  { key: "gui-status-029", classification: "domain-judgment", kind: "switch", shape: "point-comparison", words: ["active","blocked","done","in_review","planned"] }, // point-comparison: active, blocked, done, in_review, planned @ statusWeight
  { key: "gui-status-030", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["covered"] }, // point-comparison: covered @ computeFactTriageSignals.citingDecisionIdSet
  { key: "gui-status-031", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["uncovered"] }, // point-comparison: uncovered @ coverageSignal.uncovered
  { key: "gui-status-032", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ activeIncomingRelations
  { key: "gui-status-033", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ matchesTask
  { key: "gui-status-034", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["cancelled"] }, // point-comparison: cancelled @ matchesTask
  { key: "gui-status-035", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["unknown"] }, // point-comparison: unknown @ matchesTask
  { key: "gui-status-036", classification: "domain-judgment", kind: "membership", shape: "point-comparison", words: ["unknown"] }, // point-comparison: unknown @ matchesTask
  { key: "gui-status-037", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ spawningDecisionOf.decisionIds
  { key: "gui-status-038", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ derivedTasks.taskIds
  { key: "gui-status-039", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["done"] }, // point-comparison: done @ isTerminal
  { key: "gui-status-040", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["cancelled"] }, // point-comparison: cancelled @ isTerminal
  { key: "gui-status-042", classification: "domain-judgment", kind: "group", shape: "proper-subset", words: ["failed"] }, // proper-subset: failed @ settleDaemonControl
  { key: "gui-status-043", classification: "domain-judgment", kind: "group", shape: "proper-subset", words: ["failed"] }, // proper-subset: failed @ useDaemonControl.request.settled
  { key: "gui-status-044", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ isTaskStartable
  { key: "gui-status-045", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["planned"] }, // point-comparison: planned @ isTaskStartable
  { key: "gui-status-046", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["clear"] }, // point-comparison: clear @ isTaskStartable
  { key: "gui-status-047", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ useTaskActions.startTask
  { key: "gui-status-048", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ useTaskActions.appendProgress
  { key: "gui-status-049", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["in_review"] }, // point-comparison: in_review @ useTaskActions.submitTask
  { key: "gui-status-050", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["unknown"] }, // point-comparison: unknown @ adaptProjectionRow.gates.ok
  { key: "gui-status-051", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["passed"] }, // point-comparison: passed @ adaptProjectionRow.gates.ok
  { key: "gui-status-052", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["blocked"] }, // point-comparison: blocked @ adaptProjectionRow.blockingLabel
  { key: "gui-status-053", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["unknown"] }, // point-comparison: unknown @ adaptProjectionRow.blockingLabel
  { key: "gui-status-054", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ placementFor.derives
  { key: "gui-status-055", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["superseded_fact"] }, // point-comparison: superseded_fact @ buildTriadicRendererData.facts.invalidated
  { key: "gui-status-056", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ adaptRelationRows
  { key: "gui-status-057", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ adaptDecisionRows
  { key: "gui-status-058", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ Card.archived
  { key: "gui-status-059", classification: "domain-judgment", kind: "group", shape: "proper-subset", words: ["unknown"] }, // proper-subset: unknown @ DecisionPoolView
  { key: "gui-status-060", classification: "domain-judgment", kind: "group", shape: "proper-subset", words: ["unknown"] }, // proper-subset: unknown @ DecisionPoolView
  { key: "gui-status-061", classification: "domain-judgment", kind: "group", shape: "proper-subset", words: ["unknown"] }, // proper-subset: unknown @ DecisionPoolView
  { key: "gui-status-062", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["proposed"] }, // point-comparison: proposed @ DecisionPoolView
  { key: "gui-status-063", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["proposed"] }, // point-comparison: proposed @ DecisionsView.queue.proposed
  { key: "gui-status-064", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ AuditRow.archived
  { key: "gui-status-065", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["missing"] }, // point-comparison: missing @ ListView.riskCount
  { key: "gui-status-066", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["failed"] }, // point-comparison: failed @ ListView.riskCount
  { key: "gui-status-067", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ LaneCard.archived
  { key: "gui-status-068", classification: "domain-judgment", kind: "comparison", shape: "point-comparison", words: ["active"] }, // point-comparison: active @ activeProducesFactRefs
]);
