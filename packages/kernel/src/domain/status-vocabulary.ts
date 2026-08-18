/**
 * Cross-entity status-word register (blueprint 铁律四 · slice 5).
 *
 * Authority: every status word this repo puts on a domain entity is declared here
 * once, with the entity it belongs to and the one sentence it means there. A word
 * that means different things on different entities is marked `divergent` and must
 * carry a resolution; renames of stored or public words are CH2 proposals, never
 * executed in this slice. The vocabulary ratchet gate (tools/check-status-vocabulary.mjs)
 * binds this register to the real declarations: kernel vocabularies cannot drift
 * from it and a new status word cannot appear unregistered.
 *
 * Scope: domain entity vocabularies (kernel domain declarations plus the GUI model
 * mirrors). Adapter plumbing (`ready | pending`, `loading | error`, `attached | gap`)
 * is I/O state, not entity status, and stays out.
 *
 * Zero dependencies by design: this module must stay bare-importable.
 */

export type StatusEntity =
  | "Task"
  | "Decision"
  | "Execution"
  | "Lease"
  | "RelationEdge"
  | "Package"
  | "FactRecord"
  | "Review"
  | "RuntimeSession"
  | "WriteReceipt"
  | "Recovery"
  | "PresetRun"
  | "TaskCloseout"
  | "VerticalScript"
  | "LegacyFact"
  | "GuiAdapter"
  | "DaemonWire";

export type StatusDivergence = "entity-scoped" | "divergent";

export interface StatusWordRegistration {
  /** The literal status word, e.g. "active". */
  readonly word: string;
  readonly entity: StatusEntity;
  /** The entity field the word is a value of, e.g. "status" / "state" / "phase". */
  readonly field: string;
  /** One sentence: what the word means on this entity. */
  readonly meaning: string;
  /**
   * "divergent": the same word on other entities means a materially different
   * concept (rename candidate). "entity-scoped": same word elsewhere is the same
   * concept, an operational cousin, or unrelated-but-registered.
   */
  readonly divergence: StatusDivergence;
  /** Required for divergent words: why the collision stands and where a rename would go. */
  readonly resolution?: string;
}

export interface StatusVocabulary {
  /** Vocabulary id, e.g. "task.status". */
  readonly id: string;
  readonly entity: StatusEntity;
  readonly field: string;
  /** Repo-relative module that declares the vocabulary. */
  readonly module: string;
  /**
   * Declaration anchor: an exported const/type name, or "#fieldName" for an inline
   * `readonly` field union. Anchors with a runtime export are bijection-checked by
   * the gate; text anchors are text-checked.
   */
  readonly anchor: string;
  readonly words: readonly string[];
  /** Declared words are a subset of this vocabulary (derived/coarse/validator sets). */
  readonly subsetOf?: string;
  /** GUI mirror: words must equal the mirrored vocabulary's words plus `plusWords`. */
  readonly mirrorOf?: string;
  readonly plusWords?: readonly string[];
  readonly note?: string;
}

