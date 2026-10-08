import type { StatusWordRegistration } from "./status-vocabulary.ts";

/** CI observation terminology authorized by dec_605F9FBF CH1. */
export const ciStatusWordRegister: readonly StatusWordRegistration[] = [
  // dec_605F9FBF CH1: observation data, independent of completion verdicts.
  {
    word: "cancelled",
    entity: "CiTest",
    field: "status",
    meaning: "The observed test was cancelled before completion.",
    divergence: "entity-scoped",
  },
  {
    word: "timeout",
    entity: "CiFile",
    field: "outcome",
    meaning: "The parent watchdog observed the file exceed its deadline.",
    divergence: "entity-scoped",
  },
  {
    word: "hung",
    entity: "CiFile",
    field: "outcome",
    meaning: "An independent hang probe established a file hang.",
    divergence: "entity-scoped",
  },
  {
    word: "crashed",
    entity: "CiFile",
    field: "outcome",
    meaning: "The file failed before completing its test envelope.",
    divergence: "entity-scoped",
  },
  {
    word: "cancelled",
    entity: "CiFile",
    field: "outcome",
    meaning: "The shared runner terminated this file because another file exceeded its deadline.",
    divergence: "entity-scoped",
  },
  {
    word: "complete",
    entity: "CiMeasurement",
    field: "status",
    meaning: "The runner finished its observed measurement without missing file results.",
    divergence: "entity-scoped",
  },
  {
    word: "partial",
    entity: "CiMeasurement",
    field: "status",
    meaning: "The runner emitted a terminal package with explicitly missing measurement.",
    divergence: "entity-scoped",
  },
  {
    word: "unknown",
    entity: "CiMeasurement",
    field: "status",
    meaning: "The producer cannot establish measurement completeness.",
    divergence: "entity-scoped",
  },
  {
    word: "no-test-artifact",
    entity: "CiMeasurement",
    field: "status",
    meaning: "A workflow verdict contains no test measurement.",
    divergence: "entity-scoped",
  },
  // ---- CiTest.status (structured CI test observation) ----
  {
    word: "passed",
    entity: "CiTest",
    field: "status",
    meaning: "This observed CI test execution completed successfully.",
    divergence: "entity-scoped",
  },
  {
    word: "failed",
    entity: "CiTest",
    field: "status",
    meaning: "This observed CI test execution completed unsuccessfully.",
    divergence: "entity-scoped",
  },
  {
    word: "skipped",
    entity: "CiTest",
    field: "status",
    meaning: "The CI test was intentionally not executed.",
    divergence: "entity-scoped",
  },
];
