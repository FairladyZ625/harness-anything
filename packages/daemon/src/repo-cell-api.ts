import {
  assertCurrentWriter,
  projectDecisionReadiness,
  type TaskProjectionListQuery,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import { type PresetRunReceiptV1 } from "../../preset/src/index.ts";
import { readAgentEntityGuiProjection } from "./agent-entities.ts";
import { discoverAgentSkills } from "./agent-skills.ts";
import { readTaskDispatches } from "./dispatch-read.ts";
import { listProjectedTaskDocuments, readProjectedDocument } from "./doc-sync-actions.ts";
import { makeGitReadinessSource } from "./process-port.ts";
import {
  commandClassForAction,
  commandDescriptorForAction,
  type DaemonGuiReadResultMap,
  type DaemonTaskDispatchesPayload,
} from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { recoveryCommandPolicy } from "./recovery-state.ts";
import type { DaemonGuiReadHandlers, RepoCell, RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { admitRepoMode } from "./repo-mode.ts";
import { makeTaskQueryReadModel } from "./task-query-read.ts";
import { chainRepoCellWrite, repoCellTaskQueryJudgments } from "./repo-cell.ts";
import { executeVerticalScriptAction, publishExecutedVerticalScript } from "./vertical-script-actions.ts";
import { workspaceSummaryFromProjection } from "./workspace-summary-read.ts";

export function createRepoCellApi(context: any): RepoCell {
  const run = (action: RepoTaskAction, binding: RepoCellBinding, signal?: AbortSignal): Promise<WriteReceipt> => {
    const command = commandDescriptorForAction(action.kind),
      commandClass = command.commandClass,
      modeAdmission = admitRepoMode(context.mode, command, binding.source);
    if (!modeAdmission.ok)
      return Promise.resolve(
        context.rejected(
          context.operationId(action, binding, context.input.repoId, 0),
          modeAdmission.code,
          modeAdmission.nextAction,
        ),
      );
    if (context.state !== "attached") context.attemptRecovery();
    const recoveryCommand =
        context.state === "attached" ? null : recoveryCommandPolicy(action.kind, context.causeClass),
      recoveryCommandAllowed =
        recoveryCommand !== null && (recoveryCommand.settlesLatch || action.kind === "receipt-show");
    if (context.state !== "attached" && !recoveryCommandAllowed)
      return Promise.resolve(
        context.rejected(
          context.operationId(action, binding, context.input.repoId, 0),
          "repo_unavailable",
          context.latched(),
        ),
      );
    if (context.state === "attached" && commandClass !== "repo-read")
      try {
        context.recheckRuntime();
      } catch (error) {
        return Promise.resolve(context.failed(context.operationId(action, binding, context.input.repoId, 0), error));
      }
    const failAction = (error: unknown): WriteReceipt => {
      if (context.fatalCellError(error)) context.latchWith(error);
      return context.failed(
        context.errorOperationId(error) ?? context.operationId(action, binding, context.input.repoId, 0),
        error,
      );
    };
    const enqueuePublication = (execute: () => WriteReceipt | Promise<WriteReceipt>): Promise<WriteReceipt> => {
      context.queueDepth += 1;
      const pending = chainRepoCellWrite(context.tail, async () => {
        context.queueDepth -= 1;
        const queuedAdmission = admitRepoMode(context.mode, command, binding.source);
        if (!queuedAdmission.ok) throw context.cellCodedError(queuedAdmission.code, queuedAdmission.nextAction);
        if (context.state === "closed" || (context.state !== "attached" && !recoveryCommandAllowed))
          throw context.cellCodedError(
            "repo_unavailable",
            "RepoCell closed or changed state before this queued command could execute.",
          );
        if (context.state === "attached" && commandClass !== "repo-read") context.recheckRuntime();
        assertCurrentWriter(context.activeWriter, context.writerToken, context.input.repoId);
        context.activeWriterEpochGuard = binding.assertWriterEpoch ?? null;
        context.activeWriterEpochFence = binding.withWriterEpochFence ?? null;
        try {
          const receipt = context.withLayoutAdvisory(context.withHumanSummary(await execute()));
          if (recoveryCommand?.settlesLatch && receipt.outcome === "applied") {
            context.state = "attached";
            context.lastError = null;
            context.causeClass = null;
            context.recoveryUncertain = false;
            context.recoveryProbe.clear();
          }
          context.replica.kick();
          return receipt;
        } finally {
          context.activeWriterEpochGuard = null;
          context.activeWriterEpochFence = null;
        }
      });
      context.tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending.catch(failAction);
    };
    if (action.kind === "squad-run")
      return enqueuePublication(() => context.squadCoordinator.start(action, binding) as unknown as WriteReceipt);
    if (action.kind === "squad-status")
      return Promise.resolve(
        context.squadCoordinator.status(
          context.requiredCellText(action.squadRunId, "squadRunId"),
        ) as unknown as WriteReceipt,
      );
    if (action.kind === "script-run")
      return Promise.resolve()
        .then(() =>
          executeVerticalScriptAction({
            action,
            rootDir: context.rootDir,
            commitSha: context.store.currentCommit().sha,
            signal,
          }),
        )
        .then(
          (execution) =>
            enqueuePublication(() =>
              publishExecutedVerticalScript(
                {
                  binding,
                  workspaceId: context.input.repoId,
                  rootDir: context.rootDir,
                  store: context.store,
                  projection: context.projection,
                  now: context.now,
                  killpoint: context.input.killpoint,
                },
                execution,
              ),
            ),
          failAction,
        );
    return enqueuePublication(() => context.executeAction(action, { ...binding, commandClasses: [commandClass] }));
  };
  const presetRun: RepoCell["presetRun"] = async (action, binding) => {
    const command = commandDescriptorForAction(action.kind),
      commandClass = command.commandClass,
      reject = (code: string, nextAction: string): PresetRunReceiptV1 => ({
        schema: "preset-run-receipt/v1",
        runId: typeof action.runId === "string" ? action.runId : "run_invalid",
        outcome: "op_rejected",
        phase: "op_rejected",
        phases: ["op_rejected"],
        code,
        nextAction,
      }),
      admission = admitRepoMode(context.mode, command, binding.source);
    if (!admission.ok) return reject(admission.code, admission.nextAction);
    if (context.state !== "attached") context.attemptRecovery();
    if (context.state !== "attached") return reject("repo_unavailable", context.latched());
    if (commandClass === "repo-write")
      try {
        context.recheckRuntime();
      } catch (error) {
        return reject(context.cellErrorCode(error), context.cellErrorMessage(error));
      }
    const queuedAdmission = admitRepoMode(context.mode, command, binding.source);
    if (!queuedAdmission.ok) return reject(queuedAdmission.code, queuedAdmission.nextAction);
    return action.kind === "preset-run-status"
      ? context.presetProcess.status(context.requiredCellText(action.runId, "runId"))
      : action.kind === "preset-run-start"
        ? context.presetProcess.start(
            {
              presetId: context.requiredCellText(action.presetId, "presetId"),
              entrypoint: context.requiredCellText(action.entrypoint, "entrypoint"),
              ...(typeof action.taskId === "string" ? { taskId: action.taskId } : {}),
              ...(action.inputs && typeof action.inputs === "object" && !Array.isArray(action.inputs)
                ? { inputs: action.inputs as Readonly<Record<string, unknown>> }
                : {}),
              idempotencyKey: context.requiredCellText(action.idempotencyKey, "idempotencyKey"),
            },
            {
              admitProduce: (kind: string) => {
                try {
                  return commandClassForAction(kind) === "repo-write";
                } catch {
                  return false;
                }
              },
              publish: (produced: RepoTaskAction) => run(produced, binding),
            },
          )
        : reject("unsupported_command", "Use repo.preset.run.start or repo.preset.run.status.");
  };
  const readHandlers = {
    "repo.tasks.list": (payload: Readonly<Record<string, unknown>>) =>
      queryRead.guiTasks(taskListQueryFromPayload(payload)),
    "repo.agenda.read": (payload: Readonly<Record<string, unknown>>) =>
      queryRead.agenda(agendaQueryFromPayload(payload)),
    "repo.triadic.relationGraph": (payload: Readonly<Record<string, unknown>>) => relationGraphFromPayload(payload),
    "repo.task.dispatches": (payload: Readonly<Record<string, unknown>>) =>
      readTaskDispatches({
        rootDir: context.rootDir,
        projection: context.projection,
        ...taskDispatchesPayloadFromCell(payload),
      }),
    "repo.agent.entities.list": () =>
      readAgentEntityGuiProjection({
        kind: "agent-list",
        projection: context.projection,
      }),
    "repo.agent.entity.read": (payload: Readonly<Record<string, unknown>>) =>
      readAgentEntityGuiProjection({
        kind: "agent-inspect",
        entityId: context.requiredCellText(payload.agentId, "agentId"),
        projection: context.projection,
      }),
    "repo.agent.skills.list": () => ({
      schema: "agent-skill-catalog/v1" as const,
      ok: true as const,
      skills: discoverAgentSkills({ rootDir: context.rootDir }),
    }),
    "repo.squad.entities.list": () =>
      readAgentEntityGuiProjection({
        kind: "squad-list",
        projection: context.projection,
      }),
    "repo.squad.entity.read": (payload: Readonly<Record<string, unknown>>) =>
      readAgentEntityGuiProjection({
        kind: "squad-inspect",
        entityId: context.requiredCellText(payload.squadId, "squadId"),
        projection: context.projection,
      }),
    "repo.decisions.list": () => {
      const read = context.projection.listDecisions({}),
        source = makeGitReadinessSource(),
        projectHead = source.run(context.rootDir, ["rev-parse", "HEAD"]),
        readiness = projectDecisionReadiness(
          {
            rootDir: context.rootDir,
            commitSha: projectHead.ok ? projectHead.stdout : "",
            decisions: read.decisions,
          },
          source,
        );
      return {
        ok: true,
        decisions: read.decisions.map((decision: any, index: number) => ({
          ...decision,
          readiness: readiness[index]!,
        })),
        warnings: [],
      };
    },
    "repo.tasks.document.read": (payload) => readProjectedDocument(context.projection, payload),
    "repo.tasks.documents.list": (payload) => listProjectedTaskDocuments(context.projection, payload),
    "repo.agentRuntime.overview": (payload) => context.runtimeReads.overview(payload),
    "repo.agentRuntime.sessions.read": (payload) => context.runtimeReads.session(payload),
    "repo.agentRuntime.events.read": (payload) => context.runtimeReads.events(payload),
  } satisfies DaemonGuiReadHandlers;
  // Read handlers synchronously observe the current committed projection cut. Writes publish and
  // apply their new cut without yielding; long asynchronous preparation (for example a vertical
  // script) happens before publication. A read can therefore see the complete cut before or after
  // a write, never its partial state, without waiting behind the write tail.
  const read: RepoCell["read"] = async (method, payload = {}) => {
    if (context.state !== "attached") context.attemptRecovery();
    if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
    return context.dispatchRead(readHandlers, method, payload);
  };
  // Narrow/paged query payloads for the two wide GUI reads: an empty payload keeps the
  // unparameterized full result; any explicit facet takes the indexed narrow path.
  function taskListQueryFromPayload(payload: Readonly<Record<string, unknown>>): TaskProjectionListQuery {
    const common = queryPayloadFacets(payload, "repo.tasks.list");
    return {
      ...(common.status ? { status: common.status as TaskProjectionListQuery["status"] } : {}),
      ...(common.changedAfterRevision === undefined ? {} : { changedAfterRevision: common.changedAfterRevision }),
      ...(common.updatedAfter ? { updatedAfter: common.updatedAfter } : {}),
      ...(common.updatedBefore ? { updatedBefore: common.updatedBefore } : {}),
      ...(common.limit === undefined ? {} : { limit: common.limit }),
      ...(common.cursor ? { cursor: common.cursor } : {}),
    };
  }
  function agendaQueryFromPayload(payload: Readonly<Record<string, unknown>>): {
    readonly limit?: number;
    readonly cursor?: string;
  } {
    if (
      Object.keys(payload).some((field) => field !== "limit" && field !== "cursor") ||
      (payload.limit !== undefined &&
        (!Number.isSafeInteger(payload.limit) || Number(payload.limit) < 1 || Number(payload.limit) > 500)) ||
      (payload.cursor !== undefined && (typeof payload.cursor !== "string" || !payload.cursor))
    )
      throw context.cellCodedError("invalid_command", "Agenda accepts --limit 1..500 and a non-empty cursor only.");
    return {
      ...(payload.limit === undefined ? {} : { limit: Number(payload.limit) }),
      ...(typeof payload.cursor === "string" ? { cursor: payload.cursor } : {}),
    };
  }
  function taskDispatchesPayloadFromCell(payload: Readonly<Record<string, unknown>>): DaemonTaskDispatchesPayload {
    if (!Array.isArray(payload.taskIds)) return { taskId: context.requiredCellText(payload.taskId, "taskId") };
    const taskIds = payload.taskIds.map((taskId) => context.requiredCellText(taskId, "taskIds[]")),
      limit = payload.limit === undefined ? undefined : Number(payload.limit),
      cursor = payload.cursor === undefined ? undefined : context.requiredCellText(payload.cursor, "cursor");
    if (
      taskIds.length === 0 ||
      taskIds.length > 500 ||
      new Set(taskIds).size !== taskIds.length ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500))
    )
      throw context.cellCodedError(
        "invalid_command",
        "Task dispatch batch requires 1..500 unique task ids and an optional limit of 1..500.",
      );
    return {
      taskIds,
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    };
  }
  function taskListQueryFromAction(action: RepoTaskAction): TaskProjectionListQuery {
    return taskListQueryFromPayload(action);
  }
  function relationQueryFromAction(action: RepoTaskAction) {
    const common = queryPayloadFacets(
      {
        ...action,
        ...(action.state === undefined ? {} : { status: action.state }),
      },
      "repo.triadic.relationGraph",
    );
    return {
      ...(typeof action.entity === "string" ? { entity: action.entity } : {}),
      ...(typeof action.source === "string" ? { source: action.source } : {}),
      ...(typeof action.target === "string" ? { target: action.target } : {}),
      ...(typeof action.relationType === "string" ? { relationType: action.relationType } : {}),
      ...(typeof action.state === "string" ? { state: action.state } : {}),
      ...(common.updatedAfter ? { updatedAfter: common.updatedAfter } : {}),
      ...(common.updatedBefore ? { updatedBefore: common.updatedBefore } : {}),
      ...(common.limit === undefined ? {} : { limit: common.limit }),
      ...(common.cursor ? { cursor: common.cursor } : {}),
    };
  }
  function relationGraphFromPayload(
    payload: Readonly<Record<string, unknown>>,
  ): DaemonGuiReadResultMap["repo.triadic.relationGraph"] {
    const common = queryPayloadFacets(payload, "repo.triadic.relationGraph");
    if (!common.explicit) return queryRead.relationGraph();
    return queryRead.relationGraphPage({
      ...(common.status ? { state: common.status } : {}),
      ...(common.updatedAfter ? { updatedAfter: common.updatedAfter } : {}),
      ...(common.updatedBefore ? { updatedBefore: common.updatedBefore } : {}),
      ...(common.limit === undefined ? {} : { limit: common.limit }),
      ...(common.cursor ? { cursor: common.cursor } : {}),
    });
  }
  function queryPayloadFacets(
    payload: Readonly<Record<string, unknown>>,
    method: "repo.tasks.list" | "repo.triadic.relationGraph",
  ) {
    const status = typeof payload.status === "string" ? payload.status : undefined,
      changedAfterRevision =
        payload.changedAfterRevision === undefined ? undefined : Number(payload.changedAfterRevision),
      updatedAfter = typeof payload.updatedAfter === "string" ? payload.updatedAfter : undefined,
      updatedBefore = typeof payload.updatedBefore === "string" ? payload.updatedBefore : undefined,
      limit = payload.limit === undefined ? undefined : Number(payload.limit),
      cursor = typeof payload.cursor === "string" ? payload.cursor : undefined;
    if (
      changedAfterRevision !== undefined &&
      (method !== "repo.tasks.list" || !Number.isSafeInteger(changedAfterRevision) || changedAfterRevision < 0)
    )
      throw context.cellCodedError("invalid_command", "Task changedAfterRevision must be a non-negative integer.");
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500))
      throw context.cellCodedError("invalid_command", "Query limit must be an integer between 1 and 500.");
    if (
      [updatedAfter, updatedBefore].some((value) => value !== undefined && !Number.isFinite(Date.parse(value))) ||
      (updatedAfter && updatedBefore && updatedAfter > updatedBefore)
    )
      throw context.cellCodedError("invalid_command", "Query time window must use ordered ISO-8601 timestamps.");
    if (cursor !== undefined && !cursor) throw context.cellCodedError("invalid_command", "Query cursor is invalid.");
    const stateInvalid =
      status !== undefined &&
      !(
        method === "repo.tasks.list"
          ? ["planned", "active", "blocked", "in_review", "done", "cancelled"]
          : ["active", "edge_retired", "deleted"]
      ).includes(status);
    if (stateInvalid) throw context.cellCodedError("invalid_command", "Query status is invalid for this read.");
    return {
      explicit:
        status !== undefined ||
        changedAfterRevision !== undefined ||
        updatedAfter !== undefined ||
        updatedBefore !== undefined ||
        limit !== undefined ||
        cursor !== undefined,
      status,
      changedAfterRevision,
      updatedAfter,
      updatedBefore,
      limit,
      cursor,
    };
  }
  // The wide task queries live in task-query-read.ts so the daemon and the scale
  // harness share one real read implementation; the closeout/blocking domain
  // judgments stay consumed by the RepoCell composition root.
  const queryRead = makeTaskQueryReadModel({
    rootDir: context.rootDir,
    projection: context.projection,
    judgments: repoCellTaskQueryJudgments,
  });
  Object.assign(context.extracted, { taskListQueryFromAction, queryRead, relationQueryFromAction });
  const spawnRuntime: RepoCell["spawnRuntime"] = (payload, binding) => {
    const command = commandDescriptorForAction("runtime-run"),
      admission = admitRepoMode(context.mode, command, binding.source);
    if (!admission.ok) return Promise.reject(context.cellCodedError(admission.code, admission.nextAction));
    context.queueDepth += 1;
    const pending = chainRepoCellWrite(context.tail, () => {
      context.queueDepth -= 1;
      if (context.state !== "attached") context.attemptRecovery();
      const queuedAdmission = admitRepoMode(context.mode, command, binding.source);
      if (!queuedAdmission.ok) throw context.cellCodedError(queuedAdmission.code, queuedAdmission.nextAction);
      if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
      context.recheckRuntime();
      assertCurrentWriter(context.activeWriter, context.writerToken, context.input.repoId);
      return context.runtimeSpawner.spawn(payload, binding) as Promise<JsonObject>;
    });
    context.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    void pending.then(
      () => context.replica.kick(),
      () => context.replica.kick(),
    );
    return pending;
  };
  const cancelRuntime: RepoCell["cancelRuntime"] = (payload, binding) => {
    const command = commandDescriptorForAction("runtime-cancel"),
      admission = admitRepoMode(context.mode, command, binding.source);
    if (!admission.ok) return Promise.reject(context.cellCodedError(admission.code, admission.nextAction));
    context.queueDepth += 1;
    const pending = chainRepoCellWrite(context.tail, () => {
      context.queueDepth -= 1;
      if (context.state !== "attached") context.attemptRecovery();
      const queuedAdmission = admitRepoMode(context.mode, command, binding.source);
      if (!queuedAdmission.ok) throw context.cellCodedError(queuedAdmission.code, queuedAdmission.nextAction);
      if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
      context.recheckRuntime();
      assertCurrentWriter(context.activeWriter, context.writerToken, context.input.repoId);
      return context.runtimeSpawner.cancel(payload, binding) as Promise<JsonObject>;
    });
    context.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    void pending.then(
      () => context.replica.kick(),
      () => context.replica.kick(),
    );
    return pending;
  };
  const runtimeIngress: RepoCell["runtimeIngress"] = (action, binding) => {
    const command = commandDescriptorForAction("runtime-run"),
      admission = admitRepoMode(context.mode, command, binding.source);
    if (!admission.ok) return Promise.reject(context.cellCodedError(admission.code, admission.nextAction));
    context.queueDepth += 1;
    const pending = chainRepoCellWrite(context.tail, () => {
      context.queueDepth -= 1;
      if (context.state !== "attached") context.attemptRecovery();
      if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
      context.recheckRuntime();
      assertCurrentWriter(context.activeWriter, context.writerToken, context.input.repoId);
      binding.assertWriterEpoch?.();
      return context.appendRuntimeIngress(action, binding);
    });
    context.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    void pending.then(
      () => context.replica.kick(),
      () => context.replica.kick(),
    );
    return pending;
  };
  return {
    bootstrapReceipt: context.bootstrapReceipt,
    run,
    presetRun,
    spawnRuntime,
    cancelRuntime,
    runtimeIngress,
    catalog: context.catalog,
    terminal: context.terminal,
    read,
    workspaceSummary: () => workspaceSummaryFromProjection(context.projection),
    get replica() {
      return context.replica;
    },
    verifyReadiness: async () => {
      const projected = await read("repo.tasks.list"),
        ready = projected.status === "ready";
      if (!ready) throw context.cellCodedError("repo_unavailable", "RepoCell L2 projection is not ready.");
      return { cellState: "attached", l2State: "ready" };
    },
    attach: async (runtimeSessionId, afterCursor) => {
      await context.tail;
      if (context.state !== "attached") context.attemptRecovery();
      if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
      return context.runtimeStream.attach(runtimeSessionId, afterCursor);
    },
    runtime: context.runtimeStream,
    status: () => ({
      repoId: context.input.repoId,
      rootDir: context.rootDir,
      mode: context.mode,
      state: context.state,
      generation: context.generation,
      queueDepth: context.queueDepth,
      lastError: context.lastError,
      causeClass: context.causeClass,
      recoveryMs: context.recovery.elapsedMs,
    }),
    close: async () => {
      if (context.state === "closed") return;
      context.state = "closed";
      context.runtimeSpawner.close();
      await context.terminal.close();
      context.runtimeStream.close();
      await context.presetProcess.close();
      await context.tail;
      try {
        await context.store.drain();
      } finally {
        context.replica.close();
        context.projection.close();
        await context.lock.close();
      }
    },
  };
}