export const statusWordRegister: readonly StatusWordRegistration[] = [
  // ---- Slice-3 domain judgments (registered here when the two slices met on main) ----
  { word: "blocked", entity: "Task", field: "blocking state", meaning: "blockingOf verdict: an active depends-on edge with a non-done target blocks this task.", divergence: "divergent", resolution: "Shares the word with task.status blocked (a lifecycle state); same task can be status=active yet blocking state=blocked. Registered as distinct meanings; renaming either is stored-data/API surface — CH2 proposal only." },
  { word: "clear", entity: "Task", field: "blocking state", meaning: "blockingOf verdict: no active blocker.", divergence: "entity-scoped" },
  { word: "unknown", entity: "Task", field: "blocking state", meaning: "blockingOf could not answer: degraded projection or malformed edge.", divergence: "entity-scoped" },
  { word: "ready", entity: "Task", field: "blocking projection availability", meaning: "Relation projection is loaded; blockingOf verdicts are meaningful.", divergence: "entity-scoped" },
  { word: "loading", entity: "Task", field: "blocking projection availability", meaning: "Relation projection still loading; every blocking verdict is unknown.", divergence: "entity-scoped" },
  { word: "error", entity: "Task", field: "blocking projection availability", meaning: "Relation projection failed; every blocking verdict is unknown.", divergence: "entity-scoped" },
  { word: "covered", entity: "Decision", field: "claim coverage status", meaning: "coverageOf verdict: the claim's declared fulfillment mode is satisfied by live evidence.", divergence: "entity-scoped" },
  { word: "uncovered", entity: "Decision", field: "claim coverage status", meaning: "coverageOf verdict: no satisfying evidence, or fulfillment undeclared (null).", divergence: "entity-scoped" },
  { word: "live", entity: "FactRecord", field: "liveness", meaning: "factLiveness verdict: no active supersedes-fact edge targets this fact.", divergence: "entity-scoped" },
  { word: "retired", entity: "FactRecord", field: "liveness", meaning: "factLiveness verdict: an active supersedes-fact edge targets this fact.", divergence: "divergent", resolution: "Same words and meanings as FactRecord.state (authored rows); fact.liveness is the computed single derivation. One meaning, two fields — unify when the authored row field is regenerated from the domain function." },
  { word: "passed", entity: "TaskCloseout", field: "gate status", meaning: "The matching completion-gate witness on the current cut has result pass.", divergence: "entity-scoped" },
  { word: "failed", entity: "TaskCloseout", field: "gate status", meaning: "A matching witness exists on the current cut but its result is not pass.", divergence: "entity-scoped" },
  { word: "missing", entity: "TaskCloseout", field: "gate status", meaning: "No witness matches the current execution cut.", divergence: "entity-scoped" },
  { word: "unknown", entity: "TaskCloseout", field: "gate status", meaning: "Witness availability could not be read.", divergence: "entity-scoped" },
  // ---- Task.status (execution coordination; the WIP machine) ----
  { word: "planned", entity: "Task", field: "status", meaning: "Task is committed but no execution has opened it yet.", divergence: "entity-scoped" },
  { word: "active", entity: "Task", field: "status", meaning: "Task is in an open executing state and occupies a WIP slot.", divergence: "divergent", resolution: "One of six unrelated `active` concepts; rename is stored data (task snapshots and events), so this slice registers the meaning instead — CH2 proposal only." },
  { word: "blocked", entity: "Task", field: "status", meaning: "Task is held by an external condition; still open, still occupies WIP.", divergence: "entity-scoped" },
  { word: "in_review", entity: "Task", field: "status", meaning: "Task is in the review node; review artifacts are required.", divergence: "entity-scoped" },
  { word: "done", entity: "Task", field: "status", meaning: "Task reached its delivery terminal state.", divergence: "entity-scoped" },
  { word: "cancelled", entity: "Task", field: "status", meaning: "Task was abandoned; terminal except the compensating reinstate rollback to the recorded pre-cancel status.", divergence: "entity-scoped" },
  { word: "open", entity: "Task", field: "coarse class", meaning: "Coarse class of every non-terminal task status.", divergence: "entity-scoped" },
  { word: "terminal", entity: "Task", field: "coarse class", meaning: "Coarse class of done/cancelled; no forward transitions (cancelled keeps only the compensating reinstate exit).", divergence: "entity-scoped" },

  // ---- Decision.state (adjudication outcomes; persisted policy) ----
  { word: "proposed", entity: "Decision", field: "state", meaning: "Decision awaits judgment.", divergence: "entity-scoped" },
  { word: "active", entity: "Decision", field: "state", meaning: "Decision was accepted and its policy is in effect (accept writes active; there is no separate accepted state).", divergence: "divergent", resolution: "Diverges from Task/Execution/Lease/Relation/Package `active`; stored in decision documents and events, so registration only — CH2 proposal (e.g. in_effect) in slice report." },
  { word: "rejected", entity: "Decision", field: "state", meaning: "Judgment refused the decision; a persistent policy state that feeds later adjudication.", divergence: "divergent", resolution: "Preset-run and write-receipt `rejected` are one-shot operation results; the decision word is stored policy. Receipt/preset renames are public surfaces — CH2 proposal only." },
  { word: "deferred", entity: "Decision", field: "state", meaning: "Judgment postponed; a persistent policy state.", divergence: "entity-scoped" },
  { word: "superseded", entity: "Decision", field: "state", meaning: "A later decision replaced this one (ADR-0020 D1: consumers must preserve this state, never fold it back into proposed).", divergence: "entity-scoped" },
  { word: "retired", entity: "Decision", field: "state", meaning: "A human ended the decision's standing deliberately.", divergence: "divergent", resolution: "Edge-retired is bookkeeping and fact-retired is derivation; decision-retired is a chosen outcome stored in the ledger (34 live rows at scout time) — CH2 proposal only." },
  { word: "active", entity: "Decision", field: "judgment targetState", meaning: "Judgment consent target when the action is accept.", divergence: "entity-scoped" },
  { word: "rejected", entity: "Decision", field: "judgment targetState", meaning: "Judgment consent target when the action is reject.", divergence: "entity-scoped" },
  { word: "deferred", entity: "Decision", field: "judgment targetState", meaning: "Judgment consent target when the action is defer.", divergence: "entity-scoped" },

  // ---- Execution.state (one execution of a task) ----
  { word: "active", entity: "Execution", field: "state", meaning: "Execution currently holds the work.", divergence: "divergent", resolution: "Coordination occupancy, not policy effect; stored in execution projections — CH2 proposal only." },
  { word: "submitted", entity: "Execution", field: "state", meaning: "Execution submitted its completion claim for review.", divergence: "entity-scoped" },
  { word: "accepted", entity: "Execution", field: "state", meaning: "Execution's submission was accepted.", divergence: "entity-scoped" },
  { word: "changes_requested", entity: "Execution", field: "state", meaning: "Review sent the execution back for rework.", divergence: "entity-scoped" },
  { word: "abandoned", entity: "Execution", field: "state", meaning: "Archived (v0) execution was abandoned before closing.", divergence: "entity-scoped" },

  // ---- Lease.phase (the current claim on a task) ----
  { word: "reserving", entity: "Lease", field: "phase", meaning: "Lease write is reserved but not yet activated.", divergence: "entity-scoped" },
  { word: "active", entity: "Lease", field: "phase", meaning: "The claim is currently held by its execution.", divergence: "divergent", resolution: "Blueprint proposes Lease.active → held; the word is stored in lease events (`phase`), so it is a data migration — CH2 proposal only, not executed." },
  { word: "orphaned", entity: "Lease", field: "phase", meaning: "Holder is unreachable; the lease awaits reclaim.", divergence: "entity-scoped" },
  { word: "released", entity: "Lease", field: "phase", meaning: "Holder handed the lease back; reclaimable.", divergence: "entity-scoped" },

  // ---- RelationEdge.state (bookkeeping of an edge) ----
  { word: "active", entity: "RelationEdge", field: "state", meaning: "Edge is load-bearing (not retired, not deleted).", divergence: "divergent", resolution: "Bookkeeping liveness, unrelated to the five other `active` concepts; stored in relation records — CH2 proposal only." },
  { word: "retired", entity: "RelationEdge", field: "state", meaning: "Edge was retired in place; kept as audit history.", divergence: "divergent", resolution: "Bookkeeping retirement differs from decision/fact retirement; stored in relation records — CH2 proposal only." },
  { word: "deleted", entity: "RelationEdge", field: "state", meaning: "Edge record removed from the live document.", divergence: "entity-scoped" },

  // ---- Package.disposition (task package lifecycle) ----
  { word: "active", entity: "Package", field: "disposition", meaning: "Package is in normal use: not archived, not tombstoned.", divergence: "divergent", resolution: "Storage liveness of a directory, not coordination/policy; stored in placement records — CH2 proposal only." },
  { word: "archived", entity: "Package", field: "disposition", meaning: "Package moved out of active use, kept readable.", divergence: "entity-scoped" },
  { word: "tombstoned", entity: "Package", field: "disposition", meaning: "Package deleted with a tombstone marker.", divergence: "entity-scoped" },

  // ---- FactRecord.state (per-fact row in facts documents and projections) ----
  { word: "live", entity: "FactRecord", field: "state", meaning: "Fact has not been superseded; the record is standing.", divergence: "divergent", resolution: "Blueprint proposes Fact.live → standing; the word is stored in authored facts documents (`State: live` rows), so it is a data migration — CH2 proposal only, not executed." },
  { word: "retired", entity: "FactRecord", field: "state", meaning: "Fact is the target of an active supersedes-fact edge.", divergence: "divergent", resolution: "Derived-then-stored (facts documents write `State: retired`); differs from decision-retired and edge-retired — CH2 proposal only." },

  // ---- Review.verdict ----
  { word: "approved", entity: "Review", field: "verdict", meaning: "Review approved the submission cut.", divergence: "entity-scoped" },
  { word: "changes_requested", entity: "Review", field: "verdict", meaning: "Review requested rework; same concept the Execution state encodes.", divergence: "entity-scoped" },
  { word: "dismissed", entity: "Review", field: "verdict", meaning: "Review dismissed the submission as not reviewable.", divergence: "entity-scoped" },

  // ---- RuntimeSession.liveness / outcome ----
  { word: "live", entity: "RuntimeSession", field: "liveness", meaning: "Session heartbeat is current.", divergence: "divergent", resolution: "Heartbeat liveness, unrelated to FactRecord.live; stored in runtime events — CH2 proposal only." },
  { word: "stale", entity: "RuntimeSession", field: "liveness", meaning: "Heartbeat is late but the session has not exited.", divergence: "entity-scoped" },
  { word: "unknown", entity: "RuntimeSession", field: "liveness", meaning: "Heartbeat could not be observed.", divergence: "entity-scoped" },
  { word: "exited", entity: "RuntimeSession", field: "liveness", meaning: "Session process ended; terminal.", divergence: "entity-scoped" },
  { word: "succeeded", entity: "RuntimeSession", field: "outcome", meaning: "Session outcome observed as success.", divergence: "entity-scoped" },
  { word: "failed", entity: "RuntimeSession", field: "outcome", meaning: "Session outcome observed as failure.", divergence: "entity-scoped" },
  { word: "unknown", entity: "RuntimeSession", field: "outcome", meaning: "Session outcome was never observed.", divergence: "entity-scoped" },

  // ---- WriteReceipt.outcome (one write request) ----
  { word: "applied", entity: "WriteReceipt", field: "outcome", meaning: "Write committed at the canonical cut.", divergence: "entity-scoped" },
  { word: "pending", entity: "WriteReceipt", field: "outcome", meaning: "Write not yet settled at the canonical cut.", divergence: "entity-scoped" },
  { word: "indeterminate", entity: "WriteReceipt", field: "outcome", meaning: "Publication outcome could not be determined; query the receipt before retrying.", divergence: "entity-scoped" },
  { word: "rejected", entity: "WriteReceipt", field: "outcome", meaning: "Write was refused; a one-shot operation result.", divergence: "divergent", resolution: "Operation result, not a persisted policy state like Decision.rejected; receipt outcomes are a public wire surface — CH2 proposal only." },

  // ---- Recovery.state (write-chain recovery batches; runtime-only) ----
  { word: "queued", entity: "Recovery", field: "state", meaning: "Recovery items still queued behind the cursor.", divergence: "entity-scoped" },
  { word: "running", entity: "Recovery", field: "state", meaning: "Recovery batch is executing.", divergence: "entity-scoped" },
  { word: "exhausted", entity: "Recovery", field: "state", meaning: "Recovery batch exhausted its current budget with items remaining.", divergence: "entity-scoped" },
  { word: "failed", entity: "Recovery", field: "state", meaning: "Recovery exhausted its retries.", divergence: "entity-scoped" },
  { word: "drained", entity: "Recovery", field: "state", meaning: "Recovery batch drained its items.", divergence: "entity-scoped" },

  // ---- PresetRun outcome/phase (documented; declared in packages/preset) ----
  { word: "started", entity: "PresetRun", field: "outcome", meaning: "Preset run was launched.", divergence: "entity-scoped" },
  { word: "running", entity: "PresetRun", field: "outcome", meaning: "Preset run is in progress.", divergence: "entity-scoped" },
  { word: "applied", entity: "PresetRun", field: "outcome", meaning: "Preset run applied its outputs.", divergence: "entity-scoped" },
  { word: "rejected", entity: "PresetRun", field: "outcome", meaning: "Preset run was refused; a one-shot operation result.", divergence: "divergent", resolution: "Same operation-result family as WriteReceipt.rejected; preset receipts are a public surface — CH2 proposal only." },
  { word: "failed", entity: "PresetRun", field: "outcome", meaning: "Preset run failed.", divergence: "entity-scoped" },
  { word: "outcome_unknown", entity: "PresetRun", field: "outcome", meaning: "Preset run result could not be observed.", divergence: "entity-scoped" },
  { word: "admitted", entity: "PresetRun", field: "phase", meaning: "Run passed admission checks.", divergence: "entity-scoped" },
  { word: "spawned", entity: "PresetRun", field: "phase", meaning: "Run process spawned.", divergence: "entity-scoped" },
  { word: "publishing", entity: "PresetRun", field: "phase", meaning: "Run is publishing outputs.", divergence: "entity-scoped" },

  // ---- TaskCloseout.readiness (closeout judgment result) ----
  { word: "not_required", entity: "TaskCloseout", field: "readiness", meaning: "Closeout gate does not apply to this task.", divergence: "entity-scoped" },
  { word: "missing", entity: "TaskCloseout", field: "readiness", meaning: "Required closeout material is absent.", divergence: "entity-scoped" },
  { word: "incomplete", entity: "TaskCloseout", field: "readiness", meaning: "Closeout material exists but is not complete.", divergence: "entity-scoped" },
  { word: "ready", entity: "TaskCloseout", field: "readiness", meaning: "Closeout material is ready for the gate.", divergence: "entity-scoped" },
  { word: "passed", entity: "TaskCloseout", field: "readiness", meaning: "Completion gate witness passed.", divergence: "entity-scoped" },
  { word: "failed", entity: "TaskCloseout", field: "readiness", meaning: "Completion gate witness failed.", divergence: "entity-scoped" },

  // ---- Task.sessionBinding disposition (witness availability) ----
  { word: "complete", entity: "Task", field: "sessionBinding disposition", meaning: "All session bindings for the iteration are present.", divergence: "entity-scoped" },
  { word: "partial", entity: "Task", field: "sessionBinding disposition", meaning: "Some session bindings are missing.", divergence: "entity-scoped" },
  { word: "unavailable", entity: "Task", field: "sessionBinding disposition", meaning: "Session bindings cannot be determined.", divergence: "entity-scoped" },

  // ---- VerticalScript.disposition ----
  { word: "create", entity: "VerticalScript", field: "disposition", meaning: "Vertical script action creates the target file.", divergence: "entity-scoped" },
  { word: "replace", entity: "VerticalScript", field: "disposition", meaning: "Vertical script action replaces the target file.", divergence: "entity-scoped" },

  // ---- Witness/checker literals and legacy markers ----
  { word: "pass", entity: "Task", field: "gate witness result", meaning: "The only value a completion-gate witness may carry: the checker passed.", divergence: "entity-scoped" },
  { word: "migrated", entity: "LegacyFact", field: "migration marker", meaning: "Legacy fact row carries a migration note and is not native event truth.", divergence: "entity-scoped" },

  // ---- GuiAdapter (renderer mirrors; unknown is the house convention) ----
  { word: "unknown", entity: "GuiAdapter", field: "adapter fallback", meaning: "The backend value was not in the registered vocabulary; the GUI shows unknown as unknown (SnapshotStatus precedent) and never folds it into a plausible neighbour.", divergence: "entity-scoped" },
  { word: "blocked", entity: "GuiAdapter", field: "blocking", meaning: "An active blocking relation blocks the task.", divergence: "entity-scoped" },
  { word: "clear", entity: "GuiAdapter", field: "blocking", meaning: "No active blocking relation.", divergence: "entity-scoped" },
  { word: "attached", entity: "GuiAdapter", field: "terminal stream", meaning: "Terminal stream is attached without a gap.", divergence: "entity-scoped" },
  { word: "gap", entity: "GuiAdapter", field: "terminal stream", meaning: "Terminal stream has an unrecoverable gap.", divergence: "entity-scoped" }
];

