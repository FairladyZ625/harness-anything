import { isSameExecution, type CanonicalEventStore, type TaskProjection } from "@harness-anything/kernel";
import type { EntityActionCatalogRuntimes } from "./entity-action-catalog-executor.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellActionContext, RepoCellRuntimeContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { publishTaskArtifact } from "./doc-sync-actions.ts";
import { operationId } from "./repo-cell-proof.ts";
import { settleScheduledRuntime } from "./schedule-action-runtime.ts";
import { makeSquadCoordinator } from "./squad-coordinator.ts";
import { readCanonicalRuntimeResult } from "./runtime-result-read.ts";
import { makeRuntimeSpawner } from "./runtime-spawn.ts";
import { requireSquadBusinessAction } from "./squad-runtime-ingress.ts";
import {
  createSquadChild,
  publishLocalSquadRunObservation,
  publishSquadChildDocument,
  reacquireSquadTaskLease,
  settleSquadChildAssignment,
} from "./repo-cell-squad-child.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";
import type { WorktreeSetupSettings } from "./worktree-setup.ts";

export function makeRepoCellSquadCoordinator(deps: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly now: () => string;
  readonly readWorktreeSetup: () => WorktreeSetupSettings;
  readonly projection: TaskProjection;
  readonly store: CanonicalEventStore;
  readonly runtimeContext: RepoCellRuntimeContext;
  readonly extracted: RepoCellActionContext;
  readonly runtimeSpawner: ReturnType<typeof makeRuntimeSpawner>;
  readonly entityActionExecutor: RepoCellActionContext["entityActionExecutor"];
  readonly entityActionRuntimes: EntityActionCatalogRuntimes;
  readonly authorizeRuntimeAction: (
    action: RepoTaskAction,
    binding: RuntimeBinding,
    actionId: string,
  ) => Promise<RepoCellBinding>;
  readonly onlineBinding: (binding: RepoCellBinding) => Promise<RepoCellBinding>;
  readonly killpoint?: (point: import("@harness-anything/kernel").EventPublicationKillpoint) => void;
}): ReturnType<typeof makeSquadCoordinator> {
  const {
    rootDir,
    repoId,
    now,
    readWorktreeSetup,
    projection,
    store,
    runtimeContext,
    extracted,
    runtimeSpawner,
    entityActionExecutor,
    entityActionRuntimes,
    authorizeRuntimeAction,
    onlineBinding,
    killpoint,
  } = deps;

  return makeSquadCoordinator({
    rootDir,
    now,
    readWorktreeSetup,
    query: (read) => read(projection),
    readResult: (ref) => readCanonicalRuntimeResult(store, ref),
    publishObservation: (observation, binding) =>
      publishLocalSquadRunObservation(extracted, observation, binding, authorizeRuntimeAction),
    createChildTask: async (child, binding) => createSquadChild(extracted, child, binding, authorizeRuntimeAction),
    settleScheduleOccurrence: (settlement, binding) =>
      settleScheduledRuntime(
        runtimeContext,
        {
          runtimeSessionId: settlement.runtimeSessionId,
          dispatchId: settlement.dispatchId,
          task: null,
          schedule: settlement.schedule,
          outcome: settlement.outcome,
          reason: settlement.reason,
          endedAt: settlement.endedAt,
          binding,
        },
        async (action, actionId) => {
          const authorized = await authorizeRuntimeAction(action, binding, actionId);
          return entityActionExecutor.run(
            action,
            authorized,
            operationId(action, authorized, repoId, 0),
            entityActionRuntimes,
          );
        },
      ),
    releaseTaskLease: async (taskId, binding, executionId, squadRunId) => {
      const lease = projection.currentLease(taskId, now());
      if (lease === null || lease.executionId !== executionId) return;
      if (!isSameExecution(lease.actor, binding.actor))
        throw cellCodedError("lease_conflict", `Squad cannot release another holder's lease for ${taskId}.`);
      const action = {
          kind: "task-release",
          taskId,
          executionId,
          squadRunId,
          reason: "Squad workers hold independent child leases.",
        },
        receipt = await extracted.taskSurfaceWrite(
          action,
          await authorizeRuntimeAction(action, binding, `squad-release:${taskId}:${lease.version}`),
        );
      if (receipt.outcome !== "applied")
        throw cellCodedError(receipt.code ?? "lease_conflict", `Squad could not release ${taskId}.`);
    },
    settleChildTask: (child, binding) => settleSquadChildAssignment(extracted, child, binding, authorizeRuntimeAction),
    recordOwnershipCheck: async (child, binding) => {
      const packagePath = projection.read(child.taskId).packagePath;
      if (!packagePath) throw cellCodedError("task_not_found", child.taskId);
      await publishSquadChildDocument(
        extracted,
        {
          parentTaskId: child.parentTaskId,
          squadRunId: child.squadRunId,
          taskId: child.taskId,
          path: `${packagePath}/artifacts/reports/ownership-${child.executionId}.md`,
          body: `# Worker ownership check\n\n${JSON.stringify(child.check, null, 2)}\n`,
        },
        binding,
        authorizeRuntimeAction,
      );
    },
    reacquireTaskLease: async (taskId, binding, parent) => {
      if (parent)
        requireSquadBusinessAction(projection, { kind: "squad-reacquire", squadRunId: parent.squadRunId }, binding);
      await reacquireSquadTaskLease({
        taskId,
        binding,
        snapshot: projection.read(taskId).snapshot as Snapshot,
        ...(parent && parent.subject.kind === "task" && parent.subject.taskId === taskId
          ? { executionId: parent.subject.executionId }
          : {}),
        start: async (executionId) => {
          extracted.assertTaskWipCapacity(taskId, "active");
          const action = { kind: "task-start", taskId, ...(executionId ? { executionId } : {}) },
            revision = store.readHead()?.revision ?? 0,
            authorizationDecision = await evaluateRepoCellAction({
              readTask: (taskId) => projection.read(taskId).snapshot.task,
              repoId: repoId,
              action,
              binding: await onlineBinding(binding),
              actionId: `squad-task-start:${taskId}:${revision}`,
              revision,
              now: now(),
            });
          if (authorizationDecision.outcome === "denied")
            throw cellCodedError(
              "authorization_denied",
              authorizationDecision.nextActions.join(" ") || "Squad lease reacquisition requires repo-write authority.",
            );
          return extracted.lifecycleAction(action, { ...binding, authorizationDecision });
        },
      });
    },
    publishSynthesisReport: async (report, binding) => {
      const action = { kind: "task-artifact-add", taskId: report.taskId, squadRunId: report.squadRunId },
        authorizedBinding = await authorizeRuntimeAction(
          action,
          binding,
          `squad-synthesis-report:${report.squadRunId}`,
        ),
        receipt = publishTaskArtifact(
          {
            binding: authorizedBinding,
            workspaceId: repoId,
            rootDir,
            store,
            projection,
            now,
            killpoint: killpoint,
          },
          {
            taskId: report.taskId,
            destination: report.reportPath,
            bytes: Buffer.from(report.body),
          },
        );
      if (receipt.outcome !== "applied" && receipt.outcome !== "pending")
        throw cellCodedError(
          receipt.code ?? "squad_report_publication_failed",
          `Squad synthesis report was ${receipt.outcome}.`,
        );
    },
    runtimeSpawner: () => ({
      spawn: async (payload, binding, onPrepared) => {
        const action = { kind: "runtime-spawn", ...payload },
          revision = store.readHead()?.revision ?? 0,
          authorizationDecision = await evaluateRepoCellAction({
            readTask: (taskId) => projection.read(taskId).snapshot.task,
            repoId: repoId,
            action,
            binding: await onlineBinding(binding),
            actionId: `squad-runtime-spawn:${String(payload.dispatchKey ?? "current")}:${revision}`,
            revision,
            now: now(),
          });
        if (authorizationDecision.outcome === "denied")
          return Promise.reject(
            cellCodedError(
              "authorization_denied",
              authorizationDecision.nextActions.join(" ") || "Squad runtime dispatch requires repo-write authority.",
            ),
          );
        return runtimeSpawner.spawnCoordinated(payload, { ...binding, authorizationDecision }, onPrepared);
      },
      // The schedule channel carries the occurrence claim as its trusted subject; the squad
      // leader payload stays the coordinator's, so the spawn stays inside the same authorization.
      spawnScheduled: async (payload, scheduled, binding, onPrepared) => {
        const action = { kind: "runtime-spawn", ...payload },
          revision = store.readHead()?.revision ?? 0,
          authorizationDecision = await evaluateRepoCellAction({
            readTask: (taskId) => projection.read(taskId).snapshot.task,
            repoId: repoId,
            action,
            binding: await onlineBinding(binding),
            actionId: `squad-runtime-spawn:${String(payload.dispatchKey ?? "current")}:${revision}`,
            revision,
            now: now(),
          });
        if (authorizationDecision.outcome === "denied")
          return Promise.reject(
            cellCodedError(
              "authorization_denied",
              authorizationDecision.nextActions.join(" ") || "Squad runtime dispatch requires repo-write authority.",
            ),
          );
        return runtimeSpawner.spawnScheduledCoordinated(
          payload,
          scheduled,
          { ...binding, authorizationDecision },
          onPrepared,
        );
      },
      cancel: async (payload, binding) => {
        const action = { kind: "runtime-cancel", ...payload },
          revision = store.readHead()?.revision ?? 0,
          authorizationDecision = await evaluateRepoCellAction({
            readTask: (taskId) => projection.read(taskId).snapshot.task,
            repoId: repoId,
            action,
            binding: await onlineBinding(binding),
            actionId: `squad-runtime-cancel:${String(payload.runtimeSessionId ?? "current")}:${revision}`,
            revision,
            now: now(),
          });
        if (authorizationDecision.outcome === "denied")
          return Promise.reject(
            cellCodedError(
              "authorization_denied",
              authorizationDecision.nextActions.join(" ") ||
                "Squad runtime cancellation requires repo-write authority.",
            ),
          );
        return runtimeSpawner.cancel(payload, { ...binding, authorizationDecision });
      },
    }),
  });
}
