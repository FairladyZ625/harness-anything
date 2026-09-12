import { readTaskCompletion } from "./task-completion-read.ts";
import { enqueueRuntimePublication } from "./runtime-publication-queue.ts";
import {
  executeSquadControl,
  isSquadControlCommand,
  isSquadControlResult,
  squadControlRejected,
  type SquadControlResult,
} from "./squad-control-result.ts";
import type { RepoCellCore } from "./repo-cell.ts";
import {
  attachReceiptAcceptance,
  readAcceptedCommandOutcome,
  waitForReceiptAcceptance,
} from "../../kernel/src/index.ts";
import {
  assertCurrentWriter,
  buildVerticalDeclarationRead,
  buildEntityKindCatalog,
  deriveUseCaseProjectionInputs,
  durablePolicyActions,
  getExecutableEntityAction,
  projectDecisionReadiness,
  relationDirections,
  relationStates,
  relationTypes,
  runtimeSessionActionIds,
  timestamp,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type DaemonRepoMode,
  type DecisionProjectionRow,
  type EventPublicationKillpoint,
  type EntityActionUnmetCriterionV1,
  type TaskProjection,
  type TaskProjectionListQuery,
  type WriteReceipt,
  type WriteReceiptDraft,
} from "../../kernel/src/index.ts";
import { type PresetRunReceiptV1, type createPresetProcessService } from "../../preset/src/index.ts";
import { readAgentEntityGuiProjection } from "./agent-entities.ts";
import {
  canonicalVertical,
  compiledArtifactKinds,
  readCurrentArtifact,
  resolveEntityReadKind,
} from "./artifact-entity-action.ts";
import { requireCanonicalVerticalDeclaration } from "./vertical-declaration-action.ts";
import { readBeforeWriteQueue } from "./write-queue-external-reads.ts";
import { readDeclaredEntityRows } from "./entity-rows-read.ts";
import { readEntityContent, type EntityContentSource } from "./entity-content-read.ts";
import { readEntityLocator } from "./entity-locator-read.ts";
import { discoverAgentSkills } from "./agent-skills.ts";
import { readTaskDispatches } from "./dispatch-read.ts";
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
import {
  commandDescriptorForAction,
  type DaemonDecisionListResult,
  type DaemonGuiReadResultMap,
  type DaemonRelationGraphFacetPayload,
  type DaemonTaskDispatchesPayload,
  type CanonicalRoot,
} from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { recoveryCommandPolicy } from "./recovery-state.ts";
import type {
  DaemonGuiReadHandlers,
  RepoCell,
  RepoCellBinding,
  RepoCellReadMethod,
  RepoTaskAction,
} from "./repo-cell-types.ts";
import {
  authorizeDurableRepoCellAction,
  authorizeRepoCellAction,
  bindVerifiedExecutorClaim,
  withAuthorizationDecision,
} from "./repo-cell-authorization.ts";
import { admitRepoMode, entityActionCommandTopology } from "./repo-mode.ts";
import { makeTaskQueryReadModel } from "./task-query-read.ts";
import { chainRepoCellWrite, repoCellTaskQueryJudgments } from "./repo-cell.ts";
import { executeVerticalScriptAction, publishExecutedVerticalScript } from "./vertical-script-actions.ts";
import { deriveActionResult } from "./entity-action-catalog-executor.ts";
import { workspaceSummaryFromProjection } from "./workspace-summary-read.ts";
import { readCiObservatory } from "./ci-observatory-read.ts";
import type { RepoCellOperationalContext, RepoCellSettingsState } from "./repo-cell-action-context.ts";
import type { FleetRoster } from "./fleet-center-admission.ts";
import type { makeRecoveryProbe } from "./recovery-state.ts";
import type { makeRuntimeSpawner } from "./runtime-spawn.ts";
import type { makeSquadCoordinator } from "./squad-coordinator.ts";
import type { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import type { AgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import type { RepoBootstrapReceipt } from "./repo-bootstrap.ts";
import { explainAuthenticationRequired, readTaskActionExplanation } from "./task-action-explanation-read.ts";
import { commitRuntimeSessionAction } from "./runtime-session-action-runtime.ts";
import { readTaskWipSnapshot, type TaskQueryCell } from "./repo-cell-task-query.ts";

export interface RepoCellApiContext {
  readonly extracted: RepoCellOperationalContext;
  readonly mode: DaemonRepoMode;
  readonly fleetRoster: FleetRoster | null;
  readonly input: {
    readonly repoId: string;
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

export function createRepoCellApi(context: RepoCellApiContext): RepoCell & RepoCellSynchronousRead {
  let settlingRecovery: string | null = null;
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
  const run = async (
    action: RepoTaskAction,
    binding: RepoCellBinding,
    signal?: AbortSignal,
  ): Promise<WriteReceipt | SquadControlResult> => {
    if (context.state !== "attached")
      await context.attemptRecovery(recoveryCommandPolicy(action.kind, context.causeClass)?.settlesLatch === true);
    const requested = { action, binding },
      durable = (durablePolicyActions as readonly string[]).includes(action.kind),
      // A durable executor claim is verified in the publication turn that authorizes and executes it.
      claimAtPublication = durable && action.executor != null,
      bindExecutorClaim = (): WriteReceipt | null => {
        try {
          ({ action, binding } = bindVerifiedExecutorClaim({
            ...requested,
            projection: context.projection,
            now: context.now(),
          }));
          return null;
        } catch (error) {
          const revision = context.store.readHead()?.revision ?? 0,
            actionId = context.operationId(requested.action, requested.binding, context.input.repoId, revision),
            decision = authorizeRepoCellAction({ ...requested, actionId, revision, now: context.now() });
          return withAuthorizationDecision(
            context.failed(actionId, error),
            decision,
            [],
            error instanceof Error ? error.message : String(error),
          );
        }
      };
    if (claimAtPublication) {
      const { executor: _claim, ...unclaimed } = action;
      action = unclaimed as RepoTaskAction;
    } else {
      const claimRejected = bindExecutorClaim();
      if (claimRejected) return claimRejected;
    }
    const command = entityActionCommandTopology(commandDescriptorForAction(action.kind), action),
      authorizeAtCurrentCut = (): AuthorizationDecision | null => {
        const revision = context.store.readHead()?.revision ?? 0,
          actionId = context.operationId(action, binding, context.input.repoId, revision);
        return authorizeDurableRepoCellAction({ action, binding, actionId, revision, now: context.now() });
      },
      frameCurrent = (
        receipt: WriteReceiptDraft,
        criteria: readonly EntityActionUnmetCriterionV1[] = [],
        explanation?: string,
      ): WriteReceipt =>
        durable
          ? withAuthorizationDecision(receipt, authorizeAtCurrentCut()!, criteria, explanation)
          : (receipt as WriteReceipt);
    const recoveryCommand =
        context.state === "attached" ? null : recoveryCommandPolicy(action.kind, context.causeClass),
      recoveryCommandAllowed =
        recoveryCommand !== null && (recoveryCommand.settlesLatch || action.kind === "receipt-show");
    if (context.state !== "attached" && !recoveryCommandAllowed)
      return Promise.resolve(
        frameCurrent(
          context.rejected(context.operationId(action, binding, context.input.repoId, 0), "repo_unavailable"),
          [],
          context.latched(),
        ),
      );
    const claimsRecovery = context.state !== "attached" && recoveryCommand?.settlesLatch === true;
    if (claimsRecovery && settlingRecovery !== null) {
      return Promise.resolve(
        frameCurrent(
          context.rejected(context.operationId(action, binding, context.input.repoId, 0), "recovery_conflict"),
        ),
      );
    }
    if (claimsRecovery) settlingRecovery = action.kind;
    const failAction = (error: unknown, authorizationDecision?: AuthorizationDecision): WriteReceipt => {
      if (context.fatalCellError(error)) context.latchWith(error);
      const contract = getExecutableEntityAction(action.kind),
        receipt = context.failed(
          context.errorOperationId(error) ?? context.operationId(action, binding, context.input.repoId, 0),
          error,
          contract,
          contract ? action : undefined,
        );
      const result = contract ? deriveActionResult(contract, action, receipt) : receipt;
      return authorizationDecision
        ? withAuthorizationDecision(
            result,
            authorizationDecision,
            result.unmetCriteria ?? [],
            result.rejectionExplanation ?? (error instanceof Error ? error.message : String(error)),
          )
        : (result as WriteReceipt);
    };
    if (command.commandClass === "repo-read")
      return Promise.resolve()
        .then(async () => {
          const admission = admitRepoMode(context.mode, command, binding.source);
          if (!admission.ok) throw context.cellCodedError(admission.code, admission.nextAction);
          if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
          return context.withHumanSummary(await context.executeAction(action, binding));
        })
        .then((receipt) => receipt as WriteReceipt)
        .catch((error) => failAction(error));
    const enqueuePublication = (
      execute: (authorizationDecision?: AuthorizationDecision) => WriteReceiptDraft | Promise<WriteReceiptDraft>,
    ): Promise<WriteReceipt | SquadControlResult> => {
      context.queueDepth += 1;
      let queuedDecision: AuthorizationDecision | undefined,
        replaceAfterPublication = false;
      const pending = chainRepoCellWrite(context.tail, async () => {
        context.queueDepth -= 1;
        const claimRejected = claimAtPublication ? bindExecutorClaim() : null;
        if (claimRejected) return claimRejected;
        if (durable) {
          queuedDecision = authorizeAtCurrentCut()!;
          if (queuedDecision.outcome === "denied")
            return withAuthorizationDecision(
              context.rejected(
                context.operationId(action, binding, context.input.repoId, context.store.readHead()?.revision ?? 0),
                "authorization_denied",
              ),
              queuedDecision,
              [],
              `Policy ${queuedDecision.policyRef} denied ${action.kind}: ${queuedDecision.reasonCodes.join(", ")}.`,
            );
        }
        const queuedAdmission = admitRepoMode(context.mode, command, binding.source);
        if (!queuedAdmission.ok) throw context.cellCodedError(queuedAdmission.code, queuedAdmission.nextAction);
        if (context.state === "closed" || (context.state !== "attached" && !recoveryCommandAllowed))
          throw context.cellCodedError(
            "repo_unavailable",
            "RepoCell closed or changed state before this queued command could execute.",
          );
        assertCurrentWriter(context.activeWriter, context.writerToken, context.input.repoId);
        context.activeWriterEpochFence = binding.withWriterEpochFence ?? null;
        context.activeWriterEpochFenceDescriptor = binding.writerEpochFence ?? null;
        const revisionBeforeExecution = context.store.readHead()?.revision ?? 0;
        try {
          if (isSquadControlCommand(action.kind)) {
            const controlled = await executeSquadControl(
              context.extracted,
              action,
              queuedDecision ? { ...binding, authorizationDecision: queuedDecision } : binding,
            );
            context.replica.kick();
            return controlled;
          }
          const executed = context.withHumanSummary(await execute(queuedDecision)),
            receipt = queuedDecision ? withAuthorizationDecision(executed, queuedDecision) : (executed as WriteReceipt);
          if (recoveryCommand?.settlesLatch && receipt.outcome === "applied") {
            if (action.kind === "migrate-import" && action.dryRun !== true) {
              context.recoveryProbe.clear();
              replaceAfterPublication = true;
            } else {
              context.state = "attached";
              context.lastError = null;
              context.causeClass = null;
              context.recoveryUncertain = false;
              context.recoveryProbe.clear();
            }
          }
          context.replica.kick();
          return receipt;
        } catch (error) {
          if (isSquadControlCommand(action.kind))
            return squadControlRejected(action.kind, failAction(error, queuedDecision));
          // This queue owns the interval. A downstream failure cannot undo its committed acceptance.
          const head = context.store.readHead(),
            accepted = head ? readAcceptedCommandOutcome(context.store, head.opId) : null;
          if (accepted !== null && accepted.firstRevision > revisionBeforeExecution)
            throw Object.assign(
              context.cellCodedError(
                "publication_indeterminate",
                error instanceof Error ? error.message : String(error),
              ),
              { opId: accepted.opId, cause: error },
            );
          throw error;
        } finally {
          context.activeWriterEpochFence = null;
          context.activeWriterEpochFenceDescriptor = null;
        }
      });
      context.tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending
        .catch((error) => failAction(error, queuedDecision))
        .then(async (receipt) => {
          if (!replaceAfterPublication) return receipt;
          await context.attemptRecovery(true);
          return context.state === "attached"
            ? receipt
            : ({
                ...receipt,
                outcome: "pending",
                code: "repo_unavailable",
              } as WriteReceipt);
        })
        .finally(() => {
          if (claimsRecovery) settlingRecovery = null;
        });
    };
    if (action.kind === "script-run")
      // The script reads the published commit, so it waits for every accepted write to be published first.
      return Promise.resolve(context.store.settlePendingMaterialization?.("vertical script"))
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
            enqueuePublication((authorizationDecision) =>
              publishExecutedVerticalScript(
                {
                  binding: authorizationDecision ? { ...binding, authorizationDecision } : binding,
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
          (error) => failAction(error, durable ? authorizeAtCurrentCut()! : undefined),
        );
    const externalRead = readBeforeWriteQueue(context, action);
    if (externalRead)
      return externalRead
        .then((publish) =>
          enqueuePublication((authorizationDecision) =>
            publish(action, authorizationDecision ? { ...binding, authorizationDecision } : binding),
          ),
        )
        .catch((error) => failAction(error, durable ? authorizeAtCurrentCut()! : undefined));
    return enqueuePublication((authorizationDecision) =>
      context.executeAction(action, authorizationDecision ? { ...binding, authorizationDecision } : binding),
    );
  };
  const presetRun: RepoCell["presetRun"] = async (action, binding) => {
    const bound = bindExecutorClaimAtWriterCut(action, binding);
    ({ action, binding } = bound.queued ? await bound.result : bound.result);
    const command = commandDescriptorForAction(action.kind),
      authorizationDecision =
        action.kind === "preset-run-start"
          ? authorizeRepoCellAction({
              action,
              binding,
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
        rootDir: context.rootDir,
        projection: context.projection,
        ...(payload.window === undefined ? {} : { window: Number(payload.window) }),
      }),
    "repo.settings.read": () => ({
      schema: "daemon.settings-read/v1" as const,
      ok: true as const,
      settings: context.settings.read(),
    }),
    "repo.tasks.list": (payload: Readonly<Record<string, unknown>>) =>
      queryRead().guiTasks(taskListQueryFromPayload(payload)),
    "repo.tasks.wip": () => readTaskWipSnapshot(context as unknown as TaskQueryCell),
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
        current = readCurrentArtifact(context.store, contracts, kind, entityId),
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
    "repo.agenda.read": (payload: Readonly<Record<string, unknown>>) =>
      queryRead().agenda(agendaQueryFromPayload(payload)),
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
    "repo.squad.runs.list": (payload: Readonly<Record<string, unknown>>) => context.squadCoordinator.list(payload),
    "repo.squad.run.read": (payload: Readonly<Record<string, unknown>>) =>
      context.squadCoordinator.read(context.requiredCellText(payload.squadRunId, "squadRunId")),
    "repo.decisions.list": (payload: Readonly<Record<string, unknown>>) => decisionListFromPayload(payload),
    "repo.tasks.completion.read": (payload) =>
      readTaskCompletion(context.projection, context.requiredCellText(payload.taskId, "taskId")),
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
    "repo.task.dispatches": (payload: Readonly<Record<string, unknown>>) =>
      readTaskDispatches({
        rootDir: context.rootDir,
        projection: context.projection,
        ...taskDispatchesPayloadFromCell(payload),
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
        decisions: read.decisions.map(
          ({ decisionId, title, state, riskTier, urgency, proposedAt }: DecisionProjectionRow) => ({
            decisionId,
            title,
            state,
            riskTier,
            urgency,
            proposedAt,
          }),
        ),
        warnings: [],
      };
    {
      const source = makeGitReadinessSource(),
        projectHead = source.run(context.rootDir, ["rev-parse", "HEAD"]),
        commitSha = projectHead.ok ? projectHead.stdout : "",
        cacheKey = `${commitSha}\n${JSON.stringify(read.decisions)}`;
      if (readinessCache?.key !== cacheKey)
        readinessCache = {
          key: cacheKey,
          rows: projectDecisionReadiness({ rootDir: context.rootDir, commitSha, decisions: read.decisions }, source),
        };
      const readiness = readinessCache.rows;
      return {
        ok: true,
        ...(payload.projection === "full" ? { projection: "full" as const } : {}),
        decisions: read.decisions.map((decision, index: number) => ({
          ...decision,
          readiness: readiness[index]!,
        })),
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
      return readTaskActionExplanation(
        { store: context.store, projection: context.projection, binding, rootDir: context.rootDir, now: context.now },
        payload,
      ) as DaemonGuiReadResultMap[typeof method];
    }
    return context.dispatchRead(readHandlers, method, payload) as DaemonGuiReadResultMap[typeof method];
  };
  const read: RepoCell["read"] = async (method, payload = {}, binding) => readNow(method, payload, binding);
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
      [updatedAfter, updatedBefore].some((value) => value !== undefined && !timestamp(value)) ||
      (updatedAfter && updatedBefore && updatedAfter > updatedBefore)
    )
      throw context.cellCodedError("invalid_command", "Query time window must use ordered ISO-8601 timestamps.");
    if (cursor !== undefined && !cursor) throw context.cellCodedError("invalid_command", "Query cursor is invalid.");
    const stateInvalid =
      status !== undefined &&
      !(
        (method === "repo.tasks.list"
          ? ["planned", "active", "blocked", "in_review", "done", "cancelled"]
          : relationStates) as readonly string[]
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
  const queryRead = () =>
    makeTaskQueryReadModel({
      rootDir: context.rootDir,
      projection: context.projection,
      judgments: repoCellTaskQueryJudgments,
    });
  Object.assign(context.extracted, { taskListQueryFromAction, queryRead, relationQueryFromAction });
  // The runtime publication turn verifies any executor claim before it authorizes and executes.
  const spawnRuntime: RepoCell["spawnRuntime"] = async (payload, binding) => {
    const { executor: _claim, ...spawn } = payload;
    return enqueueRuntimePublication(
      context,
      "runtime-run",
      { kind: "runtime-spawn", ...payload },
      binding,
      (authorizedBinding) => context.runtimeSpawner.spawn(spawn, authorizedBinding),
    );
  };
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
          }
        : { ...action, kind: "runtime-run" };
    return enqueueRuntimePublication(context, "runtime-run", policyAction, binding, async (authorizedBinding) => {
      if (action.kind === "event" && runtimeSessionActionIds.includes(action.type as never)) {
        const receipt = await commitRuntimeSessionAction(context.extracted, action, authorizedBinding);
        return {
          schema: "command-receipt/v2",
          ok: receipt.outcome === "applied" || receipt.outcome === "no_changes",
          command: "runtime-ingress",
          ...receipt,
        } as unknown as JsonObject;
      }
      return context.appendAuxiliaryRuntimeIngress(action, authorizedBinding);
    });
  };
  return {
    bootstrapReceipt: context.bootstrapReceipt,
    run: async (action, binding, signal) => {
      const receipt = await run(action, binding, signal);
      if (isSquadControlResult(receipt)) return receipt;
      if (isSquadControlCommand(action.kind)) return squadControlRejected(action.kind, receipt);
      if (
        action.kind === "settings-update" &&
        receipt.effects?.length === 1 &&
        receipt.effects[0] === "settings-local/locale_changed"
      )
        return receipt;
      if (
        action.kind === "projection-rebuild" ||
        action.kind === "doc-materialize" ||
        // ci-observe-pull mints a synthetic opId over a batch of separately-opId'd imports; that
        // opId is never itself an accepted command outcome, so acceptance lookup would mislabel
        // its own already-correct applied/pending outcome as acceptance_unknown.
        action.kind === "ci-observe-pull" ||
        (!(durablePolicyActions as readonly string[]).includes(action.kind) && action.kind !== "receipt-show")
      )
        return receipt;
      const read = () => attachReceiptAcceptance(receipt, context.store, context.projection);
      return action.kind === "receipt-show" && action.waitFor !== undefined
        ? waitForReceiptAcceptance(read, action.waitFor, action.timeoutMs, signal, async () => {
            await context.store.settlePendingMaterialization?.("receipt wait");
          })
        : read();
    },
    presetRun,
    spawnRuntime,
    cancelRuntime,
    runtimeIngress,
    catalog: context.catalog,
    terminal: context.terminal,
    read,
    [repoCellSynchronousRead]: readNow,
    workspaceSummary: () => workspaceSummaryFromProjection(context.projection),
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
      const projected = await read("repo.tasks.list"),
        ready = projected.status === "ready";
      if (!ready) throw context.cellCodedError("repo_unavailable", "RepoCell L2 projection is not ready.");
      return { cellState: "attached", l2State: "ready" };
    },
    attach: async (runtimeSessionId, afterCursor) => {
      await context.tail;
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
      materialization: context.store.materializationHealth(),
    }),
    settlePendingMaterialization: async (settlementContext) => {
      await context.tail;
      if (context.state !== "attached") return;
      await context.store.settlePendingMaterialization?.(settlementContext);
    },
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
