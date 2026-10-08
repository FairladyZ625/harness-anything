import { appendSquadRunObservation } from "./repo-cell-squad-child.ts";
import { makeSquadCanonicalReader } from "./squad-canonical-read.ts";
import { readCanonicalRuntimeResult } from "./runtime-result-read.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveHarnessLayout, sha256Bytes } from "@harness-anything/kernel";
import { writeFileDurably, removeFileDurably } from "./durable-file.ts";
import { queryPayloadFacets as sharedQueryPayloadFacets, taskListQueryFromPayload } from "./repo-query-payload.ts";
import { runRuntimeHandoff } from "./runtime-handoff.ts";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";
import {
  issueRuntimeExecutionCredential,
  runtimeExecutionLifetimeMs,
  readRuntimeExecutionPrincipal,
  runtimeExecutionActor,
} from "./runtime-execution-credential.ts";
import { assertWriterEpochFenceDescriptor } from "./writer-epoch.ts";
import { reconcileCiOccurrence } from "./ci-observe-importer.ts";
import { preparedCiObservation } from "./ci-observation-actions.ts";
import {
  builtinCiObserveScheduleId,
  executeBuiltinScheduleOccurrence,
  type BuiltinExecutorCell,
} from "./schedule-builtin-executor.ts";
import { readTaskCompletion } from "./task-completion-read.ts";
import { readTaskRuntimeContext } from "./task-runtime-context-read.ts";
import { enqueueRuntimePublication } from "./runtime-publication-queue.ts";
import { isSquadControlCommand, isSquadControlResult, squadControlRejected } from "./squad-control-result.ts";
import type { RepoCellCore } from "./repo-cell.ts";
import { daemonSettingsRead } from "./protocol/daemon-settings-read-types.ts";
import { settingsLastChanged } from "./repo-cell-settings-state.ts";
import { settleWriteReceipt } from "./write-receipt-settlement.ts";
import { repoCellStatus, repoCellStatusCuts } from "./repo-cell-status.ts";
import {
  assertCurrentWriter,
  buildVerticalDeclarationRead,
  buildEntityKindCatalog,
  deriveUseCaseProjectionInputs,
  durablePolicyActions,
  projectDecisionReadiness,
  relationDirections,
  relationStates,
  relationTypes,
  runtimeSessionActionIds,
  type CanonicalEventStore,
  type DaemonRepoMode,
  type EventPublicationKillpoint,
  type TaskProjection,
  type TaskProjectionListQuery,
  type ScheduleV1,
  type WriteReceipt,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import { type PresetRunReceiptV1, type createPresetProcessService } from "@harness-anything/preset";
import { readAgentEntityGuiProjection } from "./agent-entities.ts";
import { makeRepoCellCommandRunner } from "./repo-cell-command-run.ts";
import {
  canonicalVertical,
  compiledArtifactKinds,
  describeCurrentArtifact,
  resolveEntityReadKind,
} from "./artifact-entity-action.ts";
import { requireCanonicalVerticalDeclaration } from "./vertical-declaration-action.ts";
import { readDeclaredEntityRows } from "./entity-rows-read.ts";
import { readEntityContent, type EntityContentSource } from "./entity-content-read.ts";
import { readEntityLocator } from "./entity-locator-read.ts";
import { readAgentSkillsGui } from "./agent-skills.ts";
import { readTaskDispatches } from "./dispatch-read.ts";
import { decisionFullListRows, decisionReviewSummaryRow } from "./decision-review-read.ts";
import { agentRuntimeTokenUsageReadHandlers } from "./agent-runtime-token-usage.ts";
import {
  admitUseCaseProjectionSelector,
  type DaemonUseCaseProjectionResult,
} from "./protocol/daemon-protocol-gui-types.ts";
import { listProjectedTaskDocuments, readProjectedDocument } from "./doc-sync-actions.ts";
import { readArtifactsGui } from "./artifacts-gui-read.ts";
import { makeGitReadinessSource } from "./process-port.ts";
import { readObserveTail } from "./observe-tail.ts";
import { readSchedulesGui } from "./schedules-gui-read.ts";
import { readScheduleRuns } from "./schedule-runs-read.ts";
import { readRepoInFlightWork } from "./repo-in-flight-work.ts";
import {
  commandDescriptorForAction,
  type DaemonDecisionListResult,
  type DaemonGuiReadResultMap,
  type DaemonRelationGraphFacetPayload,
  type CanonicalRoot,
} from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type {
  DaemonGuiReadHandlers,
  RepoCell,
  RepoCellBinding,
  RepoCellReadMethod,
  RepoTaskAction,
} from "./repo-cell-types.ts";
import { evaluateRepoCellAction, bindVerifiedExecutorClaim } from "./repo-cell-authorization.ts";
import { admitRepoMode } from "./repo-mode.ts";
import { makeTaskQueryReadModel } from "./task-query-read.ts";
import { chainRepoCellWrite, repoCellTaskQueryJudgmentsFor } from "./repo-cell.ts";
import { workspaceSummaryFromProjection } from "./workspace-summary-read.ts";
import { workspaceScopeFromProjection } from "./workspace-scope-read.ts";
import { workIndexFromProjection } from "./work-read.ts";
import { readCiObservatory } from "./ci-observatory-read.ts";
import type { RepoCellOperationalContext, RepoCellSettingsState } from "./repo-cell-action-context.ts";
import type { makeRecoveryProbe } from "./recovery-state.ts";
import type { makeRuntimeSpawner } from "./runtime-spawn.ts";
import type { makeSquadCoordinator } from "./squad-coordinator.ts";
import type { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import type { AgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import type { RepoBootstrapReceipt } from "./repo-bootstrap.ts";
import { explainAuthenticationRequired, readTaskActionExplanation } from "./task-action-explanation-read.ts";
import { commitRuntimeSessionAction } from "./runtime-session-action-runtime.ts";
import { readTaskWipSnapshot, type TaskQueryCell } from "./repo-cell-task-query.ts";
import { agendaQueryFromPayload, taskDispatchesPayloadFromCell } from "./repo-cell-read-payloads.ts";

export interface RepoCellApiContext {
  readonly extracted: RepoCellOperationalContext;
  readonly mode: DaemonRepoMode;
  readonly input: {
    readonly repoId: string;
    readonly runtimeDaemonRoute?: import("./runtime-spawn.ts").RuntimeDaemonRoute;
    readonly killpoint?: (point: EventPublicationKillpoint) => void;
    readonly runtimeInstances?: RepoCellOperationalContext["input"]["runtimeInstances"];
  };
  readonly rejected: RepoCellOperationalContext["rejected"];
  readonly operationId: RepoCellOperationalContext["operationId"];
  readonly failed: RepoCellOperationalContext["failed"];
  readonly fatalCellError: (error: unknown) => boolean;
  readonly errorOperationId: RepoCellOperationalContext["errorOperationId"];
  readonly cellCodedError: RepoCellOperationalContext["cellCodedError"];
  readonly requiredCellText: RepoCellOperationalContext["requiredCellText"];
  readonly dispatchRead: typeof import("./repo-cell-command.ts").dispatchRead;
  state: RepoCell["status"] extends () => infer Status
    ? Status extends { readonly state: infer State }
      ? State
      : never
    : never;
  readonly attemptRecovery: (force?: boolean) => Promise<void>;
  causeClass: ReturnType<RepoCell["status"]>["causeClass"];
  readonly latched: () => string;
  readonly latchWith: (error: unknown) => void;
  queueDepth: number;
  tail: Promise<void>;
  readonly activeWriter: Parameters<typeof assertCurrentWriter>[0];
  readonly writerToken: Parameters<typeof assertCurrentWriter>[1];
  activeWriterEpochFence: (<T>(operation: () => T) => T) | null;
  activeWriterEpochFenceDescriptor: NonNullable<RepoCellBinding["writerEpochFence"]> | null;
  readonly withHumanSummary: (receipt: WriteReceiptDraft) => WriteReceiptDraft;
  lastError: string | null;
  recoveryUncertain: boolean;
  readonly recoveryProbe: ReturnType<typeof makeRecoveryProbe>;
  readonly replica: RepoCell["replica"];
  readonly rootDir: CanonicalRoot;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly executeAction: RepoCellOperationalContext["executeAction"];
  readonly squadCoordinator: ReturnType<typeof makeSquadCoordinator>;
  readonly presetProcess: ReturnType<typeof createPresetProcessService>;
  readonly runtimeReads: ReturnType<typeof makeAgentRuntimeReadModel>;
  readonly runtimeSpawner: ReturnType<typeof makeRuntimeSpawner>;
  /** Resolves when the session's projected outcome is settled per the domain settle predicate. */
  readonly awaitRuntimeOutcome: (runtimeSessionId: string) => Promise<void>;
  /** Resolves on the next runtime signal/outcome notification or the settlement grace backstop. */
  readonly awaitRuntimeSignal: () => Promise<void>;
  readonly settings: RepoCellSettingsState;
  readonly appendAuxiliaryRuntimeIngress: RepoCellOperationalContext["appendAuxiliaryRuntimeIngress"];
  bootstrapReceipt: RepoBootstrapReceipt | undefined;
  readonly catalog: RepoCell["catalog"];
  readonly terminal: RepoCell["terminal"];
  readonly runtimeStream: AgentRuntimeStreamHub;
  readonly generation: number;
  readonly recovery: RepoCellCore["recovery"];
  readonly lock: { readonly close: () => Promise<void> };
}

export const repoCellSynchronousRead = Symbol("repoCellSynchronousRead");

export interface RepoCellSynchronousRead {
  readonly [repoCellSynchronousRead]: <M extends RepoCellReadMethod>(
    method: M,
    payload?: Readonly<Record<string, unknown>>,
    binding?: RepoCellBinding,
  ) => DaemonGuiReadResultMap[M];
}

export function createRepoCellApi(apiContext: RepoCellApiContext): RepoCell & RepoCellSynchronousRead {
  const context = Object.assign(apiContext, { refreshCi });
  const bindExecutorClaimAtWriterCut = (action: RepoTaskAction, binding: RepoCellBinding) => {
    if (action.executor == null || !(durablePolicyActions as readonly string[]).includes(action.kind))
      return {
        queued: false as const,
        result: bindVerifiedExecutorClaim({ action, binding, projection: context.projection, now: context.now() }),
      };
    context.queueDepth += 1;
    const pending = chainRepoCellWrite(context.tail, () => {
      context.queueDepth -= 1;
      return bindVerifiedExecutorClaim({ action, binding, projection: context.projection, now: context.now() });
    });
    context.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return { queued: true as const, result: pending };
  };
  const ciRequests: RepoTaskAction[] = [];
  let ciRefresh: Promise<WriteReceipt> | null = null;
  async function refreshCi(action: RepoTaskAction, binding: RepoCellBinding): Promise<WriteReceipt> {
    const schedule = context.projection.getEntity("schedule", builtinCiObserveScheduleId)?.value as
      | ScheduleV1
      | undefined;
    if (!schedule)
      throw context.cellCodedError(
        "schedule_target_unconfigured",
        "Run authenticated ha init --configure-only to seed the center CI Schedule.",
      );
    // A forwarded edge refresh never claims a builtin. The center cadence is its collection owner.
    if (typeof binding.source === "object" && binding.source.kind === "node")
      return context.withHumanSummary({
        outcome: "pending",
        opId: `ci-refresh:${schedule.scheduleId}`,
        revision: context.store.readHead()?.revision ?? 0,
        evidence: `Center CI Schedule ${schedule.scheduleId} will reconcile the requested witness.`,
      }) as WriteReceipt;
    ciRequests.push(action);
    if (ciRefresh) return ciRefresh;
    if (schedule.status.activeRun) {
      const running = builtinRuns.get(schedule.status.activeRun.claimFence);
      if (running) return running;
      // In-process executors cannot survive reopening this RepoCell. Settle only its current fence.
      const recovered = await run(
        {
          kind: "schedule-settle",
          scheduleId: schedule.scheduleId,
          claimFence: schedule.status.activeRun.claimFence,
          outcome: "unknown",
          endedAt: context.now(),
          detail: "CI executor absent after center restart; resume durable reconciliation.",
          idempotencyKey: `ci-recover:${schedule.status.activeRun.claimFence}`,
        },
        binding,
      );
      if (isSquadControlResult(recovered) || recovered.outcome !== "applied")
        throw context.cellCodedError("schedule_claim_stale", "The orphan CI claim could not be settled.");
    }
    ciRefresh = runCommand(
      { kind: "schedule-run-now", scheduleId: schedule.scheduleId, idempotencyKey: `ci-refresh:${randomUUID()}` },
      binding,
    )
      .then((receipt) => {
        if (isSquadControlResult(receipt))
          throw context.cellCodedError("invalid_command", "CI refresh requires a write receipt.");
        return receipt;
      })
      .finally(() => {
        ciRefresh = null;
      });
    return ciRefresh;
  }
  const run = makeRepoCellCommandRunner(context);
  const presetRun: RepoCell["presetRun"] = async (action, binding) => {
    const bound = bindExecutorClaimAtWriterCut(action, binding);
    ({ action, binding } = bound.queued ? await bound.result : bound.result);
    const command = commandDescriptorForAction(action.kind),
      authorizationDecision =
        action.kind === "preset-run-start"
          ? await evaluateRepoCellAction({
              action,
              binding,
              repoId: context.input.repoId,
              actionId: context.operationId(
                action,
                binding,
                context.input.repoId,
                context.store.readHead()?.revision ?? 0,
              ),
              revision: context.store.readHead()?.revision ?? 0,
              now: context.now(),
            })
          : undefined,
      reject = (code: string): PresetRunReceiptV1 => ({
        schema: "preset-run-receipt/v1",
        runId: typeof action.runId === "string" ? action.runId : "run_invalid",
        outcome: "op_rejected",
        phase: "op_rejected",
        phases: ["op_rejected"],
        code,
        ...(authorizationDecision ? { authorizationDecision } : {}),
      }),
      admission = admitRepoMode(context.mode, command, binding.source);
    if (authorizationDecision?.outcome === "denied") return reject("authorization_denied");
    if (!admission.ok) return reject(admission.code);
    if (context.state !== "attached") await context.attemptRecovery();
    if (context.state !== "attached") return reject("repo_unavailable");
    const queuedAdmission = admitRepoMode(context.mode, command, binding.source);
    if (!queuedAdmission.ok) return reject(queuedAdmission.code);
    return action.kind === "preset-run-status"
      ? context.presetProcess.status(context.requiredCellText(action.runId, "runId"))
      : action.kind === "preset-run-start"
        ? context.presetProcess
            .start(
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
                    return (durablePolicyActions as readonly string[]).includes(kind);
                  } catch {
                    return false;
                  }
                },
                publish: async (produced: RepoTaskAction) => {
                  const receipt = await run(produced, binding);
                  if (isSquadControlResult(receipt))
                    throw context.cellCodedError(
                      "invalid_preset_receipt",
                      "Preset-produced writes require a write receipt.",
                    );
                  if (receipt.outcome === "no_changes")
                    throw context.cellCodedError(
                      "invalid_preset_receipt",
                      "Preset-produced writes cannot settle as no_changes.",
                    );
                  return {
                    outcome: receipt.outcome,
                    ...(receipt.code ? { code: receipt.code } : {}),
                  };
                },
              },
            )
            .then((receipt) => ({ ...receipt, authorizationDecision: authorizationDecision! }))
        : reject("unsupported_command");
  };
  let readinessCache:
    | {
        readonly key: string;
        readonly rows: ReturnType<typeof projectDecisionReadiness>;
      }
    | undefined;
  const readHandlers = {
    "repo.ci.observatory.read": (payload: Readonly<Record<string, unknown>>) =>
      readCiObservatory({
        readContentBlob: context.store.readContentBlob,
        rootDir: context.rootDir,
        projection: context.projection,
        ...(payload.window === undefined ? {} : { window: Number(payload.window) }),
      }),
    // settings 原样返回(含 locale);values 为 kernel 拍平的动作值面(键 = 契约字段)。
    "repo.settings.read": () => daemonSettingsRead(context.settings.read(), settingsLastChanged(context.projection)),
    "repo.tasks.list": (payload: Readonly<Record<string, unknown>>) =>
      queryRead().guiTasks(taskListQueryFromPayload(payload, context.cellCodedError)),
    "repo.tasks.wip": () => readTaskWipSnapshot(context as unknown as TaskQueryCell),
    "repo.works.index": () => workIndexFromProjection(context.projection),
    "repo.workspace.summary.read": () => workspaceSummaryFromProjection(context.projection),
    "repo.workspace.scope.read": (payload) =>
      workspaceScopeFromProjection(context.projection, {
        rootTaskId: context.requiredCellText(payload.rootTaskId, "rootTaskId"),
        ...(payload.limit === undefined ? {} : { limit: Number(payload.limit) }),
        ...(payload.cursor === undefined ? {} : { cursor: String(payload.cursor) }),
      }),
    "repo.projection.read": (payload: Readonly<Record<string, unknown>>) => useCaseProjection(payload),
    "repo.entity.actions.explain": explainAuthenticationRequired,
    "repo.vertical.declaration.read": () =>
      buildVerticalDeclarationRead(requireCanonicalVerticalDeclaration(context.projection)),
    "repo.entity.kinds.read": () => {
      const vertical = canonicalVertical(context.projection, context.input.repoId);
      return buildEntityKindCatalog(vertical.contract.artifactKinds, vertical.revision);
    },
    "repo.entity.rows.read": () =>
      readDeclaredEntityRows({
        catalog: buildEntityKindCatalog(
          compiledArtifactKinds(context.projection, context.input.repoId),
          canonicalVertical(context.projection, context.input.repoId).revision,
        ),
        projection: context.projection,
        runtimeInstances: context.input.runtimeInstances ?? (() => []),
      }),
    "repo.entity.locator.read": (payload: Readonly<Record<string, unknown>>) =>
      readEntityLocator({
        rootDir: context.rootDir,
        locatorKind: context.requiredCellText(payload.locatorKind, "locatorKind"),
        locatorValue: context.requiredCellText(payload.locatorValue, "locatorValue"),
      }),
    "repo.entity.content.read": (payload: Readonly<Record<string, unknown>>) => {
      const contracts = compiledArtifactKinds(context.projection, context.input.repoId),
        kind = resolveEntityReadKind(context.requiredCellText(payload.entityKind, "entityKind"), contracts),
        entityId = context.requiredCellText(payload.entityId, "entityId"),
        current = describeCurrentArtifact(
          context.projection.readArtifactEntityState(kind, entityId),
          context.store,
          contracts,
          kind,
          entityId,
        ),
        contract = contracts.find(({ typeIdentity }) => typeIdentity === kind);
      return readEntityContent({
        rootDir: context.rootDir,
        source:
          contract && current?.descriptor
            ? {
                entityKind: kind,
                contract: contract.entityKindContract as unknown as EntityContentSource["contract"],
                entityId,
                ownedContent: current.ownedContent,
                readContentBlob: (sha256) => context.store.readContentBlob(sha256),
              }
            : null,
        ...(payload.path === undefined ? {} : { requestedPath: context.requiredCellText(payload.path, "path") }),
      });
    },
    "repo.agenda.read": (payload: Readonly<Record<string, unknown>>, binding?: RepoCellBinding) =>
      queryRead().agenda({
        ...agendaQueryFromPayload(context, payload),
        ...(binding ? { principalId: binding.actor.principal.personId } : {}),
      }),
    "repo.triadic.relationGraph": (payload: Readonly<Record<string, unknown>>) => relationGraphFromPayload(payload),
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
    "repo.agent.skills.list": () => readAgentSkillsGui(context.rootDir),
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
    "repo.squad.runs.list": (payload: Readonly<Record<string, unknown>>) =>
      makeSquadCanonicalReader({
        projection: context.projection,
        readResult: (ref) => readCanonicalRuntimeResult(context.store, ref),
      }).list(payload),
    "repo.squad.run.read": (payload: Readonly<Record<string, unknown>>) =>
      makeSquadCanonicalReader({
        projection: context.projection,
        readResult: (ref) => readCanonicalRuntimeResult(context.store, ref),
      }).read(context.requiredCellText(payload.squadRunId, "squadRunId")),
    "repo.decisions.list": (payload: Readonly<Record<string, unknown>>) => decisionListFromPayload(payload),
    "repo.tasks.completion.read": (payload) =>
      readTaskCompletion(context.projection, context.requiredCellText(payload.taskId, "taskId")),
    "repo.tasks.runtimeContext.read": (payload) =>
      readTaskRuntimeContext(context.rootDir, context.projection, context.requiredCellText(payload.taskId, "taskId")),
    "repo.tasks.document.read": (payload) => readProjectedDocument(context, payload),
    "repo.tasks.documents.list": (payload) => listProjectedTaskDocuments(context.rootDir, context.projection, payload),
    "repo.artifacts.list": (payload) =>
      readArtifactsGui(
        { rootDir: context.rootDir, projection: context.projection, input: { repoId: context.input.repoId } },
        payload,
      ),
    "repo.agentRuntime.overview": (payload) => context.runtimeReads.overview(payload),
    "repo.agentRuntime.sessions.read": (payload) => context.runtimeReads.session(payload),
    "repo.agentRuntime.events.read": (payload) => context.runtimeReads.events(payload),
    ...agentRuntimeTokenUsageReadHandlers(context),
    "repo.task.dispatches": (payload: Readonly<Record<string, unknown>>) =>
      readTaskDispatches({
        projection: context.projection,
        ...taskDispatchesPayloadFromCell(context, payload),
      }),
  } satisfies DaemonGuiReadHandlers;
  function decisionListFromPayload(payload: Readonly<Record<string, unknown>>): DaemonDecisionListResult {
    if (
      Object.keys(payload).some((field) => field !== "projection") ||
      (payload.projection !== undefined && payload.projection !== "summary" && payload.projection !== "full")
    )
      throw context.cellCodedError("invalid_command", "Decision list projection must be summary or full.");
    const read = context.projection.listDecisions({});
    if (payload.projection === "summary")
      return {
        ok: true,
        projection: "summary",
        decisions: read.decisions.map(decisionReviewSummaryRow),
        warnings: [],
      };
    {
      const source = makeGitReadinessSource(),
        projectHead = source.run(context.rootDir, ["rev-parse", "HEAD"]),
        commitSha = projectHead.ok ? projectHead.stdout : "",
        cacheKey = `${commitSha}\n${context.projection.readCut().sourceRevision}`;
      if (readinessCache?.key !== cacheKey)
        readinessCache = {
          key: cacheKey,
          rows: projectDecisionReadiness({ rootDir: context.rootDir, commitSha, decisions: read.decisions }, source),
        };
      return {
        ok: true,
        ...(payload.projection === "full" ? { projection: "full" as const } : {}),
        decisions: decisionFullListRows({
          rootDir: context.rootDir,
          projection: context.projection,
          decisions: read.decisions,
          readiness: readinessCache.rows,
          requirement: context.settings.readRepository().decisionReviewRequirement,
        }),
        warnings: [],
      };
    }
  }
  // Read handlers synchronously observe the current committed projection cut. Writes publish and
  // apply their new cut without yielding; long asynchronous preparation (for example a vertical
  // script) happens before publication. A read can therefore see the complete cut before or after
  // a write, never its partial state, without waiting behind the write tail.
  const readNow: RepoCellSynchronousRead[typeof repoCellSynchronousRead] = (method, payload = {}, binding) => {
    if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
    if (method === "repo.entity.actions.explain") {
      const { executor, ...request } = payload,
        verified = bindVerifiedExecutorClaim({
          action: { kind: "entity-action-explain", executor },
          binding: binding ?? explainAuthenticationRequired(),
          projection: context.projection,
          now: context.now(),
        });
      return readTaskActionExplanation(
        {
          projection: context.projection,
          binding: verified.binding,
          rootDir: context.rootDir,
          repoId: context.input.repoId,
          now: context.now,
        },
        request,
      ) as DaemonGuiReadResultMap[typeof method];
    }
    return context.dispatchRead(readHandlers, method, payload, binding) as DaemonGuiReadResultMap[typeof method];
  };
  const read: RepoCell["read"] = async (method, payload = {}, binding) => readNow(method, payload, binding);
  /**
   * The single serving point for every named use-case projection. Selector admission happens once,
   * in `admitUseCaseProjectionSelector`, so an unknown name, an inadmissible facet and a smuggled
   * field all fail closed here instead of being honoured by one layer and dropped by the next.
   * The inner projection shapes are unchanged from the reads they replaced (CH4: the boundary is
   * authority and visibility, not field renaming), and `inputs` is derived from the kind registry.
   */
  function useCaseProjection(payload: Readonly<Record<string, unknown>>): DaemonUseCaseProjectionResult {
    const admitted = admitUseCaseProjectionSelector(payload);
    if (typeof admitted === "string") throw context.cellCodedError("invalid_command", admitted);
    const { name, facet } = admitted;
    // `name` and `facet` route the projection; they are not part of any inner read's selector, so
    // they are stripped before delegation. Leaving them on would trip the inner reads' own closed
    // field checks — one of which (agent-runtime-read.ts) is a fifth copy of the same vocabulary.
    const { name: _name, facet: _facet, ...selector } = payload;
    const envelope = {
      schema: "daemon.use-case-projection/v1" as const,
      ok: true as const,
      name,
      facet,
      version: 1,
      inputs: deriveUseCaseProjectionInputs(name),
    };
    if (name === "schedule-plane") return { ...envelope, projection: readSchedulesGui(context) };
    if (name === "schedule-run-history")
      return {
        ...envelope,
        projection: readScheduleRuns(
          context,
          context.requiredCellText(selector.scheduleId, "scheduleId"),
          selector.limit === undefined ? 50 : Number(selector.limit),
        ),
      };
    return { ...envelope, projection: context.runtimeReads.sessionGroups(selector) };
  }
  function taskListQueryFromAction(action: RepoTaskAction): TaskProjectionListQuery {
    return taskListQueryFromPayload(action, context.cellCodedError);
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
      ...(typeof action.freshness === "string"
        ? { freshness: action.freshness as "current" | "suspect" | "orphaned" }
        : {}),
      ...(common.updatedAfter ? { updatedAfter: common.updatedAfter } : {}),
      ...(common.updatedBefore ? { updatedBefore: common.updatedBefore } : {}),
      ...(common.limit === undefined ? {} : { limit: common.limit }),
      ...(common.cursor ? { cursor: common.cursor } : {}),
    };
  }
  function relationGraphFromPayload(
    payload: Readonly<Record<string, unknown>>,
  ): DaemonGuiReadResultMap["repo.triadic.relationGraph"] {
    if (payload.entity !== undefined || payload.hops !== undefined) {
      const hops = payload.hops;
      if (
        typeof payload.entity !== "string" ||
        !payload.entity ||
        typeof hops !== "object" ||
        hops === null ||
        Array.isArray(hops)
      )
        throw context.cellCodedError("invalid_command", "Relation neighborhood requires entity and hops.");
      const value = hops as Readonly<Record<string, unknown>>,
        types = value.relationTypes;
      if (
        Object.keys(payload).some((field) => !["entity", "hops", "status"].includes(field)) ||
        Object.keys(value).some((field) => !["direction", "relationTypes", "maxDepth", "maxNodes"].includes(field)) ||
        !["outgoing", "incoming", "both"].includes(String(value.direction)) ||
        !Array.isArray(types) ||
        types.length === 0 ||
        types.some((type) => !relationTypes.includes(String(type) as (typeof relationTypes)[number])) ||
        !Number.isSafeInteger(value.maxDepth) ||
        Number(value.maxDepth) < 1 ||
        Number(value.maxDepth) > 4_096 ||
        !Number.isSafeInteger(value.maxNodes) ||
        Number(value.maxNodes) < 1 ||
        Number(value.maxNodes) > 10_000 ||
        (payload.status !== undefined &&
          !relationStates.includes(String(payload.status) as (typeof relationStates)[number]))
      )
        throw context.cellCodedError("invalid_command", "Relation neighborhood selectors are invalid.");
      return queryRead().relationGraphNeighborhood({
        seed: payload.entity,
        direction: value.direction as "outgoing" | "incoming" | "both",
        relationTypes: types as (typeof relationTypes)[number][],
        maxDepth: Number(value.maxDepth),
        maxNodes: Number(value.maxNodes),
        ...(payload.status === undefined ? {} : { state: payload.status as "active" | "retired" }),
      });
    }
    if (
      payload.facet !== undefined ||
      payload.relationType !== undefined ||
      payload.state !== undefined ||
      payload.direction !== undefined
    ) {
      const facet = payload.facet;
      if (
        !["edges", "facts", "coverageRows", "runtimeEdges"].includes(String(facet)) ||
        Object.keys(payload).some((field) =>
          facet === "edges"
            ? !["facet", "relationType", "state", "direction", "limit", "cursor"].includes(field)
            : facet === "facts"
              ? !["facet", "limit", "cursor"].includes(field)
              : field !== "facet",
        ) ||
        (payload.relationType !== undefined && (typeof payload.relationType !== "string" || !payload.relationType)) ||
        (payload.state !== undefined &&
          !relationStates.includes(String(payload.state) as (typeof relationStates)[number])) ||
        (payload.direction !== undefined &&
          !relationDirections.includes(String(payload.direction) as (typeof relationDirections)[number]))
      )
        throw context.cellCodedError("invalid_command", "Relation graph facet selectors are invalid.");
      queryPayloadFacets(payload, "repo.triadic.relationGraph");
      return queryRead().relationGraphFacet(payload as DaemonRelationGraphFacetPayload);
    }
    const common = queryPayloadFacets(payload, "repo.triadic.relationGraph");
    if (!common.explicit) return queryRead().relationGraphPage({ limit: 500 });
    return queryRead().relationGraphPage({
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
    return sharedQueryPayloadFacets(payload, method, context.cellCodedError);
  }
  // The wide task queries live in task-query-read.ts so the daemon and the scale
  // harness share one real read implementation; the closeout/blocking domain
  // judgments stay consumed by the RepoCell composition root.
  const queryRead = () =>
    makeTaskQueryReadModel({
      rootDir: context.rootDir,
      projection: context.projection,
      readPinnedEntities: context.projection.listPinnedEntities,
      judgments: repoCellTaskQueryJudgmentsFor(context.projection),
    });
  Object.assign(context.extracted, { taskListQueryFromAction, queryRead, relationQueryFromAction });
  // The runtime publication turn verifies any executor claim before it authorizes and executes.
  const spawnRuntime: RepoCell["spawnRuntime"] = async (payload, binding) => {
    const { executor: _claim, ...spawn } = payload;
    // A dry-run preview is a read projection: it must not enter the publication
    // turn, acquire a lease, or append a dispatch event.
    if (spawn.dryRun === true) return context.runtimeSpawner.spawn(spawn, binding);
    // A task dispatch's worktree checkout and setup finish first; the queue receives only the dispatch itself.
    const worktree = await context.runtimeSpawner.prepareWorktree(spawn);
    return enqueueRuntimePublication(
      context,
      "runtime-run",
      { kind: "runtime-spawn", ...payload },
      binding,
      (authorizedBinding) => context.runtimeSpawner.spawn(spawn, authorizedBinding, worktree),
    );
  };
  const handoffRuntime: RepoCell["handoffRuntime"] = (payload, binding) =>
    runRuntimeHandoff({
      rootDir: context.rootDir,
      payload,
      command: async (action, body) => {
        let candidate;
        if (body) {
          const ref = `doc-sync-claims/handoff_${randomUUID()}`;
          writeFileDurably(path.join(resolveHarnessLayout(context.rootDir).localRoot, ref), body, 0o600);
          candidate = { ref, size: body.byteLength, sha256: sha256Bytes(body), mediaType: "application/x-ndjson" };
        }
        try {
          return (await run(
            { ...action, ...(candidate ? { candidate } : {}) } as RepoTaskAction,
            binding,
          )) as unknown as JsonObject;
        } finally {
          if (candidate) removeFileDurably(path.join(resolveHarnessLayout(context.rootDir).localRoot, candidate.ref));
        }
      },
      spawn: async (checkpoint, spawn, rollout) => {
        const worktree = await context.runtimeSpawner.prepareWorktree({
          taskId: checkpoint.taskId,
          acceptedCommit: checkpoint.commit,
        });
        return enqueueRuntimePublication(
          context,
          "runtime-handoff-claim",
          { kind: "runtime-handoff-claim", dispatchId: checkpoint.dispatchId },
          binding,
          (authorized) => context.runtimeSpawner.spawnHandoff(checkpoint, spawn, authorized, worktree, rollout),
        );
      },
    });
  const cancelRuntime: RepoCell["cancelRuntime"] = async (payload, binding) => {
    const { executor: _claim, ...cancel } = payload;
    return enqueueRuntimePublication(
      context,
      "runtime-cancel",
      { kind: "runtime-cancel", ...payload },
      binding,
      (authorizedBinding) => context.runtimeSpawner.cancel(cancel, authorizedBinding),
    );
  };
  const runtimeIngress: RepoCell["runtimeIngress"] = (action, binding) => {
    const settlementRuntimeSessionId =
      action.kind === "archive"
        ? action.archive.runtimeSessionId
        : action.type === "runtime_session_exited" || action.type === "runtime_session_outcome_observed"
          ? action.payload.runtimeSessionId
          : null;
    if (typeof settlementRuntimeSessionId === "string")
      binding = {
        ...binding,
        actor: {
          principal: binding.actor.principal,
          executor: { kind: "agent", id: `runtime-session:${settlementRuntimeSessionId}` },
        },
      };
    const policyAction =
      action.kind === "archive"
        ? {
            kind: "runtime-run",
            taskId: action.archive.taskId,
            executionId: action.archive.executionId,
            runtimeSessionId: action.archive.runtimeSessionId,
            executionRuntimeIngress: action,
          }
        : { ...action, kind: "runtime-run", executionRuntimeIngress: action };
    return enqueueRuntimePublication(context, "runtime-run", policyAction, binding, async (authorizedBinding) => {
      const runtimeSessionId =
        action.kind === "archive" ? action.archive.runtimeSessionId : action.payload.runtimeSessionId;
      const dispatch =
        typeof runtimeSessionId === "string" ? context.projection.readRuntimeDispatch(runtimeSessionId) : null;
      if (
        typeof authorizedBinding.source === "object" &&
        authorizedBinding.source.kind === "node" &&
        dispatch?.payload.taskId &&
        (action.kind === "archive" ||
          (runtimeSessionActionIds.includes(action.type as never) &&
            action.type !== "runtime_session_started" &&
            action.type !== "runtime_session_cancelled"))
      ) {
        const center = authorizedBinding.keycloakAuthorization?.center;
        if (!center)
          throw context.cellCodedError("execution_credential_rejected", "Execution authority is unavailable.");
        const principal = await readRuntimeExecutionPrincipal(center, dispatch.payload.dispatchId);
        if (principal.repoId !== context.input.repoId)
          throw context.cellCodedError("execution_credential_rejected", "Execution belongs to another repository.");
        requireCurrentExecutionScope({
          action: policyAction,
          binding: { ...authorizedBinding, executionPrincipal: principal },
          projection: context.projection,
          now: context.now(),
        });
      }
      if (action.kind === "event" && runtimeSessionActionIds.includes(action.type as never)) {
        const receipt = await commitRuntimeSessionAction(context.extracted, action, authorizedBinding);
        const dispatch =
          action.type === "runtime_session_started" && typeof action.payload.runtimeSessionId === "string"
            ? context.projection.readRuntimeDispatch(action.payload.runtimeSessionId)
            : null;
        const execution =
          receipt.outcome === "applied" &&
          dispatch?.payload.taskId &&
          dispatch.payload.executionId &&
          typeof authorizedBinding.source === "object" &&
          authorizedBinding.source.kind === "node" &&
          authorizedBinding.keycloakAuthorization?.center
            ? {
                personId: dispatch.actor.principal.personId,
                repoId: context.input.repoId,
                runtimeSessionId: dispatch.payload.runtimeSessionId,
                dispatchId: dispatch.payload.dispatchId,
                taskId: dispatch.payload.taskId,
                executionId: dispatch.payload.executionId,
                role: dispatch.payload.role === "reviewer" ? ("reviewer" as const) : ("implementation" as const),
                source: dispatch.source,
                expiresAt: new Date(Date.parse(context.now()) + runtimeExecutionLifetimeMs).toISOString(),
              }
            : null;
        if (execution)
          requireCurrentExecutionScope({
            action: { kind: "task-show", taskId: execution.taskId },
            binding: { ...authorizedBinding, actor: runtimeExecutionActor(execution), executionPrincipal: execution },
            projection: context.projection,
            now: context.now(),
          });
        const executionCredential = execution
          ? await issueRuntimeExecutionCredential(authorizedBinding.keycloakAuthorization!.center!, execution)
          : undefined;
        return {
          schema: "command-receipt/v2",
          ok: receipt.outcome === "applied" || receipt.outcome === "no_changes",
          command: "runtime-ingress",
          ...receipt,
          ...(executionCredential
            ? {
                executionCredential,
                executionExpiresAt: execution!.expiresAt,
                executionPrincipalId: execution!.personId,
              }
            : {}),
        } as unknown as JsonObject;
      }
      return action.kind === "event" && action.type === "runtime_squad_run_observed"
        ? appendSquadRunObservation(context.extracted, action, authorizedBinding)
        : context.appendAuxiliaryRuntimeIngress(action, authorizedBinding);
    });
  };
  // Backup lifetimes serialize independently of ledger writes: retention cannot remove
  // another builtin's in-progress snapshot. A replay shares the same claim's execution.
  const builtinRuns = new Map<string, Promise<WriteReceipt>>();
  let builtinTail: Promise<void> = Promise.resolve();
  const continueBuiltin = (action: RepoTaskAction, binding: RepoCellBinding, receipt: WriteReceipt) => {
    if (action.kind !== "schedule-run-now" || receipt.outcome !== "applied") return Promise.resolve(receipt);
    const schedule = (receipt as WriteReceipt & { readonly schedule?: ScheduleV1 }).schedule,
      active = schedule?.status.activeRun;
    if (schedule?.spec.target.kind !== "builtin" || !active) return Promise.resolve(receipt);
    const running = builtinRuns.get(active.claimFence);
    if (running) return running;
    const writerFence = binding.withWriterEpochFence ?? context.activeWriterEpochFence,
      writerDescriptor = binding.writerEpochFence ?? context.activeWriterEpochFenceDescriptor;
    const executorCell: BuiltinExecutorCell = {
      rootDir: context.rootDir,
      now: context.now,
      observeCi: (schedule) =>
        reconcileCiOccurrence({
          cell: context.extracted,
          schedule,
          requests: () => ciRequests.splice(0),
          accept: async (fetched) => {
            const receipt = await run(
              {
                kind: "ci-observe-pull",
                scheduleId: schedule.scheduleId,
                claimFence: active.claimFence,
                [preparedCiObservation]: fetched,
              },
              {
                ...binding,
                withWriterEpochFence: writerFence ?? undefined,
                writerEpochFence: writerDescriptor ?? undefined,
              },
            );
            if (isSquadControlResult(receipt))
              throw context.cellCodedError("invalid_command", "CI acceptance requires a write receipt.");
            return receipt;
          },
        }),
      runSnapshot: <T>(work: () => T | PromiseLike<T>): Promise<T> => {
        context.queueDepth += 1;
        const snapshot = chainRepoCellWrite(context.tail, async () => {
          context.queueDepth -= 1;
          // Await the existing follower before worker IO yields this event loop.
          await context.store.settlePendingMaterialization?.("backup capture");
          if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
          assertCurrentWriter(context.activeWriter, context.writerToken, context.input.repoId);
          const current = context.projection.getEntity("schedule", schedule.scheduleId)?.value as
            | ScheduleV1
            | undefined;
          if (current?.status.activeRun?.claimFence !== active.claimFence)
            throw context.cellCodedError("schedule_claim_stale", "Builtin occurrence claim is no longer current.");
          if (writerDescriptor) assertWriterEpochFenceDescriptor(writerDescriptor);
          // Each canonical append owns its epoch transaction; nesting an outer epoch
          // transaction here would reject a valid append. Bind this executor's fence
          // to the store for the synchronous accept turn, not another command's fence.
          const previousFence = context.activeWriterEpochFence,
            previousDescriptor = context.activeWriterEpochFenceDescriptor;
          context.activeWriterEpochFence = writerFence;
          context.activeWriterEpochFenceDescriptor = writerDescriptor;
          try {
            return work();
          } finally {
            context.activeWriterEpochFence = previousFence;
            context.activeWriterEpochFenceDescriptor = previousDescriptor;
          }
        });
        context.tail = snapshot.then(
          () => undefined,
          () => undefined,
        );
        return snapshot;
      },
    };
    const pending = (schedule.spec.target.builtinId === "ledger-backup" ? builtinTail : Promise.resolve())
      .then(() =>
        executeBuiltinScheduleOccurrence({
          cell: executorCell,
          schedule,
          idempotencyKey: String(action.idempotencyKey ?? `builtin:${active.claimFence}`),
          binding,
          runInternal: async (settlement, actor) => {
            const result = await run(settlement, actor);
            if (isSquadControlResult(result))
              throw context.cellCodedError("invalid_command", "Builtin settlement requires a write receipt.");
            return result;
          },
        }),
      )
      .finally(() => builtinRuns.delete(active.claimFence));
    builtinRuns.set(active.claimFence, pending);
    if (schedule.spec.target.builtinId === "ledger-backup")
      builtinTail = pending.then(
        () => undefined,
        () => undefined,
      );
    return pending;
  };
  const runCommand: RepoCell["run"] = async (action, binding, signal) => {
    const receipt = await run(action, binding, signal);
    if (isSquadControlResult(receipt)) return receipt;
    if (isSquadControlCommand(action.kind)) return squadControlRejected(action.kind, receipt);
    const completed = await continueBuiltin(action, binding, receipt);
    return settleWriteReceipt(context, action, completed, signal);
  };
  return {
    bootstrapReceipt: context.bootstrapReceipt,
    hasBuiltinExecutor: async (claimFence) => builtinRuns.has(claimFence),
    run: runCommand,
    presetRun,
    spawnRuntime,
    cancelRuntime,
    handoffRuntime,
    awaitRuntimeOutcome: context.awaitRuntimeOutcome,
    awaitRuntimeSignal: context.awaitRuntimeSignal,
    runtimeIngress,
    catalog: context.catalog,
    terminal: context.terminal,
    read,
    [repoCellSynchronousRead]: readNow,
    workspaceSummary: () => workspaceSummaryFromProjection(context.projection),
    workspaceScope: (payload) => workspaceScopeFromProjection(context.projection, payload),
    observeTail: (payload, daemon) => {
      if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
      return readObserveTail({
        repoId: context.input.repoId,
        rootDir: context.rootDir,
        mode: context.mode,
        projection: context.projection,
        userRoot: daemon.userRoot,
        daemonId: daemon.daemonId,
        payload,
      });
    },
    get replica() {
      return context.replica;
    },
    verifyReadiness: async () => {
      if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
      const ready = context.projection.readCut().status === "ready";
      if (!ready) throw context.cellCodedError("repo_unavailable", "RepoCell L2 projection is not ready.");
      return { cellState: "attached", l2State: "ready" };
    },
    attach: async (runtimeSessionId, afterCursor) => {
      await context.tail;
      if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
      return context.runtimeStream.attach(runtimeSessionId, afterCursor);
    },
    runtime: context.runtimeStream,
    status: () => repoCellStatus(context),
    statusCuts: () => repoCellStatusCuts(context),
    inFlightWork: () =>
      readRepoInFlightWork({
        projection: context.projection,
        repoId: context.input.repoId,
        queueDepth: context.queueDepth,
      }),
    settlePendingMaterialization: async (settlementContext) => {
      await context.tail;
      if (context.state !== "attached") return;
      await context.store.settlePendingMaterialization?.(settlementContext);
    },
    close: async () => {
      if (context.state === "closed") return;
      await builtinTail;
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