export const statusVocabularies: readonly StatusVocabulary[] = [
  { id: "task.status", entity: "Task", field: "status", module: "packages/kernel/src/domain/lifecycle-status.ts", anchor: "domainStatuses", words: ["planned", "active", "blocked", "in_review", "done", "cancelled"] },
  { id: "task.status.open", entity: "Task", field: "status", module: "packages/kernel/src/domain/lifecycle-status.ts", anchor: "openDomainStatuses", words: ["planned", "active", "blocked", "in_review"], subsetOf: "task.status", note: "Coarse open class of task statuses." },
  { id: "task.status.terminal", entity: "Task", field: "status", module: "packages/kernel/src/domain/lifecycle-status.ts", anchor: "terminalDomainStatuses", words: ["done", "cancelled"], subsetOf: "task.status", note: "Coarse terminal class of task statuses." },
  { id: "task.status.review-artifacts", entity: "Task", field: "status", module: "packages/kernel/src/domain/lifecycle-status.ts", anchor: "reviewArtifactStatuses", words: ["in_review", "done"], subsetOf: "task.status", note: "Statuses whose review artifacts are required." },
  { id: "task.status.wip-occupying", entity: "Task", field: "status", module: "packages/kernel/src/domain/task-wip-policy.ts", anchor: "taskWipOccupyingStatuses", words: ["active", "blocked", "in_review"], subsetOf: "task.status", note: "Statuses that occupy a WIP slot." },
  { id: "task.status.replay", entity: "Task", field: "status", module: "packages/kernel/src/domain/task.ts", anchor: "replayTaskStatuses", words: ["planned", "active", "blocked", "in_review", "done", "cancelled"], subsetOf: "task.status", note: "Task/v1 wire validator set; same words, same meanings." },
  { id: "decision.state", entity: "Decision", field: "state", module: "packages/kernel/src/domain/fact-event.ts", anchor: "decisionStates", words: ["proposed", "active", "rejected", "deferred", "superseded", "retired"] },
  { id: "decision.judgment.target", entity: "Decision", field: "judgment targetState", module: "packages/kernel/src/domain/fact-event.ts", anchor: "#targetState", words: ["active", "rejected", "deferred"], subsetOf: "decision.state", note: "Consent target states of the three judgment actions." },
  { id: "execution.state", entity: "Execution", field: "state", module: "packages/kernel/src/domain/execution.ts", anchor: "executionStates", words: ["active", "submitted", "accepted", "changes_requested", "abandoned"] },
  { id: "execution.state.v1", entity: "Execution", field: "state", module: "packages/kernel/src/domain/execution.ts", anchor: "executionV1States", words: ["active", "submitted", "changes_requested", "accepted"], subsetOf: "execution.state", note: "Native execution/v1 subset (archived v0 adds abandoned)." },
  { id: "lease.phase", entity: "Lease", field: "phase", module: "packages/kernel/src/domain/execution.ts", anchor: "leasePhases", words: ["reserving", "active", "orphaned", "released"] },
  { id: "relation.state", entity: "RelationEdge", field: "state", module: "packages/kernel/src/domain/entity-relation.ts", anchor: "relationStates", words: ["active", "retired", "deleted"] },
  { id: "task-blocking.assessment", entity: "Task", field: "blocking state", module: "packages/kernel/src/domain/task-blocking.ts", anchor: "BlockingAssessmentState", words: ["blocked", "clear", "unknown"], note: "Verdict of blockingOf per task; distinct from task.status blocked (a lifecycle state), hence entity-scoped." },
  { id: "decision-coverage.status", entity: "Decision", field: "claim coverage status", module: "packages/kernel/src/domain/decision-coverage.ts", anchor: "#status", words: ["covered", "uncovered"], note: "Verdict of coverageOf per claim; a read-model judgment, not a Decision lifecycle state." },
  { id: "fact.liveness", entity: "FactRecord", field: "liveness", module: "packages/kernel/src/domain/fact-liveness.ts", anchor: "FactLiveness", words: ["live", "retired"], note: "Single domain derivation of fact liveness (factLiveness); same two words and meanings as fact-record.state, now computed in one place." },
  { id: "closeout.gate-status", entity: "TaskCloseout", field: "gate status", module: "packages/kernel/src/domain/closeout-readiness.ts", anchor: "CloseoutGateStatus", words: ["passed", "failed", "missing", "unknown"], note: "Per-gate verdict inside closeoutReadiness; the readiness label aggregates these." },
  { id: "task-blocking.availability", entity: "Task", field: "blocking projection availability", module: "packages/kernel/src/domain/task-blocking.ts", anchor: "BlockingAvailabilityState", words: ["ready", "loading", "error"], note: "Relation-projection availability feeding blockingOf; degraded states make every task's blocking unknown." },
  { id: "package.disposition", entity: "Package", field: "disposition", module: "packages/kernel/src/domain/package-disposition.ts", anchor: "packageDispositions", words: ["active", "archived", "tombstoned"] },
  { id: "task-package.disposition", entity: "Package", field: "disposition", module: "packages/kernel/src/domain/task.ts", anchor: "TaskPackageDisposition", words: ["active", "archived", "tombstoned"], subsetOf: "package.disposition", note: "Inline alias of the package disposition vocabulary on Task documents." },
  { id: "task-wip.package-disposition", entity: "Package", field: "disposition", module: "packages/kernel/src/domain/task-wip-policy.ts", anchor: "#packageDisposition", words: ["active", "archived", "tombstoned"], subsetOf: "package.disposition", note: "WIP snapshot entry mirror of the package disposition vocabulary." },
  { id: "fact-record.state", entity: "FactRecord", field: "state", module: "packages/kernel/src/domain/fact-event.ts", anchor: "#state", words: ["live", "retired"], note: "Per-fact row state in authored facts documents; the SQL projection derives the same two words from active supersedes-fact edges." },
  { id: "review.verdict", entity: "Review", field: "verdict", module: "packages/kernel/src/domain/review.ts", anchor: "reviewVerdicts", words: ["approved", "changes_requested", "dismissed"] },
  { id: "runtime.liveness", entity: "RuntimeSession", field: "liveness", module: "packages/kernel/src/domain/agent-runtime.ts", anchor: "runtimeLivenessStates", words: ["live", "stale", "unknown", "exited"] },
  { id: "runtime.outcome", entity: "RuntimeSession", field: "outcome", module: "packages/kernel/src/domain/agent-runtime.ts", anchor: "#outcome", words: ["succeeded", "failed", "unknown"] },
  { id: "receipt.outcome", entity: "WriteReceipt", field: "outcome", module: "packages/kernel/src/domain/write-chain.contract.ts", anchor: "writeReceiptOutcomes", words: ["applied", "pending", "indeterminate", "rejected"] },
  { id: "receipt.detail.outcome", entity: "WriteReceipt", field: "outcome", module: "packages/kernel/src/domain/receipt-domain-registry.ts", anchor: "#outcome", words: ["applied", "pending", "indeterminate", "rejected"], subsetOf: "receipt.outcome", note: "The WriteReceipt interface repeats the outcome vocabulary; must stay equal to writeReceiptOutcomes." },
  { id: "recovery.state", entity: "Recovery", field: "state", module: "packages/kernel/src/domain/write-chain.contract.ts", anchor: "recoveryStates", words: ["queued", "running", "exhausted", "failed", "drained"] },
  { id: "closeout.readiness", entity: "TaskCloseout", field: "readiness", module: "packages/kernel/src/domain/closeout-readiness.ts", anchor: "closeoutReadinesses", words: ["not_required", "missing", "incomplete", "ready", "passed", "failed"] },
  { id: "task.session-disposition", entity: "Task", field: "sessionBinding disposition", module: "packages/kernel/src/domain/task-lifecycle.contract.ts", anchor: "#sessionDisposition", words: ["complete", "partial", "unavailable"], note: "Witness availability, not entity standing." },
  { id: "vertical-script.disposition", entity: "VerticalScript", field: "disposition", module: "packages/kernel/src/domain/vertical-script-action.ts", anchor: "#disposition", words: ["create", "replace"] },

  // GUI model mirrors (renderer may not import kernel runtime values; the gate locks text equality).
  { id: "gui.task.status", entity: "GuiAdapter", field: "status", module: "packages/gui/src/renderer/model/types.ts", anchor: "CanonicalStatus", words: ["planned", "active", "blocked", "in_review", "done", "cancelled"], mirrorOf: "task.status" },
  { id: "gui.task.snapshot-status", entity: "GuiAdapter", field: "status", module: "packages/gui/src/renderer/model/types.ts", anchor: "SnapshotStatus", words: ["planned", "active", "blocked", "in_review", "done", "cancelled", "unknown"], mirrorOf: "task.status", plusWords: ["unknown"] },
  { id: "gui.decision.state", entity: "GuiAdapter", field: "state", module: "packages/gui/src/renderer/model/types.ts", anchor: "DecisionState", words: ["proposed", "active", "rejected", "deferred", "superseded", "retired", "unknown"], mirrorOf: "decision.state", plusWords: ["unknown"] },
  { id: "gui.package.disposition", entity: "GuiAdapter", field: "disposition", module: "packages/gui/src/renderer/model/types.ts", anchor: "PackageDisposition", words: ["active", "archived", "tombstoned"], mirrorOf: "package.disposition" },

  // Daemon wire-protocol mirrors. The contract sits on the CLI's eager startup path, so
  // it must not import the kernel barrel (the p50 overhead gate refuses eager module
  // growth); the mirrors stay plain data and the ratchet gate locks them to the kernel.
  { id: "daemon.task.status", entity: "DaemonWire", field: "status", module: "packages/daemon/src/protocol/daemon-protocol.contract.ts", anchor: "taskStatusWords", words: ["planned", "active", "blocked", "in_review", "done", "cancelled"], mirrorOf: "task.status" },
  { id: "daemon.execution.state", entity: "DaemonWire", field: "state", module: "packages/daemon/src/protocol/daemon-protocol.contract.ts", anchor: "executionStateWords", words: ["active", "submitted", "accepted", "changes_requested", "abandoned"], mirrorOf: "execution.state" },
  { id: "daemon.execution.state-v1", entity: "DaemonWire", field: "state", module: "packages/daemon/src/protocol/daemon-protocol.contract.ts", anchor: "executionV1StateWords", words: ["active", "submitted", "changes_requested", "accepted"], mirrorOf: "execution.state.v1" },
  { id: "daemon.lease.phase", entity: "DaemonWire", field: "phase", module: "packages/daemon/src/protocol/daemon-protocol.contract.ts", anchor: "leasePhaseWords", words: ["reserving", "active", "orphaned", "released"], mirrorOf: "lease.phase" },
  { id: "daemon.relation.state", entity: "DaemonWire", field: "state", module: "packages/daemon/src/protocol/daemon-protocol.contract.ts", anchor: "relationStateWords", words: ["active", "retired", "deleted"], mirrorOf: "relation.state" },
  { id: "daemon.package.disposition", entity: "DaemonWire", field: "disposition", module: "packages/daemon/src/protocol/daemon-protocol.contract.ts", anchor: "packageDispositionWords", words: ["active", "archived", "tombstoned"], mirrorOf: "package.disposition" },
  { id: "daemon.review.verdict", entity: "DaemonWire", field: "verdict", module: "packages/daemon/src/protocol/daemon-protocol.contract.ts", anchor: "reviewVerdictWords", words: ["approved", "changes_requested", "dismissed"], mirrorOf: "review.verdict" },
  { id: "daemon.decision.state", entity: "DaemonWire", field: "state", module: "packages/daemon/src/protocol/daemon-protocol.contract.ts", anchor: "decisionStateWords", words: ["proposed", "active", "rejected", "deferred", "superseded", "retired"], mirrorOf: "decision.state" },
  { id: "daemon.receipt.outcome", entity: "DaemonWire", field: "outcome", module: "packages/daemon/src/protocol/daemon-protocol.contract.ts", anchor: "receiptOutcomeWords", words: ["applied", "pending", "indeterminate", "rejected"], mirrorOf: "receipt.outcome" }
];

export function statusWords(entity: StatusEntity, field?: string): readonly string[] {
  return statusWordRegister
    .filter((row) => row.entity === entity && (field === undefined || row.field === field))
    .map((row) => row.word);
}

export function statusMeaning(word: string, entity: StatusEntity): string | undefined {
  return statusWordRegister.find((row) => row.word === word && row.entity === entity)?.meaning;
}
