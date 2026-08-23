import type { StatusWordRegistration } from "./status-vocabulary-types.ts";

export const executionAndRelationStatusWords: readonly StatusWordRegistration[] =
  [
    // ---- Execution.state (one execution of a task) ----
    {
      word: "active",
      entity: "Execution",
      field: "state",
      meaning: "Execution currently holds the work.",
      divergence: "divergent",
      resolution:
        "Coordination occupancy, not policy effect; stored in execution projections — CH2 proposal only.",
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

    // ---- RelationEdge.state (bookkeeping of an edge) ----
    {
      word: "active",
      entity: "RelationEdge",
      field: "state",
      meaning: "Edge is load-bearing (not edge_retired, not deleted).",
      divergence: "divergent",
      resolution:
        "Bookkeeping liveness, unrelated to the other `active` concepts (Task/Execution/Package); stored in relation records — CH2 proposal only.",
    },
    {
      word: "edge_retired",
      entity: "RelationEdge",
      field: "state",
      meaning: "Edge was retired in place; kept as audit history.",
      divergence: "entity-scoped",
    },
    {
      word: "deleted",
      entity: "RelationEdge",
      field: "state",
      meaning: "Edge record removed from the live document.",
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
      meaning:
        "Review requested rework; same concept the Execution state encodes.",
      divergence: "entity-scoped",
    },
    {
      word: "dismissed",
      entity: "Review",
      field: "verdict",
      meaning: "Review dismissed the submission as not reviewable.",
      divergence: "entity-scoped",
    },
  ];
