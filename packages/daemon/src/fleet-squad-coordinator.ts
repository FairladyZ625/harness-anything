import type { TaskProjection } from "@harness-anything/kernel";
import { makeSquadCoordinator } from "./squad-coordinator.ts";
import { deriveSquadChildPlan, reacquireSquadTaskLease } from "./repo-cell-squad-child.ts";
import { withEdgeReadModel } from "./fleet-edge-task-read.ts";
import {
  readFleetRepositoryMetadataClient,
  runFleetRuntimeEventClient,
  type FleetPeerOptions,
} from "./fleet-edge-write.ts";
import { runFleetEdgeWrite } from "./fleet-edge-write.ts";
import type { FleetEdgeRuntimeRequest } from "./fleet-edge-runtime.ts";
import type { makeRuntimeSpawner } from "./runtime-spawner.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { WorktreeSetupSettings } from "./worktree-setup.ts";

/** Owner control uses the same coordinator, with task writes admitted by the center. */
export function makeFleetSquadCoordinator(input: {
  readonly request: Omit<FleetEdgeRuntimeRequest["payload"], "method" | "action">;
  readonly peer: FleetPeerOptions;
  readonly forwardTaskAction: (action: Record<string, unknown> & { kind: string }) => Promise<JsonObject>;
  readonly spawner: Pick<
    ReturnType<typeof makeRuntimeSpawner>,
    "spawnCoordinated" | "spawnScheduledCoordinated" | "cancel"
  >;
  readonly controlBinding: () => Promise<RuntimeBinding>;
  readonly sync: () => Promise<void>;
  readonly prepareWorkspace: () => Promise<void>;
  readonly readWorktreeSetup: () => WorktreeSetupSettings;
  readonly readResult: (ref: string) => string;
}) {
  let principalId: string | undefined;
  const query = <T>(read: (projection: TaskProjection) => T): T => {
    const request = input.request;
    return withEdgeReadModel(
      { viewRoot: request.viewRoot, repoId: request.repoId, nodeId: request.nodeId, principalId },
      (projection) => read(projection as TaskProjection),
    );
  };
  const command = async (action: Record<string, unknown> & { kind: string }): Promise<JsonObject> => {
    const receipt = await input.forwardTaskAction(action);
    if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes")
      // The center's receipt carries the child action's own evidence and message; only its stable
      // code crosses the edge boundary, so a remote's prose never lands in an edge operator's log.
      throw Object.assign(
        new Error(`The center refused this squad control action with code ${receipt.code ?? "squad_control_failed"}.`),
        { code: receipt.code ?? "squad_control_failed" },
      );
    return receipt as JsonObject;
  };
  const coordinator = makeSquadCoordinator({
    get rootDir() {
      return input.request.workspaceRoot;
    },
    now: () => new Date().toISOString(),
    query,
    readResult: input.readResult,
    readWorktreeSetup: input.readWorktreeSetup,
    publishObservation: async (observation) => {
      const request = input.request,
        peer = input.peer;
      await runFleetEdgeWrite({
        viewRoot: request.viewRoot,
        repoId: request.repoId,
        nodeId: request.nodeId,
        timeoutMs: peer.timeoutMs ?? 60_000,
        write: () =>
          runFleetRuntimeEventClient({
            ...peer,
            repoId: request.repoId,
            opId: `squad-observed-${observation.squadRunId}-${observation.runRevision}`,
            eventType: "runtime_squad_run_observed",
            payload: { ...observation },
          }),
      });
      await input.sync();
    },
    settleScheduleOccurrence: async () => {
      throw new Error("The fleet Squad coordinator does not settle schedule occurrences.");
    },
    reacquireTaskLease: async (taskId, binding, parent) => {
      await input.sync();
      await reacquireSquadTaskLease({
        taskId,
        binding,
        ...(parent && parent.subject.kind === "task" && parent.subject.taskId === taskId
          ? { executionId: parent.subject.executionId }
          : {}),
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
    settleChildTask: async (child) => {
      await input.sync();
      const lease = query((projection) => projection.read(child.taskId).snapshot).lease;
      if (lease) {
        await command({
          kind: "task-release",
          taskId: child.taskId,
          executionId: lease.executionId,
          squadRunId: child.squadRunId,
          reason: child.reason,
          ...(child.runtimeSessionId
            ? { terminalExecutionId: lease.executionId, terminalRuntimeSessionId: child.runtimeSessionId }
            : {}),
        });
      }
      await command({
        kind: "task-transition",
        taskId: child.taskId,
        status: "cancelled",
        force: true,
        squadRunId: child.squadRunId,
        reason: child.reason,
      });
      await input.sync();
    },
    createChildTask: async (child) => {
      const parentTaskId = child.parentTaskId;
      if (parentTaskId === null) throw new Error("A fleet Squad run cannot create parentless children.");
      const parentPlan = query((projection) => {
        const parent = projection.read(parentTaskId);
        return parent.packagePath
          ? (projection.readDocument(`${parent.packagePath}/task_plan.md`).document?.body ?? null)
          : null;
      });
      const receipt = await command({
        kind: "task-create",
        squadRunId: child.squadRunId,
        parentTaskId,
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
      spawnScheduled: (payload, scheduled, binding, onPrepared) =>
        input.spawner.spawnScheduledCoordinated(payload, scheduled, binding, onPrepared),
      cancel: (payload, binding) => input.spawner.cancel(payload, binding),
    }),
  });
  async function binding(): Promise<RuntimeBinding> {
    const request = input.request,
      metadata = await readFleetRepositoryMetadataClient(input.peer);
    principalId = metadata.personId;
    return {
      actor: { principal: { personId: principalId }, executor: null },
      source: { kind: "node", nodeId: request.nodeId },
    };
  }
  return {
    async run(action: JsonObject): Promise<JsonObject> {
      const owner = action.kind === "squad-cancel" ? await input.controlBinding() : await binding();
      principalId = owner.actor.principal.personId;
      const raw =
        action.kind === "squad-cancel"
          ? await coordinator.cancel(String(action.squadRunId), owner)
          : await (async () => {
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
    async flushPublications(): Promise<void> {
      await binding();
      await input.sync();
      await coordinator.flushPublications();
    },
    async reconcile(): Promise<void> {
      await binding();
      await input.sync();
      await coordinator.reconcile();
    },
  };
}
