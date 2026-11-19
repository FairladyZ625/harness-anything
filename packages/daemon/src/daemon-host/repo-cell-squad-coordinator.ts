import { isSameExecution } from "@harness-anything/kernel";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellBinding, RepoCellRuntimeContext, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { publishTaskArtifact } from "./doc-sync-actions.ts";
import { operationId } from "./repo-cell-proof.ts";
import { settleScheduledRuntime } from "./schedule-action-runtime.ts";
import { makeSquadCoordinator } from "./squad-coordinator.ts";
import { readCanonicalRuntimeResult } from "./runtime-result-read.ts";
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

export function makeRepoCellSquadCoordinator(
  cell: RepoCellRuntimeContext,
  deps: {
    readonly readWorktreeSetup: () => WorktreeSetupSettings;
    readonly authorizeRuntimeAction: (
      action: RepoTaskAction,
      binding: RuntimeBinding,
      actionId: string,
    ) => Promise<RepoCellBinding>;
    readonly onlineBinding: (binding: RepoCellBinding) => Promise<RepoCellBinding>;
  },
): ReturnType<typeof makeSquadCoordinator> {
  const { readWorktreeSetup, authorizeRuntimeAction, onlineBinding } = deps,
    repoId = cell.input.repoId;

  return makeSquadCoordinator({
    rootDir: cell.rootDir,
    now: cell.now,
    readWorktreeSetup,
    query: (read) => read(cell.projection),
    readResult: (ref) => readCanonicalRuntimeResult(cell.store, ref),
    publishObservation: (observation, binding) =>
      publishLocalSquadRunObservation(cell, observation, binding, authorizeRuntimeAction),
    createChildTask: async (child, binding) => createSquadChild(cell, child, binding, authorizeRuntimeAction),
    settleScheduleOccurrence: (settlement, binding) =>
      settleScheduledRuntime(
        cell,
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
          return cell.entityActionExecutor.run(
            action,
            authorized,
            operationId(action, authorized, repoId, 0),
            cell.entityActionRuntimes,
          );
        },
      ),
    releaseTaskLease: async (taskId, binding, executionId, squadRunId) => {
      const lease = cell.projection.currentLease(taskId, cell.now());
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
        receipt = await cell.taskSurfaceWrite(
          action,
          await authorizeRuntimeAction(action, binding, `squad-release:${taskId}:${lease.version}`),
        );
      if (receipt.outcome !== "applied")
        throw cellCodedError(receipt.code ?? "lease_conflict", `Squad could not release ${taskId}.`);
    },
    settleChildTask: (child, binding) => settleSquadChildAssignment(cell, child, binding, authorizeRuntimeAction),
    recordOwnershipCheck: async (child, binding) => {
      const packagePath = cell.projection.read(child.taskId).packagePath;
      if (!packagePath) throw cellCodedError("task_not_found", child.taskId);
      await publishSquadChildDocument(
        cell,
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
        requireSquadBusinessAction(
          cell.projection,
          { kind: "squad-reacquire", squadRunId: parent.squadRunId },
          binding,
        );
      await reacquireSquadTaskLease({
        taskId,
        binding,
        snapshot: cell.projection.read(taskId).snapshot as Snapshot,
        ...(parent && parent.subject.kind === "task" && parent.subject.taskId === taskId
          ? { executionId: parent.subject.executionId }
          : {}),
        start: async (executionId) => {
          cell.assertTaskWipCapacity(taskId, "active");
          const action = { kind: "task-start", taskId, ...(executionId ? { executionId } : {}) },
            revision = cell.store.readHead()?.revision ?? 0,
            authorizationDecision = await evaluateRepoCellAction({
              readTask: (id) => cell.projection.read(id).snapshot.task,
              repoId,
              action,
              binding: await onlineBinding(binding),
              actionId: `squad-task-start:${taskId}:${revision}`,
              revision,
              now: cell.now(),
            });
          if (authorizationDecision.outcome === "denied")
            throw cellCodedError(
              "authorization_denied",
              authorizationDecision.nextActions.join(" ") || "Squad lease reacquisition requires repo-write authority.",
            );
          return cell.lifecycleAction(action, { ...binding, authorizationDecision });
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
            rootDir: cell.rootDir,
            store: cell.store,
            projection: cell.projection,
            now: cell.now,
            killpoint: cell.input.killpoint,
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
          revision = cell.store.readHead()?.revision ?? 0,
          authorizationDecision = await evaluateRepoCellAction({
            readTask: (taskId) => cell.projection.read(taskId).snapshot.task,
            repoId,
            action,
            binding: await onlineBinding(binding),
            actionId: `squad-runtime-spawn:${String(payload.dispatchKey ?? "current")}:${revision}`,
            revision,
            now: cell.now(),
          });
        if (authorizationDecision.outcome === "denied")
          return Promise.reject(
            cellCodedError(
              "authorization_denied",
              authorizationDecision.nextActions.join(" ") || "Squad runtime dispatch requires repo-write authority.",
            ),
          );
        return cell.runtimeSpawner.spawnCoordinated(payload, { ...binding, authorizationDecision }, onPrepared);
      },
      // The schedule channel carries the occurrence claim as its trusted subject; the squad
      // leader payload stays the coordinator's, so the spawn stays inside the same authorization.
      spawnScheduled: async (payload, scheduled, binding, onPrepared) => {
        const action = { kind: "runtime-spawn", ...payload },
          revision = cell.store.readHead()?.revision ?? 0,
          authorizationDecision = await evaluateRepoCellAction({
            readTask: (taskId) => cell.projection.read(taskId).snapshot.task,
            repoId,
            action,
            binding: await onlineBinding(binding),
            actionId: `squad-runtime-spawn:${String(payload.dispatchKey ?? "current")}:${revision}`,
            revision,
            now: cell.now(),
          });
        if (authorizationDecision.outcome === "denied")
          return Promise.reject(
            cellCodedError(
              "authorization_denied",
              authorizationDecision.nextActions.join(" ") || "Squad runtime dispatch requires repo-write authority.",
            ),
          );
        return cell.runtimeSpawner.spawnScheduledCoordinated(
          payload,
          scheduled,
          { ...binding, authorizationDecision },
          onPrepared,
        );
      },
      cancel: async (payload, binding) => {
        const action = { kind: "runtime-cancel", ...payload },
          revision = cell.store.readHead()?.revision ?? 0,
          authorizationDecision = await evaluateRepoCellAction({
            readTask: (taskId) => cell.projection.read(taskId).snapshot.task,
            repoId,
            action,
            binding: await onlineBinding(binding),
            actionId: `squad-runtime-cancel:${String(payload.runtimeSessionId ?? "current")}:${revision}`,
            revision,
            now: cell.now(),
          });
        if (authorizationDecision.outcome === "denied")
          return Promise.reject(
            cellCodedError(
              "authorization_denied",
              authorizationDecision.nextActions.join(" ") ||
                "Squad runtime cancellation requires repo-write authority.",
            ),
          );
        return cell.runtimeSpawner.cancel(payload, { ...binding, authorizationDecision });
      },
    }),
  });
}
