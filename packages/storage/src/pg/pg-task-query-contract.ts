import type { TaskProjectionQueries } from "@harness-anything/kernel";

/** Methods backed by the current PostgreSQL source; extend with parity evidence as methods land. */
export const PG_TASK_QUERY_METHODS = [
  "readCut",
  "read",
  "list",
  "readDecision",
  "readFact",
  "readDecisions",
  "listDecisions",
  "searchFacts",
  "listDecisionAgendaPage",
  "currentLease",
  "currentLeaseForExecution",
  "readCanonicalEvents",
  "readScheduleEvents",
  "readReckoningEvents",
  "readScheduleOutputEvents",
  "readRuntimeSessionEvents",
] as const satisfies readonly (keyof TaskProjectionQueries)[];

export type PgTaskQueryMethod = (typeof PG_TASK_QUERY_METHODS)[number];
export type PgTaskQueryMethods = Pick<TaskProjectionQueries, PgTaskQueryMethod>;
