import type { TaskProjection } from "@harness-anything/kernel";
import { makeSquadCoordinator } from "./squad-coordinator.ts";
import { deriveSquadChildPlan, reacquireSquadTaskLease } from "./repo-cell-squad-child.ts";
import { withEdgeReadModel } from "./fleet-edge-task-read.ts";
import { runFleetEdgeTask } from "./fleet-edge-task.ts";
import { readFleetRepositoryMetadataClient, runFleetRuntimeEventClient, type FleetPeerOptions } from "./fleet/edge.ts";
import type { FleetEdgeRuntimeRequest } from "./fleet-edge-runtime.ts";
import type { makeRuntimeSpawner } from "./runtime-spawner.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";

/** Owner control uses the same coordinator, with task writes admitted by the center. */
export function makeFleetSquadCoordinator(input: {
  readonly request: FleetEdgeRuntimeRequest["payload"];
  readonly peer: FleetPeerOptions;
  readonly spawner: ReturnType<typeof makeRuntimeSpawner>;
  readonly controlBinding: RuntimeBinding;
  readonly sync: () => Promise<void>;
  readonly prepareWorkspace: () => Promise<void>;
  readonly readWorktreeSetup: () => readonly string[];
  readonly readResult: (ref: string) => string;
}) {
  const { request } = input;
  let principalId: string | undefined;
  const query = <T>(read: (projection: TaskProjection) => T): T =>
    withEdgeReadModel(
      { viewRoot: request.viewRoot, repoId: request.repoId, nodeId: request.nodeId, principalId },
      (projection) => read(projection as TaskProjection),
    );
  const command = async (action: Record<string, unknown> & { kind: string }): Promise<JsonObject> => {
    const receipt = await runFleetEdgeTask({ payload: { ...request, workspaceRoot: request.workspaceRoot, action } });
    if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes")
      throw Object.assign(new Error(JSON.stringify(receipt)), { code: receipt.code ?? "squad_control_failed" });
    return receipt as JsonObject;
  };
  const coordinator = makeSquadCoordinator({
    rootDir: request.workspaceRoot,
    query,
    readResult: input.readResult,
    readWorktreeSetup: input.readWorktreeSetup,
    publishObservation: async (observation) => {
      await runFleetRuntimeEventClient({
        ...input.peer,
        repoId: request.repoId,
        opId: `squad-observed-${observation.squadRunId}-${observation.runRevision}`,
        eventType: "runtime_squad_run_observed",
        payload: { ...observation },
      });
      await input.sync();
    },
    reacquireTaskLease: async (taskId, binding, parent) => {
      await input.sync();
      await reacquireSquadTaskLease({
        taskId,
        binding,
        ...(parent?.taskId === taskId ? { executionId: parent.executionId } : {}),
        snapshot: query((projection) => projection.read(taskId).snapshot),
        start: async (executionId) =>
          command({
            kind: "task-start",
            taskId,
            ...(parent ? { squadRunId: parent.squadRunId } : {}),
            ...(executionId ? { executionId } : {}),
          }) as Promise<{
            outcome: string;
          }>,
      });
      await input.sync();
    },
    releaseTaskLease: async (taskId, _binding, executionId, squadRunId) => {
      if (executionId)
        await command({
          kind: "task-release",
          taskId,
          executionId,
          squadRunId,
          reason: "Squad workers hold independent child leases.",
        });
    },
    createChildTask: async (child) => {
      const parentPlan = query((projection) => {
        const parent = projection.read(child.parentTaskId);
        return parent.packagePath
          ? (projection.readDocument(`${parent.packagePath}/task_plan.md`).document?.body ?? null)
          : null;
      });
      const receipt = await command({
        kind: "task-create",
        squadRunId: child.squadRunId,
        parentTaskId: child.parentTaskId,
        title: `Squad assignment for ${child.workerId}`,
        idempotencyKey: child.key,
        surfaces: child.ownedPaths,
        plan: deriveSquadChildPlan(parentPlan, child.prompt),
      });
      if (typeof receipt.taskId !== "string") throw new Error("Center Squad child receipt has no task id.");
      return receipt.taskId;
    },
    recordOwnershipCheck: async (child) => {
      await command({
        kind: "task-artifact-add",
        squadRunId: child.squadRunId,
        taskId: child.taskId,
        destination: `artifacts/reports/ownership-${child.executionId}.md`,
        content: `# Worker ownership check\n\n${JSON.stringify(child.check, null, 2)}\n`,
      });
    },
    publishSynthesisReport: async (report) => {
      await command({
        kind: "task-artifact-add",
        squadRunId: report.squadRunId,
        taskId: report.taskId,
        destination: report.reportPath,
        content: report.body,
      });
    },
    runtimeSpawner: () => ({
      spawn: async (payload, binding, onPrepared) => {
        const result = await input.spawner.spawnCoordinated(payload, binding, onPrepared);
        await input.sync();
        return result;
      },
      cancel: (payload, binding) => input.spawner.cancel(payload, binding),
    }),
  });
  async function binding(): Promise<RuntimeBinding> {
    const metadata = await readFleetRepositoryMetadataClient(input.peer);
    principalId = metadata.personId;
    return {
      actor: { principal: { personId: principalId }, executor: null },
      source: { kind: "node", nodeId: request.nodeId },
    };
  }
  return {
    async run(action: JsonObject): Promise<JsonObject> {
      const raw =
        action.kind === "squad-cancel"
          ? await coordinator.cancel(String(action.squadRunId), input.controlBinding)
          : await (async () => {
              const owner = await binding();
              await input.prepareWorkspace();
              await coordinator.reconcile();
              return coordinator.start(action, owner);
            })();
      return {
        schema: "squad-control-result/v1",
        command: String(action.kind),
        outcome: "completed",
        squadRunId: raw.squadRunId!,
        ...(raw.leaderRuntimeSessionId ? { leaderRuntimeSessionId: raw.leaderRuntimeSessionId } : {}),
        phase: raw.status!,
        summary: raw.summary!,
      };
    },
    flushPublications: coordinator.flushPublications,
    async reconcile(): Promise<void> {
      await binding();
      await input.sync();
      await coordinator.reconcile();
    },
  };
}
