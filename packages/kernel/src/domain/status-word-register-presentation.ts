import type { StatusWordRegistration } from "./status-vocabulary-types.ts";

export const presentationStatusWords: readonly StatusWordRegistration[] = [
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

  // ---- TaskCloseout.readiness (closeout judgment result) ----
  {
    word: "not_required",
    entity: "TaskCloseout",
    field: "readiness",
    meaning: "Closeout gate does not apply to this task.",
    divergence: "entity-scoped",
  },
  {
    word: "missing",
    entity: "TaskCloseout",
    field: "readiness",
    meaning: "Required closeout material is absent.",
    divergence: "entity-scoped",
  },
  {
    word: "incomplete",
    entity: "TaskCloseout",
    field: "readiness",
    meaning: "Closeout material exists but is not complete.",
    divergence: "entity-scoped",
  },
  {
    word: "ready",
    entity: "TaskCloseout",
    field: "readiness",
    meaning: "Closeout material is ready for the gate.",
    divergence: "entity-scoped",
  },
  {
    word: "passed",
    entity: "TaskCloseout",
    field: "readiness",
    meaning: "Completion gate witness passed.",
    divergence: "entity-scoped",
  },
  {
    word: "failed",
    entity: "TaskCloseout",
    field: "readiness",
    meaning: "Completion gate witness failed.",
    divergence: "entity-scoped",
  },

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
