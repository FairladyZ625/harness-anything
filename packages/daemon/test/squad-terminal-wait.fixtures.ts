import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AgentDefinitionSnapshot, SquadRunObservation } from "@harness-anything/kernel";
import type { RepoCell, RepoCellBinding } from "../src/repo-cell.ts";

export type { SquadRunObservation };

export async function seedSquadWaitState(
  cell: RepoCell,
  repoId: string,
  state: Omit<SquadRunObservation, "ownerDispatchId">,
  binding: RepoCellBinding,
): Promise<void> {
  const key = `squad-wait:${state.squadRunId}`,
    hash = createHash("sha256").update(`${repoId}\0${key}`).digest("hex"),
    ownerDispatchId = `dispatch_${hash.slice(0, 24)}`;
  if (state.runRevision === 1) {
    if (state.subject.kind !== "task") throw new Error("squad wait fixture requires a task subject");
    const started = await cell.run(
      { kind: "task-start", taskId: state.subject.taskId, executionId: state.subject.executionId },
      binding,
    );
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const dispatched = await cell.runtimeIngress(
      {
        kind: "event",
        type: "runtime_dispatch_requested",
        opId: `runtime-spawn-${hash.slice(0, 32)}`,
        payload: {
          dispatchId: ownerDispatchId,
          runtimeSessionId: `runtime_${hash.slice(24, 48)}`,
          instanceId: "fixture-runtime",
          installationId: "fixture-installation",
          kindId: "codex",
          dispatchKey: key,
          definitionSnapshotRef: "artifact:runtime-definition/squad-wait",
          definitionSnapshot: {
            schema: "agent-definition-snapshot/v1",
            configVersion: 1,
            instanceId: "fixture-runtime",
            installationId: "fixture-installation",
            kindId: "codex",
            providerId: "openai",
            model: "fixture-model",
            reasoningEffort: null,
            baseUrl: null,
            authMode: "subscription",
          } satisfies AgentDefinitionSnapshot,
          taskId: state.subject.taskId,
          executionId: state.subject.executionId,
          agentId: state.leaderAgentId,
          squadId: state.squadId,
          squadRun: {
            squadRunId: state.squadRunId,
            squadId: state.squadId,
            subject: state.subject,
            mission: state.mission,
            leaderAgentId: state.leaderAgentId,
          },
        },
      },
      binding,
    );
    assert.equal(dispatched.outcome, "applied", JSON.stringify(dispatched));
  }
  const observed = await cell.runtimeIngress(
    {
      kind: "event",
      type: "runtime_squad_run_observed",
      opId: `squad-observed-${state.squadRunId}-${state.runRevision}`,
      payload: { ...state, ownerDispatchId },
    },
    binding,
  );
  assert.equal(observed.outcome, "applied", JSON.stringify(observed));
}
