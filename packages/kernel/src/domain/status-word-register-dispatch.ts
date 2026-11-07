import type { StatusWordRegistration } from "./status-vocabulary.ts";

/** Dispatch lifecycle vocabulary; each field has one canonical meaning. */
export const dispatchStatusWordRegister: readonly StatusWordRegistration[] = [
  ...["starting", "running", "settling", "waiting_backoff", "awaiting_ruling", "closed"].map((word) => ({
    word,
    entity: "Dispatch" as const,
    field: "group phase",
    meaning: `Dispatch group is in the ${word} lifecycle phase.`,
    divergence: "entity-scoped" as const,
  })),
  ...["starting", "running", "settling", "closed"].map((word) => ({
    word,
    entity: "Dispatch" as const,
    field: "attempt phase",
    meaning: `Dispatch attempt is in the ${word} lifecycle phase.`,
    divergence: "entity-scoped" as const,
  })),
  ...["succeeded", "failed", "cancelled", "stopped", "lost", "exhausted", "superseded", "unknown"].map((word) => ({
    word,
    entity: "Dispatch" as const,
    field: "outcome",
    meaning: `Dispatch attempt settled with outcome ${word}.`,
    divergence: "entity-scoped" as const,
  })),
  ...["busy", "recovering", "free"].map((word) => ({
    word,
    entity: "Dispatch" as const,
    field: "capacity disposition",
    meaning: `Dispatch capacity is ${word} to the lifecycle reader.`,
    divergence: "entity-scoped" as const,
  })),
  ...["ready", "pending"].map((word) => ({
    word,
    entity: "Dispatch" as const,
    field: "read status",
    meaning: `Dispatch lifecycle read is ${word}.`,
    divergence: "entity-scoped" as const,
  })),
];
