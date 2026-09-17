import type { StatusWordRegistration } from "./status-vocabulary.ts";
import { closeoutStatusWordRegister } from "./status-word-register-closeout.ts";

/** Ordered cross-entity status registrations, assembled from bounded domains. */
export const statusWordRegister: readonly StatusWordRegistration[] = [
  // ---- CiTest.status (structured CI test observation) ----
  {
    word: "passed",
    entity: "CiTest",
    field: "status",
    meaning: "The CI test completed successfully, including a retry that eventually passed.",
    divergence: "entity-scoped",
  },
  {
    word: "failed",
    entity: "CiTest",
    field: "status",
    meaning: "The CI test completed unsuccessfully after its recorded retries.",
    divergence: "entity-scoped",
  },
  {
    word: "skipped",
    entity: "CiTest",
    field: "status",
    meaning: "The CI test was intentionally not executed.",
    divergence: "entity-scoped",
  },
  // ---- Agent.state (declaration lifecycle) ----
  {
    word: "configured",
    entity: "Agent",
    field: "state",
    meaning: "Agent declaration is present and has passed schema validation.",
    divergence: "entity-scoped",
  },
  {
    word: "active",
    entity: "Agent",
    field: "state",
    meaning: "Agent is eligible to receive dispatches.",
    divergence: "divergent",
    resolution: "Agent availability, not task execution occupancy; retained as an entity-scoped state.",
  },
  {
    word: "retired",
    entity: "Agent",
    field: "state",
    meaning: "Agent declaration is retained for history but no longer dispatchable.",
    divergence: "entity-scoped",
  },
  // ---- Policy.state (policy lifecycle) ----
  {
    word: "draft",
    entity: "Policy",
    field: "state",
    meaning: "Policy has been authored but is not in effect.",
    divergence: "entity-scoped",
  },
  {
    word: "active",
    entity: "Policy",
    field: "state",
    meaning: "Policy is currently in effect for authorized executions.",
    divergence: "divergent",
    resolution: "Policy effect, not task or execution activity; retained as an entity-scoped state.",
  },
  {
    word: "retired",
    entity: "Policy",
    field: "state",
    meaning: "Policy is no longer in effect but remains auditable.",
    divergence: "entity-scoped",
  },
  // ---- Schedule definition state / occurrence outcome ----
  {
    word: "armed",
    entity: "Schedule",
    field: "state",
    meaning: "The Schedule definition is eligible for automatic occurrence evaluation and claim.",
    divergence: "entity-scoped",
  },
  {
    word: "paused",
    entity: "Schedule",
    field: "state",
    meaning: "The Schedule definition rejects new automatic claims while any already claimed run may finish.",
    divergence: "entity-scoped",
  },
  {
    word: "succeeded",
    entity: "Schedule",
    field: "status.lastRun.outcome",
    meaning: "The Schedule occurrence settled successfully after its dispatch attempt chain.",
    divergence: "entity-scoped",
  },
  {
    word: "failed",
    entity: "Schedule",
    field: "status.lastRun.outcome",
    meaning: "The Schedule occurrence reached a terminal failure, including failure before a RuntimeSession existed.",
    divergence: "entity-scoped",
  },
  {
    word: "unknown",
    entity: "Schedule",
    field: "status.lastRun.outcome",
    meaning: "The Schedule occurrence settled without an observable terminal result.",
    divergence: "entity-scoped",
  },
  {
    word: "cancelled",
    entity: "Schedule",
    field: "status.lastRun.outcome",
    meaning: "The Schedule occurrence settled because its dispatched work was actively cancelled.",
    divergence: "entity-scoped",
  },
  // ---- Slice-3 domain judgments (registered here when the two slices met on main) ----
  {
    word: "blocked",
    entity: "Task",
    field: "blocking state",
    meaning: "blockingOf verdict: an active depends-on edge with a non-done target blocks this task.",
    divergence: "divergent",
    resolution:
      "Shares the word with task.status blocked (a lifecycle state); same task can be status=active yet blocking " +
      "state=blocked. Registered as distinct meanings; renaming either is stored-data/API surface — CH2 proposal only.",
  },
  {
    word: "clear",
    entity: "Task",
    field: "blocking state",
    meaning: "blockingOf verdict: no active blocker.",
    divergence: "entity-scoped",
  },
  {
    word: "unknown",
    entity: "Task",
    field: "blocking state",
    meaning: "blockingOf could not answer: degraded projection or malformed edge.",
    divergence: "entity-scoped",
  },
  {
    word: "ready",
    entity: "Task",
    field: "blocking projection availability",
    meaning: "Relation projection is loaded; blockingOf verdicts are meaningful.",
    divergence: "entity-scoped",
  },
  {
    word: "loading",
    entity: "Task",
    field: "blocking projection availability",
    meaning: "Relation projection still loading; every blocking verdict is unknown.",
    divergence: "entity-scoped",
  },
  {
    word: "error",
    entity: "Task",
    field: "blocking projection availability",
    meaning: "Relation projection failed; every blocking verdict is unknown.",
    divergence: "entity-scoped",
  },
  {
    word: "ready",
    entity: "Task",
    field: "read set projection cut",
    meaning: "Read set derived at a caught-up cut; the edge list is complete for that revision.",
    divergence: "entity-scoped",
  },
  {
    word: "pending",
    entity: "Task",
    field: "read set projection cut",
    meaning: "Read set derived while the projection still trails the canonical revision.",
    divergence: "entity-scoped",
  },
  {
    word: "ready",
    entity: "Task",
    field: "completion projection status",
    meaning: "Completion next step judged at a caught-up canonical projection cut.",
    divergence: "entity-scoped",
  },
  {
    word: "pending",
    entity: "Task",
    field: "completion projection status",
    meaning:
      "Projection still trails the canonical revision; completion answers projection_unknown instead of judging.",
    divergence: "entity-scoped",
  },
  {
    word: "covered",
    entity: "Decision",
    field: "claim coverage status",
    meaning: "coverageOf verdict: the claim's declared fulfillment mode is satisfied by live evidence.",
    divergence: "entity-scoped",
  },
  {
    word: "uncovered",
    entity: "Decision",
    field: "claim coverage status",
    meaning: "coverageOf verdict: no satisfying evidence, or fulfillment undeclared (null).",
    divergence: "entity-scoped",
  },
  {
    word: "standing",
    entity: "FactRecord",
    field: "liveness",
    meaning: "factLiveness verdict: no active supersedes-fact edge targets this fact.",
    divergence: "entity-scoped",
  },
  {
    word: "superseded_fact",
    entity: "FactRecord",
    field: "liveness",
    meaning: "factLiveness verdict: an active supersedes-fact edge targets this fact.",
    divergence: "entity-scoped",
  },
  // ---- CodeDocWitness.disposition (append-only evidence backfill) ----
  {
    word: "repointed",
    entity: "CodeDocWitness",
    field: "disposition",
    meaning: "The witness has an authoritative replacement path set appended after issuance.",
    divergence: "entity-scoped",
  },
  {
    word: "known-invalid",
    entity: "CodeDocWitness",
    field: "disposition",
    meaning: "The witness is retained for audit but must not be consumed as valid evidence.",
    divergence: "entity-scoped",
  },
  // ---- Task.status (execution coordination; the WIP machine) ----
  {
    word: "planned",
    entity: "Task",
    field: "status",
    meaning: "Task is committed but no execution has opened it yet.",
    divergence: "entity-scoped",
  },
  {
    word: "active",
    entity: "Task",
    field: "status",
    meaning: "Task is in an open executing state and occupies a WIP slot.",
    divergence: "divergent",
    resolution:
      "One of four unrelated `active` concepts (Task/Execution/Relation/Package); rename is stored data " +
      "(task snapshots and events), so this slice registers the meaning instead — CH2 proposal only.",
  },
  {
    word: "blocked",
    entity: "Task",
    field: "status",
    meaning: "Task is held by an external condition; still open, still occupies WIP.",
    divergence: "entity-scoped",
  },
  {
    word: "in_review",
    entity: "Task",
    field: "status",
    meaning: "Task is in the review node; review artifacts are required.",
    divergence: "entity-scoped",
  },
  {
    word: "done",
    entity: "Task",
    field: "status",
    meaning: "Task reached its delivery terminal state.",
    divergence: "entity-scoped",
  },
  {
    word: "cancelled",
    entity: "Task",
    field: "status",
    meaning:
      "Task was abandoned; terminal except the compensating reinstate rollback to the recorded pre-cancel status.",
    divergence: "entity-scoped",
  },
  {
    word: "open",
    entity: "Task",
    field: "coarse class",
    meaning: "Coarse class of every non-terminal task status.",
    divergence: "entity-scoped",
  },
  {
    word: "terminal",
    entity: "Task",
    field: "coarse class",
    meaning:
      "Coarse class of done/cancelled; no forward transitions (cancelled keeps only the compensating reinstate exit).",
    divergence: "entity-scoped",
  },

  // ---- Decision.state (adjudication outcomes; persisted policy) ----
  {
    word: "proposed",
    entity: "Decision",
    field: "state",
    meaning: "Decision awaits judgment.",
    divergence: "entity-scoped",
  },
  {
    word: "in_effect",
    entity: "Decision",
    field: "state",
    meaning:
      "Decision was accepted and its policy is in effect (accept writes in_effect; there is no separate " +
      "accepted state).",
    divergence: "entity-scoped",
  },
  {
    word: "rejected",
    entity: "Decision",
    field: "state",
    meaning: "Judgment refused the decision; a persistent policy state that feeds later adjudication.",
    divergence: "divergent",
    resolution:
      "The one-shot operation results are now op_rejected (WriteReceipt/PresetRun); the decision word is stored " +
      "policy and keeps rejected.",
  },
  {
    word: "deferred",
    entity: "Decision",
    field: "state",
    meaning: "Judgment postponed; a persistent policy state.",
    divergence: "entity-scoped",
  },
  {
    word: "superseded",
    entity: "Decision",
    field: "state",
    meaning:
      "A later decision replaced this one (ADR-0020 D1: consumers must preserve this state, never fold it " +
      "back into proposed).",
    divergence: "entity-scoped",
  },
  {
    word: "outcome_retired",
    entity: "Decision",
    field: "state",
    meaning: "A human ended the decision's standing deliberately.",
    divergence: "entity-scoped",
  },
  {
    word: "in_effect",
    entity: "Decision",
    field: "judgment targetState",
    meaning: "Judgment consent target when the action is accept.",
    divergence: "entity-scoped",
  },
  {
    word: "rejected",
    entity: "Decision",
    field: "judgment targetState",
    meaning: "Judgment consent target when the action is reject.",
    divergence: "entity-scoped",
  },
  {
    word: "deferred",
    entity: "Decision",
    field: "judgment targetState",
    meaning: "Judgment consent target when the action is defer.",
    divergence: "entity-scoped",
  },

  // ---- Execution.state (one execution of a task) ----
  {
    word: "active",
    entity: "Execution",
    field: "state",
    meaning: "Execution currently holds the work.",
    divergence: "divergent",
    resolution: "Coordination occupancy, not policy effect; stored in execution projections — CH2 proposal only.",
  },
  {
    word: "submitted",
    entity: "Execution",
    field: "state",
    meaning: "Execution submitted its completion claim for review.",
    divergence: "entity-scoped",
  },
  {
    word: "accepted",
    entity: "Execution",
    field: "state",
    meaning: "Execution's submission was accepted.",
    divergence: "entity-scoped",
  },
  {
    word: "changes_requested",
    entity: "Execution",
    field: "state",
    meaning: "Review sent the execution back for rework.",
    divergence: "entity-scoped",
  },
  {
    word: "abandoned",
    entity: "Execution",
    field: "state",
    meaning: "Archived (v0) execution was abandoned before closing.",
    divergence: "entity-scoped",
  },

  // ---- Lease.phase (the current claim on a task) ----
  {
    word: "reserving",
    entity: "Lease",
    field: "phase",
    meaning: "Lease write is reserved but not yet activated.",
    divergence: "entity-scoped",
  },
  {
    word: "held",
    entity: "Lease",
    field: "phase",
    meaning: "The claim is currently held by its execution.",
    divergence: "entity-scoped",
  },
  {
    word: "orphaned",
    entity: "Lease",
    field: "phase",
    meaning: "Holder is unreachable; the lease awaits reclaim.",
    divergence: "entity-scoped",
  },
  {
    word: "released",
    entity: "Lease",
    field: "phase",
    meaning: "Holder handed the lease back; reclaimable.",
    divergence: "entity-scoped",
  },

  // ---- Relation.state (bookkeeping of a first-class relation) ----
  {
    word: "active",
    entity: "Relation",
    field: "state",
    meaning: "Edge is live and may be load-bearing when its freshness is consumable.",
    divergence: "divergent",
    resolution:
      "Bookkeeping liveness, unrelated to the other `active` concepts (Task/Execution/Package); stored in relation " +
      "records — CH2 proposal only.",
  },
  {
    word: "retired",
    entity: "Relation",
    field: "state",
    meaning: "Edge was retired in place; kept as audit history.",
    divergence: "entity-scoped",
  },
  // ---- Package.disposition (task package lifecycle) ----
  {
    word: "active",
    entity: "Package",
    field: "disposition",
    meaning: "Package is in normal use: not archived, not tombstoned.",
    divergence: "divergent",
    resolution:
      "Storage liveness of a directory, not coordination/policy; stored in placement records — CH2 proposal only.",
  },
  {
    word: "archived",
    entity: "Package",
    field: "disposition",
    meaning: "Package moved out of active use, kept readable.",
    divergence: "entity-scoped",
  },
  {
    word: "tombstoned",
    entity: "Package",
    field: "disposition",
    meaning: "Package deleted with a tombstone marker.",
    divergence: "entity-scoped",
  },

  // ---- FactRecord.state (per-fact row in facts documents and projections) ----
  {
    word: "standing",
    entity: "FactRecord",
    field: "state",
    meaning: "Fact has not been superseded; the record is standing.",
    divergence: "entity-scoped",
  },
  {
    word: "superseded_fact",
    entity: "FactRecord",
    field: "state",
    meaning: "Fact is the target of an active supersedes-fact edge.",
    divergence: "entity-scoped",
  },

  // ---- Review.verdict ----
  {
    word: "approved",
    entity: "Review",
    field: "verdict",
    meaning: "Review approved the submission cut.",
    divergence: "entity-scoped",
  },
  {
    word: "changes_requested",
    entity: "Review",
    field: "verdict",
    meaning: "Review requested rework; same concept the Execution state encodes.",
    divergence: "entity-scoped",
  },
  {
    word: "dismissed",
    entity: "Review",
    field: "verdict",
    meaning: "Review dismissed the submission as not reviewable.",
    divergence: "entity-scoped",
  },

  // ---- RuntimeSession.liveness / outcome ----
  {
    word: "live",
    entity: "RuntimeSession",
    field: "liveness",
    meaning: "Session heartbeat is current.",
    divergence: "divergent",
    resolution: "Heartbeat liveness, unrelated to FactRecord.live; stored in runtime events — CH2 proposal only.",
  },
  {
    word: "stale",
    entity: "RuntimeSession",
    field: "liveness",
    meaning: "Heartbeat is late but the session has not exited.",
    divergence: "entity-scoped",
  },
  {
    word: "unknown",
    entity: "RuntimeSession",
    field: "liveness",
    meaning: "Heartbeat could not be observed.",
    divergence: "entity-scoped",
  },
  {
    word: "exited",
    entity: "RuntimeSession",
    field: "liveness",
    meaning: "Session process ended; terminal.",
    divergence: "entity-scoped",
  },
  {
    word: "succeeded",
    entity: "RuntimeSession",
    field: "outcome",
    meaning: "Session outcome observed as success.",
    divergence: "entity-scoped",
  },
  {
    word: "failed",
    entity: "RuntimeSession",
    field: "outcome",
    meaning: "Session outcome observed as failure.",
    divergence: "entity-scoped",
  },
  {
    word: "unknown",
    entity: "RuntimeSession",
    field: "outcome",
    meaning: "Session outcome was never observed.",
    divergence: "entity-scoped",
  },
  {
    word: "cancelled",
    entity: "RuntimeSession",
    field: "outcome",
    meaning: "Session was actively terminated by a cancel request.",
    divergence: "entity-scoped",
  },
  // ---- RuntimeSession installation state (derived against local witnesses) ----
  {
    word: "present",
    entity: "RuntimeSession",
    field: "installation state",
    meaning: "The session's referenced installation is witnessed on the reading node.",
    divergence: "entity-scoped",
  },
  {
    word: "missing",
    entity: "RuntimeSession",
    field: "installation state",
    meaning: "The session remains readable but its referenced installation is not witnessed on the reading node.",
    divergence: "entity-scoped",
  },
  {
    word: "by_session_id",
    entity: "RuntimeSession",
    field: "transcript reachability",
    meaning: "The provider transcript can be retrieved by its session identifier.",
    divergence: "entity-scoped",
  },
  {
    word: "dispatch_stream_only",
    entity: "RuntimeSession",
    field: "transcript reachability",
    meaning: "The transcript is available only from the temporary dispatch stream.",
    divergence: "entity-scoped",
  },
  // ---- RuntimeSession semantic state (derived from liveness + outcome) ----
  {
    word: "running",
    entity: "RuntimeSession",
    field: "semantic state",
    meaning: "Heartbeat is live and no outcome has been observed yet.",
    divergence: "entity-scoped",
  },
  {
    word: "succeeded",
    entity: "RuntimeSession",
    field: "semantic state",
    meaning: "The observed outcome was success.",
    divergence: "entity-scoped",
  },
  {
    word: "failed",
    entity: "RuntimeSession",
    field: "semantic state",
    meaning: "The observed outcome was failure.",
    divergence: "entity-scoped",
  },
  {
    word: "cancelled",
    entity: "RuntimeSession",
    field: "semantic state",
    meaning: "The observed outcome was an actively requested cancellation.",
    divergence: "entity-scoped",
  },
  {
    word: "ended-indeterminate",
    entity: "RuntimeSession",
    field: "semantic state",
    meaning: "An outcome was recorded but carries no verdict; the session ended without one.",
    divergence: "entity-scoped",
  },
  {
    word: "unavailable",
    entity: "RuntimeSession",
    field: "semantic state",
    meaning: "No outcome was ever observed and the heartbeat is not live, so how it ended is unknown.",
    divergence: "divergent",
    resolution:
      "Collides with the same entity's transcript reachability word, which is " +
      "about reaching the transcript rather than about how the session ended. " +
      "Both stand for now; a rename would go to this semantic state word " +
      '(candidate: "ended-unobserved").',
  },
  {
    word: "unavailable",
    entity: "RuntimeSession",
    field: "transcript reachability",
    meaning: "No provider session identifier or dispatch transcript is available.",
    divergence: "entity-scoped",
  },

  // ---- WriteReceipt.outcome (one write request) ----
  {
    word: "applied",
    entity: "WriteReceipt",
    field: "outcome",
    meaning: "Write committed at the canonical cut.",
    divergence: "entity-scoped",
  },
  {
    word: "pending",
    entity: "WriteReceipt",
    field: "outcome",
    meaning: "Write not yet settled at the canonical cut.",
    divergence: "entity-scoped",
  },
  {
    word: "no_changes",
    entity: "WriteReceipt",
    field: "outcome",
    meaning: "The requested valid document selection is already clean; no write was needed.",
    divergence: "entity-scoped",
  },
  {
    word: "indeterminate",
    entity: "WriteReceipt",
    field: "outcome",
    meaning: "Publication outcome could not be determined; query the receipt before retrying.",
    divergence: "entity-scoped",
  },
  {
    word: "op_rejected",
    entity: "WriteReceipt",
    field: "outcome",
    meaning: "Write was refused; a one-shot operation result.",
    divergence: "divergent",
    resolution:
      "Same operation-result family as PresetRun.op_rejected; renamed from rejected at the CH3 cutover so the " +
      "one-shot operation result no longer collides with Decision.rejected.",
  },

  // ---- AuthorizationDecision.outcome (policy evaluation carried by a receipt) ----
  {
    word: "allowed",
    entity: "AuthorizationDecision",
    field: "outcome",
    meaning: "The evaluated policy permits the Action for the recorded actor and subject.",
    divergence: "entity-scoped",
  },
  {
    word: "denied",
    entity: "AuthorizationDecision",
    field: "outcome",
    meaning: "The evaluated policy refuses the Action and records reasons and next Actions.",
    divergence: "entity-scoped",
  },

  // ---- Recovery.state (write-chain recovery batches; runtime-only) ----
  {
    word: "queued",
    entity: "Recovery",
    field: "state",
    meaning: "Recovery items still queued behind the cursor.",
    divergence: "entity-scoped",
  },
  {
    word: "running",
    entity: "Recovery",
    field: "state",
    meaning: "Recovery batch is executing.",
    divergence: "entity-scoped",
  },
  {
    word: "exhausted",
    entity: "Recovery",
    field: "state",
    meaning: "Recovery batch exhausted its current budget with items remaining.",
    divergence: "entity-scoped",
  },
  {
    word: "failed",
    entity: "Recovery",
    field: "state",
    meaning: "Recovery exhausted its retries.",
    divergence: "entity-scoped",
  },
  {
    word: "drained",
    entity: "Recovery",
    field: "state",
    meaning: "Recovery batch drained its items.",
    divergence: "entity-scoped",
  },

  // ---- Materialization.state (WAL-to-Git checkpoint health) ----
  {
    word: "ok",
    entity: "Materialization",
    field: "state",
    meaning: "No materialization failure is pending and write admission remains open.",
    divergence: "entity-scoped",
  },
  {
    word: "retrying",
    entity: "Materialization",
    field: "state",
    meaning: "A checkpoint attempt failed but remains within the automatic retry budget.",
    divergence: "entity-scoped",
  },
  {
    word: "failed",
    entity: "Materialization",
    field: "state",
    meaning: "Materialization is latched and new writes are refused until explicit recovery succeeds.",
    divergence: "entity-scoped",
  },

  {
    word: "accepted_durable",
    entity: "WriteReceipt",
    field: "status",
    meaning: "The accepting SQLite transaction committed the event and command outcome.",
    divergence: "entity-scoped",
  },
  {
    word: "rejected",
    entity: "WriteReceipt",
    field: "status",
    meaning: "The command was refused without accepting an event.",
    divergence: "entity-scoped",
  },
  {
    word: "unknown",
    entity: "WriteReceipt",
    field: "status",
    meaning: "Acceptance has not been established; query the same operation ID.",
    divergence: "entity-scoped",
  },
  {
    word: "pending",
    entity: "WriteReceipt",
    field: "facetState",
    meaning: "The consumer has not verified the requested accepted cut.",
    divergence: "entity-scoped",
  },
  {
    word: "verified",
    entity: "WriteReceipt",
    field: "facetState",
    meaning: "The independent consumer read back the accepted cut.",
    divergence: "entity-scoped",
  },
  {
    word: "not_configured",
    entity: "WriteReceipt",
    field: "facetState",
    meaning: "No replica consumer is configured for this receipt.",
    divergence: "entity-scoped",
  },
  {
    word: "satisfied",
    entity: "WriteReceipt",
    field: "waitState",
    meaning: "Every requested receipt predicate holds.",
    divergence: "entity-scoped",
  },
  {
    word: "timed_out",
    entity: "WriteReceipt",
    field: "waitState",
    meaning: "At least one requested predicate remains unsatisfied; acceptance is unchanged.",
    divergence: "entity-scoped",
  },
  // ---- EntityActionCriterion explanation status (advisory read; entity-action-explanation.ts) ----
  {
    word: "met",
    entity: "EntityActionCriterion",
    field: "status",
    meaning: "The action criterion holds at the evaluated projection cut.",
    divergence: "entity-scoped",
  },
  {
    word: "unmet",
    entity: "EntityActionCriterion",
    field: "status",
    meaning: "The action criterion fails at the evaluated projection cut.",
    divergence: "entity-scoped",
  },
  {
    word: "invocation-required",
    entity: "EntityActionCriterion",
    field: "status",
    meaning: "The criterion can only be decided by invoking the action; the read cannot evaluate it.",
    divergence: "entity-scoped",
  },
  {
    word: "not-evaluated",
    entity: "EntityActionCriterion",
    field: "status",
    meaning: "Catalog explanations do not evaluate criteria against a target.",
    divergence: "entity-scoped",
  },
  // ---- PresetRun outcome/phase (documented; declared in packages/preset) ----
  {
    word: "started",
    entity: "PresetRun",
    field: "outcome",
    meaning: "Preset run was launched.",
    divergence: "entity-scoped",
  },
  {
    word: "running",
    entity: "PresetRun",
    field: "outcome",
    meaning: "Preset run is in progress.",
    divergence: "entity-scoped",
  },
  {
    word: "applied",
    entity: "PresetRun",
    field: "outcome",
    meaning: "Preset run applied its outputs.",
    divergence: "entity-scoped",
  },
  {
    word: "op_rejected",
    entity: "PresetRun",
    field: "outcome",
    meaning: "Preset run was refused; a one-shot operation result.",
    divergence: "divergent",
    resolution: "Same operation-result family as WriteReceipt.op_rejected; renamed from rejected at the CH3 cutover.",
  },
  {
    word: "failed",
    entity: "PresetRun",
    field: "outcome",
    meaning: "Preset run failed.",
    divergence: "entity-scoped",
  },
  {
    word: "outcome_unknown",
    entity: "PresetRun",
    field: "outcome",
    meaning: "Preset run result could not be observed.",
    divergence: "entity-scoped",
  },
  {
    word: "admitted",
    entity: "PresetRun",
    field: "phase",
    meaning: "Run passed admission checks.",
    divergence: "entity-scoped",
  },
  {
    word: "spawned",
    entity: "PresetRun",
    field: "phase",
    meaning: "Run process spawned.",
    divergence: "entity-scoped",
  },
  {
    word: "publishing",
    entity: "PresetRun",
    field: "phase",
    meaning: "Run is publishing outputs.",
    divergence: "entity-scoped",
  },

  // ---- TaskCloseout gate status and readiness (status-word-register-closeout.ts) ----
  ...closeoutStatusWordRegister,

  // ---- Task.sessionBinding disposition (witness availability) ----
  {
    word: "complete",
    entity: "Task",
    field: "sessionBinding disposition",
    meaning: "All session bindings for the iteration are present.",
    divergence: "entity-scoped",
  },
  {
    word: "partial",
    entity: "Task",
    field: "sessionBinding disposition",
    meaning: "Some session bindings are missing.",
    divergence: "entity-scoped",
  },
  {
    word: "unavailable",
    entity: "Task",
    field: "sessionBinding disposition",
    meaning: "Session bindings cannot be determined.",
    divergence: "entity-scoped",
  },

  // ---- VerticalScript.disposition ----
  {
    word: "create",
    entity: "VerticalScript",
    field: "disposition",
    meaning: "Vertical script action creates the target file.",
    divergence: "entity-scoped",
  },
  {
    word: "replace",
    entity: "VerticalScript",
    field: "disposition",
    meaning: "Vertical script action replaces the target file.",
    divergence: "entity-scoped",
  },

  // ---- Witness/checker literals and legacy markers ----
  {
    word: "pass",
    entity: "Task",
    field: "gate witness result",
    meaning: "The only value a completion-gate witness may carry: the checker passed.",
    divergence: "entity-scoped",
  },
  {
    word: "migrated",
    entity: "LegacyFact",
    field: "migration marker",
    meaning: "Legacy fact row carries a migration note and is not native event truth.",
    divergence: "entity-scoped",
  },

  // ---- GuiAdapter (renderer mirrors; unknown is the house convention) ----
  {
    word: "unknown",
    entity: "GuiAdapter",
    field: "adapter fallback",
    meaning:
      "The backend value was not in the registered vocabulary; the GUI shows unknown as unknown (SnapshotStatus " +
      "precedent) and never folds it into a plausible neighbour.",
    divergence: "entity-scoped",
  },
  {
    word: "blocked",
    entity: "GuiAdapter",
    field: "blocking",
    meaning: "An active blocking relation blocks the task.",
    divergence: "entity-scoped",
  },
  {
    word: "clear",
    entity: "GuiAdapter",
    field: "blocking",
    meaning: "No active blocking relation.",
    divergence: "entity-scoped",
  },
  {
    word: "attached",
    entity: "GuiAdapter",
    field: "terminal stream",
    meaning: "Terminal stream is attached without a gap.",
    divergence: "entity-scoped",
  },
  {
    word: "gap",
    entity: "GuiAdapter",
    field: "terminal stream",
    meaning: "Terminal stream has an unrecoverable gap.",
    divergence: "entity-scoped",
  },
];
