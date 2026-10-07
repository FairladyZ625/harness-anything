import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import type { SquadState } from "../src/squad-run-state.ts";

export type { SquadState };

export function seedSquadWaitState(rootDir: string, state: SquadState): void {
  if (state.revision === 1)
    openDispatchStream(rootDir, {
      dispatchId: state.stateDispatchId!,
      taskId: state.taskId,
      executionId: "execution-squad",
      runtimeSessionId: "runtime-squad-leader",
      instanceId: state.runtimeInstanceId,
      startedAt: "2026-10-07T00:00:00.000Z",
    });
  appendRuntimeWorkerRecord(rootDir, state.stateDispatchId!, {
    kind: "squad_run_state",
    squadRunId: state.squadRunId,
    revision: state.revision,
    state,
  });
}
