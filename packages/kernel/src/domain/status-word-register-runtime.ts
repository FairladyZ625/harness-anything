import type { StatusWordRegistration } from "./status-vocabulary-types.ts";

export const runtimeAndRecoveryStatusWords: readonly StatusWordRegistration[] = [
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
      "(candidate: \"ended-unobserved\").",
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
];
