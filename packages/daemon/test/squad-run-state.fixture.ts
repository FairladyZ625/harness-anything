import { normalizeHistoricalSquadRunIdentity } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events";
import { readAllDispatchStreamSummaries } from "../src/dispatch-stream.ts";
import type { SquadState } from "../src/squad-run-state.ts";

export function latestSquadStates(rootDir: string): ReadonlyMap<string, SquadState> {
  const states = new Map<string, SquadState>();
  for (const stream of readAllDispatchStreamSummaries(rootDir)) {
    for (const record of stream.records) {
      if (record.kind === "squad_run_cancelled") {
        const squadRunId = record.squadRunId,
          revision = record.revision,
          current = typeof squadRunId === "string" ? states.get(squadRunId) : undefined;
        if (current && Number.isSafeInteger(revision) && current.revision < Number(revision))
          states.set(squadRunId as string, {
            ...current,
            currentLeaderRuntimeSessionId: null,
            workerWaits: [],
            pendingLeaderTriggers: [],
            phase: "cancelled",
            revision: Number(revision),
            error: null,
          });
        continue;
      }
      if (record.kind !== "squad_run_state") continue;
      const state = normalizeHistoricalSquadRunIdentity(record.state) as SquadState,
        current = states.get(state.squadRunId);
      if (!current || current.revision < state.revision) states.set(state.squadRunId, state);
    }
  }
  return states;
}
