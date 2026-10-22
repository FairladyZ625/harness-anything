import { consumeKnownError, type SquadRunObservation, type TaskProjection } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord } from "./dispatch-stream.ts";
import { squadRunObservation } from "./squad-observation.ts";
import { squadScheduleSubject, terminal, type SquadState } from "./squad-run-state.ts";
import type { SquadScheduleSettlement } from "./squad-coordinator.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { errorText } from "./squad-coordinator-helpers.ts";

export function makeSquadPublicationController(input: {
  readonly rootDir: string;
  readonly now: () => string;
  readonly states: ReadonlyMap<string, SquadState>;
  readonly publicationAcks: Map<string, number>;
  readonly subjectCurrent: (state: SquadState) => boolean;
  readonly query: <T>(read: (projection: TaskProjection) => T) => T;
  readonly publishObservation: (observation: SquadRunObservation, binding: RuntimeBinding) => Promise<void>;
  readonly settleScheduleOccurrence: (settlement: SquadScheduleSettlement, binding: RuntimeBinding) => Promise<void>;
  readonly runtimeSpawner: () => {
    readonly cancel: (payload: JsonObject, binding: RuntimeBinding) => Promise<JsonObject>;
  };
}) {
  async function settleScheduleSubjectRun(state: SquadState): Promise<void> {
    const subject = squadScheduleSubject(state),
      schedule = state.scheduleRuntime;
    if (!subject || !schedule || !state.stateDispatchId) return;
    const firstTurn = state.leaderTurns[0];
    if (!firstTurn) return;
    try {
      await input.settleScheduleOccurrence(
        {
          schedule,
          outcome: state.phase === "converged" ? "succeeded" : state.phase === "cancelled" ? "cancelled" : "failed",
          reason: state.error,
          endedAt: input.now(),
          dispatchId: firstTurn.dispatchId,
          runtimeSessionId: firstTurn.runtimeSessionId,
        },
        state.binding,
      );
    } catch (error) {
      consumeKnownError(error);
      console.warn(
        `[squad] settling schedule occurrence ${subject.occurrenceId} of ${state.squadRunId} failed: ` +
          `${errorText(error)}; retrying on the next reconciliation.`,
      );
    }
  }

  async function publishState(state: SquadState): Promise<void> {
    if (state.revision === 0 || (input.publicationAcks.get(state.squadRunId) ?? -1) >= state.revision) return;
    if (state.phase === "failed") {
      for (const runtimeSessionId of new Set([
        ...state.leaderTurns.map((turn) => turn.runtimeSessionId),
        ...state.workerAttempts.flatMap((attempt) => (attempt.runtimeSessionId ? [attempt.runtimeSessionId] : [])),
      ])) {
        const session = input.query((projection) => projection.readRuntimeSession(runtimeSessionId));
        if (session && session.liveness !== "exited" && session.outcome === null)
          await input.runtimeSpawner().cancel({ runtimeSessionId }, state.binding);
      }
    }
    await input.publishObservation(squadRunObservation(state), state.binding);
    appendRuntimeWorkerRecord(input.rootDir, state.stateDispatchId!, {
      kind: "squad_run_publication_ack",
      squadRunId: state.squadRunId,
      revision: state.revision,
    });
    input.publicationAcks.set(state.squadRunId, state.revision);
  }

  async function settleEndedScheduleSubjects(): Promise<void> {
    for (const state of input.states.values()) {
      if (!terminal(state) || !squadScheduleSubject(state)) continue;
      await settleScheduleSubjectRun(state);
    }
  }

  async function flushPublications(): Promise<void> {
    for (const state of input.states.values()) {
      if (!terminal(state) && !input.subjectCurrent(state)) continue;
      await publishState(state);
    }
  }

  return { publishState, settleScheduleSubjectRun, settleEndedScheduleSubjects, flushPublications };
}
