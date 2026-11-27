import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { exponentialBackoffMs, raceLifetime, runDaemonRetry } from "./daemon-retry.ts";
import { readLocalState } from "./repo-cell-settings-state.ts";
import { daemonRpcCommandTopology } from "./rpc-command-routing.ts";
import { readFileSync } from "node:fs";
import { fleetEdgeConfigDir, readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { resolveBoundAccessToken } from "./daemon-host-binding.ts";
import { createFleetReplicaAccessTokenReader } from "./fleet/replica-token.ts";
import {
  parseFleetCenterExternalUrl,
  readFleetCenterConfig,
  retainFleetCenterCertificatePaths,
  saveFleetCenterConfig,
} from "./fleet-center-config.ts";
import { readCenterRelocationRouting, rebindCenterRelocationRouting } from "./fleet/center-relocation-command.ts";
import {
  announceSwitchoverCandidateToCenter,
  createDaemonSwitchoverControlHandler,
} from "./fleet/center-switchover-transport.ts";
import { centerMovedError, throwIfCenterMigrating, throwIfCenterRelocated } from "@harness-anything/storage";
import { annotateHostingCredentialNotice } from "./hosting-credential-readiness.ts";
import { parseReadOnlyRuntimeInstanceListPayload, requireExecutionActionScope } from "./runtime-execution-scope.ts";
import { executionCredentialRejected } from "./runtime-execution-credential.ts";
import { projectReadOnlyRuntimeInstanceList } from "./read-only-status-projection.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import {
  consumeKnownError,
  type AuthorizationDecision,
  projectRuntimeProviderHealth,
  readDaemonRegistry,
  type FleetDeviceLoginNotice,
  type RuntimeInstanceAccountCut,
} from "@harness-anything/kernel";
import {
  assertResidentCeoPrincipal,
  effectiveResidentCeoApprovalGate,
  effectiveResidentCeoExecutionPolicy,
  isResidentCeoApprovalGateMode,
  isResidentCeoExecutionPolicy,
  isResidentCeoWakeCause,
  type ResidentCeoProfile,
  type ResidentCeoProposalStatus,
} from "@harness-anything/kernel/internal/domain/resident-ceo.ts";
import type { AgentRuntimeSessionResult } from "./agent-runtime-contract.ts";
import { catalogRereadReceipt } from "./gui-catalog.ts";
import {
  ledgerWriteCommandTopology,
  repoReadCommandTopology,
} from "@harness-anything/preset/internal/preset-command-contract";
import type { DaemonHost } from "./daemon-host-types.ts";
import {
  keycloakNodeRegistry,
  prepareFleetCenterAdmission,
  startFleetCenterAdmission,
  syncFleetEdgeMirror,
  repointFleetEdgeMirror,
  type FleetCenterAdmissionRequest,
  type FleetEdgeSyncRequest,
  type FleetEdgeRepointRequest,
} from "./fleet-center-admission.ts";
import { probeTlsAddress, validateCertificateNames } from "./tls-listener-admission.ts";
import type { FleetEdgeRuntimeRequest } from "./fleet-edge-runtime.ts";
import { canonicalRoot, commandDescriptorForAction } from "./protocol/daemon-protocol.contract.ts";
import { PEER_BODY_MAX_LENGTH } from "./protocol/daemon-protocol-commands.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { DaemonHostApiContext } from "./daemon-host-context.ts";
import { runReplicaConfirmedRound } from "./runtime-recovery-watch.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { readAllTaskDispatchPages } from "./dispatch-read.ts";
import {
  evaluateFleetAction,
  evaluateFleetActionBatch,
  prepareBatchTaskAncestorReader,
  requireAuthorizedFleetAction,
  requireAuthorizedHostAction,
  resolveTaskReadAuthorizationScopes,
} from "./host-action-authorization.ts";
import {
  orchestrateRuntimeBatch,
  orchestrateRuntimeSessionsAwait,
  type RuntimeOrchestrationContext,
} from "./runtime-orchestration.ts";
import { makeResidentCeoService } from "@harness-anything/application/internal/commands/resident-ceo.ts";
import type { PeerRequestV1 } from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import { openResidentCeoProfileStore } from "./resident-ceo-profile-store.ts";
import { buildResidentCeoHumanChatPrompt, settleResidentCeoHumanChatTurn } from "./resident-ceo-action-executor.ts";
import {
  buildResidentCeoPeerPrompt,
  extractResidentCeoExecutionSummary,
  formatResidentCeoHistorySummary,
  formatResidentCeoProposalsSummary,
  lookupOpenPeerRequest,
  makeResidentCeoApprovalGate,
  makeResidentCeoDelegationExecutor,
  settleResidentCeoPeerTurn,
  syncResidentCeoPromotedTaskOutcomes,
} from "./resident-ceo-delegation.ts";
import { runtimeDispatchIdentity } from "./task-dispatch-recovery.ts";

function residentCeoDispatchKey(principalPersonId: string, wakeId: string): string {
  return `resident-ceo:${principalPersonId}:${wakeId}`;
}

function residentCeoWatcherKey(repoId: string, principalPersonId: string): string {
  return `${repoId}:${principalPersonId}`;
}

const TERMINAL_PEER_STATES = new Set<PeerRequestV1["state"]>(["ANSWERED", "DONE", "REJECTED", "PROMOTED"]);

function boundPeerReplyText(text: string): string {
  return text.length <= PEER_BODY_MAX_LENGTH ? text : `${text.slice(0, PEER_BODY_MAX_LENGTH - 1)}…`;
}

function peerReplyRejectionMessage(reply: Readonly<Record<string, unknown>>): string {
  if (typeof reply.rejectionExplanation === "string" && reply.rejectionExplanation.trim().length > 0)
    return reply.rejectionExplanation;
  const nestedError = reply.error;
  if (
    nestedError !== null &&
    typeof nestedError === "object" &&
    "message" in nestedError &&
    typeof nestedError.message === "string" &&
    nestedError.message.trim().length > 0
  )
    return nestedError.message;
  return "Peer reply was not confirmed.";
}

function hasRunningResidentCeoCandidate(rootDir: string, repoId: string): boolean {
  const serialized = readLocalState(rootDir).value.residentCeoProfilesJson;
  return serialized !== undefined && serialized.includes('"running"') && serialized.includes(JSON.stringify(repoId));
}

export function createDaemonHostRuntimeApi(context: DaemonHostApiContext): {
  readonly restoreResidentCeos: () => void;
  readonly closeResidentCeos: () => Promise<void>;
} & Pick<
  DaemonHost,
  | "attach"
  | "spawnRuntime"
  | "cancelRuntime"
  | "steerRuntime"
  | "handoffRuntime"
  | "batchRuntime"
  | "awaitRuntimeSessions"
  | "runtimeIngress"
  | "residentCeo"
  | "terminalAttach"
  | "terminalAction"
  | "authorize"
  | "fleet"
  | "system"
  | "runtimeInstance"
  | "decisionProvider"
  | "runtimeInstanceAuth"
> {
  const hostOrchestration = (
    repoId: string,
    cell: ReturnType<typeof context.requiredCell>,
    binding: Awaited<ReturnType<typeof context.binding>>,
    auth: Parameters<typeof context.binding>[1],
  ): RuntimeOrchestrationContext => ({
    spawnRuntime: (payload) => cell.spawnRuntime(payload, binding),
    awaitRuntimeOutcome: cell.awaitRuntimeOutcome,
    readSession: (runtimeSessionId) =>
      context.host.read(repoId, "repo.agentRuntime.sessions.read", { runtimeSessionId }, auth),
    codedError: context.hostCodedError,
  });
  let centerStarting = false;
  const residentCeoInboxWatchers = new Map<string, AbortController>();
  const inFlightResidentCeoWakes = new Map<string, number>();
  const inFlightResidentCeoWakeWaiters = new Map<string, (() => void)[]>();
  let residentCeoTasks: Promise<void>[] = [];
  const residentCeoRestoredRepos = new Set<string>();
  const trackResidentCeoTask = (task: Promise<void>): void => {
    residentCeoTasks.push(task);
    void task.finally(() => {
      residentCeoTasks = residentCeoTasks.filter((entry) => entry !== task);
    });
  };
  const runTrackedResidentCeoWake = async <T>(watcherKey: string, executeWake: () => Promise<T>): Promise<T> => {
    inFlightResidentCeoWakes.set(watcherKey, (inFlightResidentCeoWakes.get(watcherKey) ?? 0) + 1);
    try {
      return await executeWake();
    } finally {
      const remaining = (inFlightResidentCeoWakes.get(watcherKey) ?? 1) - 1;
      inFlightResidentCeoWakes.set(watcherKey, remaining > 0 ? remaining : 0);
      if (remaining <= 0) {
        const waiters = inFlightResidentCeoWakeWaiters.get(watcherKey);
        if (waiters && waiters.length > 0) {
          inFlightResidentCeoWakeWaiters.set(watcherKey, []);
          for (const resolve of waiters) resolve();
        }
      }
    }
  };
  const waitForInFlightResidentCeoWake = (watcherKey: string): Promise<void> => {
    if ((inFlightResidentCeoWakes.get(watcherKey) ?? 0) === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = inFlightResidentCeoWakeWaiters.get(watcherKey) ?? [];
      waiters.push(resolve);
      inFlightResidentCeoWakeWaiters.set(watcherKey, waiters);
    });
  };
  const residentCeoProfiles = (repoId: string, auth: DaemonAuthenticationContext) =>
    openResidentCeoProfileStore({
      key: repoId,
      readSerialized: async () => {
        const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
        return readLocalState(cell.status().rootDir).value.residentCeoProfilesJson;
      },
      writeSerialized: async (value) => {
        if (context.closeSignal.aborted || context.closing)
          throw context.hostCodedError("repo_unavailable", "Daemon is closing; Resident CEO profile write cancelled.");
        const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId),
          binding = await context.binding(cell.status().rootDir, auth, undefined, repoId);
        if (!cell.writeResidentCeoProfilesJson)
          throw context.hostCodedError("repo_unavailable", "RepoCell has no Resident CEO profile writer.");
        await cell.writeResidentCeoProfilesJson(value, binding);
      },
    });
  context.closeSignal.addEventListener(
    "abort",
    () => {
      for (const watcher of residentCeoInboxWatchers.values()) watcher.abort();
      residentCeoInboxWatchers.clear();
    },
    { once: true },
  );
  const runtimeNodeId = (repoId?: string): string => {
    if (repoId === undefined) return "center";
    const repo = readDaemonRegistry({ userRoot: context.input.userRoot }).repos.find(
      (candidate) => candidate.repoId === repoId,
    );
    if (!repo)
      throw context.hostCodedError("repo_namespace_unknown", `Unknown runtime repository namespace: ${repoId}.`);
    if (repo.mode !== "remote-edge") return "center";
    if (repo.canonicalRoot === null)
      throw context.hostCodedError("repo_namespace_unknown", `Runtime repository ${repoId} has no local root.`);
    const edge = readFleetEdgeConfig(context.input.userRoot, repoId);
    if (edge === null || edge.repoId !== repoId)
      throw context.hostCodedError(
        "fleet_edge_config_missing",
        `Fleet edge configuration for repository ${repoId} is unavailable or mismatched.`,
      );
    return edge.nodeId;
  };
  const authorizeCenterConfiguration = async (repoId: string, auth: Parameters<typeof context.binding>[1]) => {
    const authorityRepo = readDaemonRegistry({ userRoot: context.input.userRoot }).repos.find(
      (repo): repo is typeof repo & { readonly canonicalRoot: string } =>
        repo.repoId === repoId &&
        repo.state === "enabled" &&
        repo.mode !== "remote-proxy" &&
        repo.canonicalRoot !== null,
    );
    if (!authorityRepo)
      throw context.hostCodedError("repo_namespace_unknown", "Saved fleet center authority repository is not enabled.");
    await requireAuthorizedHostAction({
      kind: "daemon-fleet-center-start",
      repoId: authorityRepo.repoId,
      binding: await context.binding(authorityRepo.canonicalRoot, auth),
      actionId: `daemon-fleet-center-address:${authorityRepo.repoId}`,
      evaluatedAtCut: "fleet-center:current",
    });
  };
  const runRemoteEdgeRuntime = async (
    repoId: string,
    method: FleetEdgeRuntimeRequest["payload"]["method"],
    action: JsonObject,
    auth: Parameters<typeof context.binding>[1],
  ): Promise<JsonObject | null> => {
    const receipt = await context.forwardRuntime({
      repoId,
      method,
      action,
      auth,
      decorate:
        method === "repo.agentRuntime.spawn"
          ? (resolved, value) =>
              annotateHostingCredentialNotice(value, action, resolved.workspaceRoot, {
                repoId,
                instances: context.instances.list(),
              })
          : undefined,
    });
    if (receipt) {
      await context.scheduleScheduler.refresh();
    }
    return receipt;
  };
  const guardCenterRelocation = (repoId: string, mutating: boolean): void => {
    const userRoot = context.input?.userRoot;
    if (typeof userRoot !== "string" || userRoot.length === 0) return;
    const repoMode = readDaemonRegistry({ userRoot }).repos.find((entry) => entry.repoId === repoId)?.mode;
    throwIfCenterRelocated(userRoot, repoId, { repoMode });
    if (mutating) throwIfCenterMigrating(userRoot, repoId);
  };
  const acknowledgeResidentCeoPeer = async (
    repoId: string,
    requestId: string,
    auth: DaemonAuthenticationContext,
    response: string,
  ): Promise<void> => {
    const reply = await context.host.run(
      repoId,
      {
        kind: "peer-reply",
        requestId,
        claim: response,
        requestedAction: "Review this assessment and follow up if further action is needed.",
        idempotencyKey: `resident-ceo-reply-${requestId}`,
      },
      auth,
    );
    if (reply.outcome === "applied" || reply.outcome === "no_changes") return;
    if (reply.outcome === "op_rejected" && reply.code === "peer_request_transition_invalid") return;
    if (reply.outcome === "op_rejected" && reply.code === "fleet_task_rejected") {
      const cell = context.cells.get(repoId);
      if (cell?.readPeerRequest) {
        const binding = await context.binding(cell.status().rootDir, auth, undefined, repoId);
        const existing = await cell.readPeerRequest(requestId, binding, auth.connectionSignal);
        if (existing !== null && TERMINAL_PEER_STATES.has(existing.state)) return;
      }
    }
    throw context.hostCodedError(
      reply.code ?? "resident_ceo_reply_unconfirmed",
      peerReplyRejectionMessage(reply as unknown as Readonly<Record<string, unknown>>),
    );
  };
  const withResidentCeoSignal = (
    auth: DaemonAuthenticationContext,
    signal?: AbortSignal,
  ): DaemonAuthenticationContext => {
    const signals = [auth.connectionSignal, signal, context.closeSignal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    );
    return { ...auth, connectionSignal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) };
  };
  const awaitResidentCeoRuntimeSettlement = async (
    repoId: string,
    runtimeSessionId: string,
    auth: DaemonAuthenticationContext,
    signal?: AbortSignal,
  ): Promise<AgentRuntimeSessionResult | null> => {
    const waitSignal = withResidentCeoSignal(auth, signal).connectionSignal;
    return runDaemonRetry({
      run: async () => {
        const awaited = await context.host.awaitRuntimeSessions(
          repoId,
          { runtimeSessionIds: [runtimeSessionId], mode: "all" },
          withResidentCeoSignal(auth, signal),
        );
        if (
          awaited.session &&
          typeof awaited.session === "object" &&
          !Array.isArray(awaited.session) &&
          awaited.settlement &&
          typeof awaited.settlement === "object" &&
          !Array.isArray(awaited.settlement)
        )
          return awaited as unknown as AgentRuntimeSessionResult;
        if (
          Array.isArray(awaited.unavailable) &&
          awaited.unavailable.some(
            (entry) =>
              entry !== null &&
              typeof entry === "object" &&
              !Array.isArray(entry) &&
              (entry as { readonly runtimeSessionId?: unknown }).runtimeSessionId === runtimeSessionId,
          )
        )
          return null;
        return context.host.read(repoId, "repo.agentRuntime.sessions.read", { runtimeSessionId }, auth);
      },
      signal: waitSignal,
      retryDelay: (settled, attempt) => {
        if (settled.ok) return null;
        const code = context.code(settled.error).toUpperCase();
        return [
          "REPLICA_UNAVAILABLE",
          "ECONNREFUSED",
          "ECONNRESET",
          "ETIMEDOUT",
          "ENOTFOUND",
          "EHOSTUNREACH",
          "EPIPE",
        ].includes(code)
          ? exponentialBackoffMs({ attempt, baseMs: 250, maxMs: 5_000 })
          : null;
      },
    });
  };
  const residentCeoService = (
    repoId: string,
    auth: Parameters<typeof context.binding>[1],
    activePeerRequest?: PeerRequestV1,
  ) => {
    const profiles = residentCeoProfiles(repoId, auth);
    const service = makeResidentCeoService({
      profiles,
      delegation: makeResidentCeoDelegationExecutor(
        {
          host: context.host,
          codedError: context.hostCodedError,
          resolveLocalNodeId: () => runtimeNodeId(repoId),
          resolveRepoRoot: () => context.cells.get(repoId)?.status().rootDir ?? null,
          now: context.now,
        },
        repoId,
        auth,
      ),
      approvalGate: makeResidentCeoApprovalGate({
        decisionProviders: context.decisionProviders,
        now: context.now,
      }),
      now: context.now,
      createId: randomUUID,
      runtime: {
        run: async (request) => {
          const receipt = await context.host.spawnRuntime(
              repoId,
              {
                runtimeInstanceId: request.runtimeInstanceId,
                model: request.model,
                ...(request.persistentSessionId ? { providerSessionId: request.persistentSessionId } : {}),
                prompt: request.message,
                permissionMode: "read-only",
                mcpPolicy: "disabled",
                cwd: { scope: "repo-root" },
                taskId: null,
                dispatchKey: residentCeoDispatchKey(request.principalPersonId, request.wakeId),
              },
              auth,
            ),
            runtimeSessionId = typeof receipt.runtimeSessionId === "string" ? receipt.runtimeSessionId : null;
          if (runtimeSessionId === null)
            throw context.hostCodedError("runtime_spawn_failed", "Resident CEO runtime did not return a session id.");
          return {
            runtimeSessionId,
            awaitResponse: async () => {
              const session = await awaitResidentCeoRuntimeSettlement(repoId, runtimeSessionId, auth);
              if (session === null || session.settlement === null || session.settlement.outcome !== "succeeded")
                throw context.hostCodedError(
                  "resident_ceo_runtime_failed",
                  session?.settlement?.reason ?? "Resident CEO runtime did not complete successfully.",
                );
              const response =
                session.result?.text?.trim() || "The request was received. No response text was produced.";
              const execution = extractResidentCeoExecutionSummary(session, {
                runtimeInstanceId: request.runtimeInstanceId,
                model: request.model,
              });
              let proposalId: string | null = null;
              if (request.peerRequestId !== undefined) {
                const currentProfile = await profiles.read(request.principalPersonId);
                if (currentProfile !== null) {
                  proposalId = await settleResidentCeoPeerTurn({
                    profile: currentProfile,
                    peerRequest:
                      activePeerRequest?.requestId === request.peerRequestId
                        ? activePeerRequest
                        : await lookupOpenPeerRequest(context.host, repoId, request.peerRequestId, auth),
                    peerRequestId: request.peerRequestId,
                    wakeId: request.wakeId,
                    response,
                    acknowledgePeer: (reqId, text) =>
                      acknowledgeResidentCeoPeer(repoId, reqId, auth, boundPeerReplyText(text)),
                    recordProposal: (draft) => service.recordProposal(request.principalPersonId, draft, repoId),
                    executeTier0Action: (actionInput) =>
                      service.executeTier0Action(request.principalPersonId, actionInput, repoId),
                    recordTier2Rejection: (rejection) =>
                      service.recordTier2Rejection(request.principalPersonId, rejection, repoId),
                    recordDeniedAction: (denied) =>
                      service.recordDeniedAction(request.principalPersonId, denied, repoId),
                  });
                } else {
                  await acknowledgeResidentCeoPeer(repoId, request.peerRequestId, auth, boundPeerReplyText(response));
                }
                return { response, persistentSessionId: session.session.providerSessionId, proposalId, execution };
              }
              if (request.cause === "human-chat") {
                const currentProfile = await profiles.read(request.principalPersonId);
                if (currentProfile !== null) {
                  const settledChat = await settleResidentCeoHumanChatTurn({
                    profile: currentProfile,
                    principalPersonId: request.principalPersonId,
                    wakeId: request.wakeId,
                    userMessage: request.message,
                    response,
                    service: {
                      executeTier0Action: (actionInput) =>
                        service.executeTier0Action(request.principalPersonId, actionInput, repoId),
                      recordProposal: (draft) => service.recordProposal(request.principalPersonId, draft, repoId),
                      recordTier2Rejection: (rejection) =>
                        service.recordTier2Rejection(request.principalPersonId, rejection, repoId),
                      recordDeniedAction: (denied) =>
                        service.recordDeniedAction(request.principalPersonId, denied, repoId),
                    },
                  });
                  const chatProposalId =
                    settledChat.actionReceipts.find((entry) => typeof entry.proposalId === "string")?.proposalId ??
                    null;
                  return {
                    response: settledChat.response,
                    persistentSessionId: session.session.providerSessionId,
                    proposalId: chatProposalId,
                    execution,
                    ...(settledChat.actionReceipts.length > 0 ? { actionReceipts: settledChat.actionReceipts } : {}),
                  };
                }
              }
              return {
                response,
                persistentSessionId: session.session.providerSessionId,
                proposalId,
                execution,
              };
            },
          };
        },
      },
    });
    return service;
  };
  const reconcileRunningResidentCeoWake = async (
    repoId: string,
    principalPersonId: string,
    profile: ResidentCeoProfile,
    auth: DaemonAuthenticationContext,
    options: { readonly waitForSettlement: boolean; readonly signal?: AbortSignal },
  ): Promise<boolean> => {
    const wake = profile.lastWake;
    if (wake?.status !== "running") return false;
    if ((inFlightResidentCeoWakes.get(residentCeoWatcherKey(repoId, principalPersonId)) ?? 0) > 0) return false;
    const targetRuntimeSessionId =
      wake.runtimeSessionId ??
      runtimeDispatchIdentity(repoId, residentCeoDispatchKey(principalPersonId, wake.wakeId)).runtimeSessionId;
    let settled: AgentRuntimeSessionResult | null;
    if (options.waitForSettlement) {
      settled = await awaitResidentCeoRuntimeSettlement(repoId, targetRuntimeSessionId, auth, options.signal);
    } else {
      const [probe] = await Promise.allSettled([
        context.host.read(
          repoId,
          "repo.agentRuntime.sessions.read",
          { runtimeSessionId: targetRuntimeSessionId },
          auth,
        ),
      ]);
      if (probe.status === "rejected") {
        if (context.code(probe.reason) !== "runtime_session_not_found") throw probe.reason;
        if (runtimeNodeId(repoId) === "center") {
          settled = null;
        } else {
          const probeSignal = AbortSignal.timeout(50);
          const [centerProbe] = await Promise.allSettled([
            context.host.awaitRuntimeSessions(
              repoId,
              { runtimeSessionIds: [targetRuntimeSessionId], mode: "all" },
              withResidentCeoSignal(auth, probeSignal),
            ),
          ]);
          if (centerProbe.status === "rejected") {
            const code = context.code(centerProbe.reason);
            if (probeSignal.aborted || code === "client_disconnected" || code === "ABORT_ERR") return false;
            if (code !== "runtime_session_not_found") throw centerProbe.reason;
            settled = null;
          } else {
            const awaited = centerProbe.value;
            if (
              awaited.session &&
              typeof awaited.session === "object" &&
              !Array.isArray(awaited.session) &&
              awaited.settlement &&
              typeof awaited.settlement === "object" &&
              !Array.isArray(awaited.settlement)
            ) {
              settled = awaited as unknown as AgentRuntimeSessionResult;
            } else if (
              Array.isArray(awaited.unavailable) &&
              awaited.unavailable.some(
                (entry) =>
                  entry !== null &&
                  typeof entry === "object" &&
                  !Array.isArray(entry) &&
                  (entry as { readonly runtimeSessionId?: unknown }).runtimeSessionId === targetRuntimeSessionId,
              )
            ) {
              settled = null;
            } else {
              return false;
            }
          }
        }
      } else {
        settled = probe.value;
      }
      if (settled !== null && settled.settlement === null) return false;
    }
    if (settled === null) {
      await residentCeoService(repoId, auth).reconcileWake(principalPersonId, wake.wakeId, {
        runtimeSessionId: targetRuntimeSessionId,
        succeeded: false,
        persistentSessionId: null,
        detail: "Resident CEO runtime session was not found after restart.",
      });
      return true;
    }
    if (settled.settlement === null) return false;
    const service = residentCeoService(repoId, auth);
    const settledResponse = settled.result?.text?.trim() || "No response text was produced.";
    let proposalId: string | null = null;
    if (settled.settlement.outcome === "succeeded" && wake.peerRequestId !== undefined) {
      proposalId = await settleResidentCeoPeerTurn({
        profile,
        peerRequest: await lookupOpenPeerRequest(context.host, repoId, wake.peerRequestId, auth),
        peerRequestId: wake.peerRequestId,
        wakeId: wake.wakeId,
        response: settledResponse,
        acknowledgePeer: (reqId, text) => acknowledgeResidentCeoPeer(repoId, reqId, auth, boundPeerReplyText(text)),
        recordProposal: (draft) => service.recordProposal(principalPersonId, draft, repoId),
        executeTier0Action: (actionInput) => service.executeTier0Action(principalPersonId, actionInput, repoId),
        recordTier2Rejection: (rejection) => service.recordTier2Rejection(principalPersonId, rejection, repoId),
        recordDeniedAction: (denied) => service.recordDeniedAction(principalPersonId, denied, repoId),
      });
    }
    await service.reconcileWake(principalPersonId, wake.wakeId, {
      runtimeSessionId: settled.session.runtimeSessionId,
      succeeded: settled.settlement.outcome === "succeeded",
      persistentSessionId: settled.session.providerSessionId,
      detail: settled.settlement.reason,
      responseText: settled.settlement.outcome === "succeeded" ? settledResponse : null,
      proposalId,
      execution: extractResidentCeoExecutionSummary(settled, {
        runtimeInstanceId: profile.runtimeInstanceId,
        model: profile.model,
      }),
    });
    return true;
  };
  const watchResidentCeoInbox = (repoId: string, principalPersonId: string): void => {
    const watcherKey = residentCeoWatcherKey(repoId, principalPersonId);
    residentCeoInboxWatchers.get(watcherKey)?.abort();
    if (context.closeSignal.aborted) return;
    const controller = new AbortController();
    const { signal } = controller;
    residentCeoInboxWatchers.set(watcherKey, controller);
    trackResidentCeoTask(
      runDaemonRetry({
        run: async () =>
          (async () => {
            const currentNowMs = (): number => {
              const parsed = Date.parse(context.now());
              return Number.isFinite(parsed) ? parsed : Date.now();
            };
            let afterRevision: number | undefined;
            let nextHeartbeat: number | null = null;
            while (!signal.aborted) {
              if (context.ensureRbacResumed) await raceLifetime(context.ensureRbacResumed(), signal);
              signal.throwIfAborted();
              const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId),
                profileAuth = await context.oidc.bind({ transportKind: "unix-socket" } as const, cell.status().rootDir),
                profile = await residentCeoProfiles(repoId, profileAuth).read(principalPersonId);
              if (profile !== null) assertResidentCeoPrincipal(profile, principalPersonId);
              if (profile?.status !== "running" || profile.repoId !== repoId) return;
              const intervalMs = profile.heartbeatIntervalSec * 1_000;
              nextHeartbeat ??= currentNowMs() + intervalMs;
              guardCenterRelocation(repoId, false);
              await context.attemptHostRecovery(repoId);
              const auth = await context.oidc.bind({ transportKind: "unix-socket" } as const, cell.status().rootDir);
              if (auth.sessionUnavailable) throw auth.sessionUnavailable;
              if (auth.oidcPrincipal?.personId !== principalPersonId)
                throw context.hostCodedError(
                  "authentication_required",
                  "Resident CEO requires its principal's local session.",
                );
              signal.throwIfAborted();
              if ((inFlightResidentCeoWakes.get(watcherKey) ?? 0) > 0) {
                await raceLifetime(waitForInFlightResidentCeoWake(watcherKey), signal);
                continue;
              }
              if (profile.lastWake?.status === "running") {
                const reconciled = await reconcileRunningResidentCeoWake(repoId, principalPersonId, profile, auth, {
                  waitForSettlement: true,
                  signal,
                });
                if (!reconciled) await delay(250, undefined, { signal, ref: false });
                continue;
              }
              await syncResidentCeoPromotedTaskOutcomes({
                host: context.host,
                repoId,
                profile,
                auth,
                reportOutcome: (proposalId, taskStatus, summary) =>
                  residentCeoService(repoId, auth).reportPromotedTaskOutcome(
                    principalPersonId,
                    { proposalId, taskStatus, summary },
                    repoId,
                  ),
              });
              const eventReadAuth = withResidentCeoSignal(auth, signal);
              if (afterRevision === undefined) {
                const page = await context.host.read(
                  repoId,
                  "repo.events.read",
                  { afterRevision: 0, limit: 1 },
                  eventReadAuth,
                );
                afterRevision = page.headRevision;
              }
              const receipt = await context.host.run(repoId, { kind: "peer-inbox", state: "OPEN", limit: 20 }, auth);
              if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes")
                throw context.hostCodedError(
                  receipt.code ?? "resident_ceo_inbox_unavailable",
                  "Peer Inbox read failed.",
                );
              const evidence =
                typeof receipt.evidence === "string"
                  ? (JSON.parse(receipt.evidence) as { requests?: PeerRequestV1[] })
                  : null;
              const existingProposalPeerIds = new Set((profile.proposals ?? []).map((entry) => entry.peerRequestId));
              const request = evidence?.requests?.find(
                (candidate) =>
                  candidate.to.personId === principalPersonId && !existingProposalPeerIds.has(candidate.requestId),
              );
              if (request) {
                signal.throwIfAborted();
                const result = await runTrackedResidentCeoWake(watcherKey, () =>
                  residentCeoService(repoId, auth, request).wake(
                    principalPersonId,
                    "peer-request",
                    buildResidentCeoPeerPrompt(profile, request),
                    request.requestId,
                    repoId,
                    {
                      fromPersonId: request.from.personId,
                      peerSummary: request.summary,
                      requestText: request.structuredBody.claim || request.summary,
                    },
                  ),
                );
                if (result.response !== null) continue;
              }
              const receiptCutRevision =
                "cut" in receipt && receipt.cut && typeof receipt.cut === "object" && "revision" in receipt.cut
                  ? Number((receipt.cut as { readonly revision?: unknown }).revision)
                  : undefined;
              if (
                cell.status().mode === "remote-edge" &&
                receiptCutRevision !== undefined &&
                Number.isFinite(receiptCutRevision) &&
                receiptCutRevision < afterRevision
              ) {
                await delay(150, undefined, { signal, ref: false });
                continue;
              }
              const nowMs = currentNowMs();
              if (nowMs >= nextHeartbeat) {
                // Lightweight heartbeat check completed above with zero open peer requests:
                // advance the next heartbeat schedule without launching an LLM runtime.
                nextHeartbeat = nowMs + intervalMs;
                await residentCeoService(repoId, auth)
                  .recordHeartbeatCheck(principalPersonId, "Inbox checked: no open peer requests.", repoId)
                  .catch(consumeKnownError);
              }
              const waitMs = Math.max(1, Math.min(25_000, nextHeartbeat - currentNowMs()));
              const started = Date.now();
              const page = await context.host.read(
                repoId,
                "repo.events.read",
                { afterRevision, limit: 200, waitMs },
                eventReadAuth,
              );
              afterRevision = page.nextAfterRevision;
              if (!page.events.length && Date.now() - started < waitMs)
                await delay(Math.max(1, waitMs - (Date.now() - started)), undefined, { signal, ref: false });
            }
          })(),
        signal,
        retryDelay: (settled) => (settled.ok || signal.aborted ? null : 5_000),
      })
        .catch(consumeKnownError)
        .finally(() => {
          if (residentCeoInboxWatchers.get(watcherKey) === controller) residentCeoInboxWatchers.delete(watcherKey);
        }),
    );
  };
  return {
    restoreResidentCeos: () => {
      if (context.closeSignal.aborted || context.closing) return;
      for (const repo of readDaemonRegistry({ userRoot: context.input.userRoot }).repos) {
        if (
          repo.state !== "enabled" ||
          repo.canonicalRoot === null ||
          !context.cells.has(repo.repoId) ||
          residentCeoRestoredRepos.has(repo.repoId) ||
          !hasRunningResidentCeoCandidate(repo.canonicalRoot, repo.repoId)
        )
          continue;
        residentCeoRestoredRepos.add(repo.repoId);
        const rootDir = repo.canonicalRoot;
        const repoId = repo.repoId;
        trackResidentCeoTask(
          runDaemonRetry({
            run: async () => {
              if (context.ensureRbacResumed) await raceLifetime(context.ensureRbacResumed(), context.closeSignal);
              if (
                context.closeSignal.aborted ||
                context.closing ||
                !context.cells.has(repoId) ||
                !hasRunningResidentCeoCandidate(rootDir, repoId)
              )
                return;
              const auth = await raceLifetime(
                context.oidc.bind({ transportKind: "unix-socket" } as const, rootDir),
                context.closeSignal,
              );
              if (context.closeSignal.aborted || context.closing) return;
              if (auth.sessionUnavailable) throw auth.sessionUnavailable;
              if (!auth.oidcPrincipal) return;
              const profile = await raceLifetime(
                residentCeoProfiles(repoId, auth).read(auth.oidcPrincipal.personId),
                context.closeSignal,
              );
              if (
                !context.closeSignal.aborted &&
                !context.closing &&
                profile?.status === "running" &&
                profile.repoId === repoId
              )
                watchResidentCeoInbox(profile.repoId, profile.principalPersonId);
            },
            signal: context.closeSignal,
            retryDelay: (settled) => (settled.ok || context.closeSignal.aborted || context.closing ? null : 5_000),
          }).catch(consumeKnownError),
        );
      }
    },
    closeResidentCeos: async () => {
      for (const watcher of residentCeoInboxWatchers.values()) watcher.abort();
      residentCeoInboxWatchers.clear();
      while (residentCeoTasks.length > 0) {
        await Promise.allSettled([...residentCeoTasks]);
      }
    },
    residentCeo: async (repoId, operation, payload, auth): Promise<JsonObject> => {
      context.localOnly(auth);
      context.requireHostMode(repoId, commandDescriptorForAction(`ceo-${operation}`), auth);
      await context.attemptHostRecovery(repoId);
      guardCenterRelocation(repoId, operation !== "status" && operation !== "proposals" && operation !== "history");
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      const session = await context.oidc.requireSession(cell.status().rootDir),
        principalPersonId = session.personId;
      if (auth.executionPrincipal || auth.oidcPrincipal?.personId !== principalPersonId)
        throw context.hostCodedError("authorization_denied", "Resident CEO requires a signed-in person principal.");
      await context.binding(cell.status().rootDir, auth);
      const profiles = residentCeoProfiles(repoId, auth);
      const saved = await profiles.read(principalPersonId);
      const receipt = (profile: unknown, summary: string): JsonObject => ({
        ok: true,
        profile: profile as JsonObject | null,
        summary,
      });
      if (operation === "status") {
        const pendingProposals = (saved?.proposals ?? []).filter((entry) => entry.status === "pending_approval").length;
        const gate = saved ? effectiveResidentCeoApprovalGate(saved) : null;
        const gateText =
          gate === null
            ? ""
            : gate.mode === "off"
              ? " · gate=off"
              : ` · gate=${gate.mode}${gate.providerId ? `(${gate.providerId})` : ""}@${gate.minConfidence}`;
        return receipt(
          saved,
          saved
            ? `${saved.status} · ${saved.runtimeInstanceId} · ${saved.model} · ${saved.heartbeatIntervalSec}s · policy=${effectiveResidentCeoExecutionPolicy(saved)}${gateText}${pendingProposals > 0 ? ` · pendingProposals=${pendingProposals}` : ""}${saved.lastWake ? `\nLast wake: ${saved.lastWake.cause} · ${saved.lastWake.status} · ${saved.lastWake.requestedAt}` : ""}`
            : "Resident CEO is not configured.",
        );
      }
      if (saved?.repoId !== undefined && saved.repoId !== repoId)
        throw context.hostCodedError("invalid_field", "Open the repository configured for this resident CEO.");
      const service = residentCeoService(repoId, auth);
      if (operation === "history") {
        const cause = payload.cause;
        if (cause !== undefined && !isResidentCeoWakeCause(cause))
          throw context.hostCodedError("invalid_field", "cause must be heartbeat, peer-request, or human-chat.");
        const limit = payload.limit;
        if (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1))
          throw context.hostCodedError("invalid_field", "limit must be a positive integer.");
        const history = saved
          ? await service.listHistory(
              principalPersonId,
              {
                ...(cause === undefined ? {} : { cause }),
                ...(limit === undefined ? {} : { limit: Number(limit) }),
              },
              repoId,
            )
          : [];
        return {
          ...receipt(saved, formatResidentCeoHistorySummary(history)),
          history: history as unknown as JsonObject[],
        };
      }
      if (operation === "proposals") {
        const statusFilter =
          typeof payload.status === "string" && payload.status.trim().length > 0
            ? (payload.status.trim() as ResidentCeoProposalStatus)
            : undefined;
        const proposals = saved
          ? await service.listProposals(principalPersonId, statusFilter ? { status: statusFilter } : undefined, repoId)
          : [];
        return {
          ...receipt(saved, formatResidentCeoProposalsSummary(proposals)),
          proposals: proposals as unknown as JsonObject[],
        };
      }
      if (operation === "config") {
        if (saved?.lastWake?.status === "running")
          await reconcileRunningResidentCeoWake(repoId, principalPersonId, saved, auth, { waitForSettlement: false });
        const runtimeInstanceId = String(payload.runtimeInstanceId ?? ""),
          model = String(payload.model ?? "");
        const instance = context.instances.list().find((entry) => entry.instanceId === runtimeInstanceId);
        if (!instance?.enabled || !instance.models.includes(model))
          throw context.hostCodedError("invalid_field", "Select an enabled runtime instance and one of its models.");
        const executionPolicy = payload.executionPolicy;
        if (executionPolicy !== undefined && !isResidentCeoExecutionPolicy(executionPolicy))
          throw context.hostCodedError("invalid_field", "executionPolicy must be advisory-only or approval-gated.");
        const autoApproveSenders =
          payload.autoApproveSenders !== undefined
            ? Array.isArray(payload.autoApproveSenders) &&
              payload.autoApproveSenders.every((entry): entry is string => typeof entry === "string")
              ? payload.autoApproveSenders
              : (() => {
                  throw context.hostCodedError("invalid_field", "autoApproveSenders must be an array of person ids.");
                })()
            : undefined;
        const gateMode = payload.gateMode;
        if (gateMode !== undefined && !isResidentCeoApprovalGateMode(gateMode))
          throw context.hostCodedError("invalid_field", "gateMode must be off, secondary-guard, or auto-promote.");
        const gateProviderId = payload.gateProviderId;
        if (gateProviderId !== undefined && gateProviderId !== null && typeof gateProviderId !== "string")
          throw context.hostCodedError(
            "invalid_field",
            "gateProviderId must be a decision provider id string or null.",
          );
        const gateMinConfidence = payload.gateMinConfidence;
        if (
          gateMinConfidence !== undefined &&
          (typeof gateMinConfidence !== "number" ||
            !Number.isFinite(gateMinConfidence) ||
            gateMinConfidence <= 0 ||
            gateMinConfidence > 1)
        )
          throw context.hostCodedError("invalid_field", "gateMinConfidence must be a finite number in (0, 1].");
        const hasGateUpdate = gateMode !== undefined || gateProviderId !== undefined || gateMinConfidence !== undefined;
        const approvalGate = hasGateUpdate
          ? {
              mode: gateMode ?? saved?.approvalGate?.mode ?? "off",
              ...(gateProviderId !== undefined
                ? { providerId: gateProviderId }
                : saved?.approvalGate?.providerId !== undefined
                  ? { providerId: saved.approvalGate.providerId }
                  : {}),
              ...(gateMinConfidence !== undefined
                ? { minConfidence: gateMinConfidence }
                : saved?.approvalGate?.minConfidence !== undefined
                  ? { minConfidence: saved.approvalGate.minConfidence }
                  : {}),
            }
          : undefined;
        const profile = await service.configure(principalPersonId, {
          repoId,
          runtimeInstanceId,
          model,
          heartbeatIntervalSec: Number(payload.heartbeatIntervalSec),
          ...(executionPolicy === undefined ? {} : { executionPolicy }),
          ...(payload.defaultWorkId === null || typeof payload.defaultWorkId === "string"
            ? { defaultWorkId: payload.defaultWorkId }
            : {}),
          ...(payload.defaultAgentId === null || typeof payload.defaultAgentId === "string"
            ? { defaultAgentId: payload.defaultAgentId }
            : {}),
          ...(autoApproveSenders === undefined ? {} : { autoApproveSenders }),
          ...(approvalGate === undefined ? {} : { approvalGate }),
        });
        if (profile.status === "running") watchResidentCeoInbox(repoId, principalPersonId);
        return receipt(profile, "Resident CEO configuration saved.");
      }
      if (operation === "start") {
        const profile = await service.start(principalPersonId, repoId);
        watchResidentCeoInbox(repoId, principalPersonId);
        return receipt(profile, "Resident CEO started.");
      }
      if (operation === "stop") {
        const profile = await service.stop(principalPersonId, repoId);
        residentCeoInboxWatchers.get(residentCeoWatcherKey(repoId, principalPersonId))?.abort();
        return receipt(profile, "Resident CEO stopped.");
      }
      if (operation === "approve") {
        const proposalId = String(payload.proposalId ?? "").trim();
        if (!proposalId) throw context.hostCodedError("invalid_field", "proposalId is required.");
        const approved = await service.approveProposal(
          principalPersonId,
          {
            proposalId,
            ...(typeof payload.workId === "string" ? { workId: payload.workId } : {}),
            ...(typeof payload.title === "string" ? { title: payload.title } : {}),
            ...(typeof payload.agentId === "string" ? { agentId: payload.agentId } : {}),
            ...(typeof payload.targetNodeId === "string" ? { targetNodeId: payload.targetNodeId } : {}),
            ...(typeof payload.supersedesTaskId === "string" ? { supersedesTaskId: payload.supersedesTaskId } : {}),
            ...(typeof payload.runtimeInstanceId === "string" ? { runtimeInstanceId: payload.runtimeInstanceId } : {}),
            ...(typeof payload.model === "string" ? { model: payload.model } : {}),
            ...(typeof payload.prompt === "string" ? { prompt: payload.prompt } : {}),
          },
          repoId,
        );
        return {
          ...receipt(
            approved.profile,
            `Approved proposal ${approved.proposal.proposalId} -> task/${approved.proposal.promotedTaskId}` +
              `${approved.proposal.supersededTaskId ? ` (superseded task/${approved.proposal.supersededTaskId})` : ""}` +
              `${approved.proposal.supersedeError ? ` (supersede error: ${approved.proposal.supersedeError})` : ""}` +
              `${approved.proposal.dispatchedTargetNodeId ? ` (assigned to node/${approved.proposal.dispatchedTargetNodeId})` : ""}` +
              `${approved.proposal.dispatchRuntimeSessionId ? ` (dispatched ${approved.proposal.dispatchRuntimeSessionId})` : ""}` +
              `${approved.proposal.dispatchError ? ` (dispatch error: ${approved.proposal.dispatchError})` : ""}.`,
          ),
          proposal: approved.proposal as unknown as JsonObject,
          promotedTaskId: approved.proposal.promotedTaskId,
          supersededTaskId: approved.proposal.supersededTaskId ?? null,
          supersedeError: approved.proposal.supersedeError ?? null,
          dispatchedTargetNodeId: approved.proposal.dispatchedTargetNodeId ?? null,
          dispatchRuntimeSessionId: approved.proposal.dispatchRuntimeSessionId,
          dispatchError: approved.proposal.dispatchError,
        };
      }
      if (operation === "reject") {
        const proposalId = String(payload.proposalId ?? "").trim();
        const reason = String(payload.reason ?? "").trim();
        if (!proposalId) throw context.hostCodedError("invalid_field", "proposalId is required.");
        if (!reason) throw context.hostCodedError("invalid_field", "Rejection reason (--reason) is required.");
        const rejected = await service.rejectProposal(principalPersonId, { proposalId, reason }, repoId);
        return {
          ...receipt(rejected.profile, `Rejected proposal ${rejected.proposal.proposalId}: ${reason}`),
          proposal: rejected.proposal as unknown as JsonObject,
        };
      }
      const message = String(payload.message ?? "").trim();
      if (!message) throw context.hostCodedError("invalid_field", "A chat message is required.");
      if (saved?.status === "running" && saved.lastWake?.status === "running")
        await reconcileRunningResidentCeoWake(repoId, principalPersonId, saved, auth, { waitForSettlement: false });
      const chatPrompt = saved ? buildResidentCeoHumanChatPrompt(saved, message) : message;
      const result = await runTrackedResidentCeoWake(residentCeoWatcherKey(repoId, principalPersonId), () =>
        service.wake(principalPersonId, "human-chat", chatPrompt, undefined, repoId, { requestText: message }),
      );
      const actionReceipts = "actionReceipts" in result ? result.actionReceipts : undefined;
      return {
        ...receipt(result.profile, result.response ?? ""),
        response: result.response,
        ...(actionReceipts && actionReceipts.length > 0
          ? { actionReceipts: actionReceipts as unknown as JsonObject[] }
          : {}),
      };
    },
    attach: async (repoId, runtimeSessionId, afterCursor, auth) => {
      context.requireHostMode(repoId, repoReadCommandTopology, auth);
      await context.attemptHostRecovery(repoId);
      guardCenterRelocation(repoId, false);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      await context.binding(cell.status().rootDir, auth);
      return cell.attach(runtimeSessionId, afterCursor, auth.connectionSignal);
    },
    spawnRuntime: async (repoId, payload, auth) => {
      const edgeReceipt = await runRemoteEdgeRuntime(repoId, "repo.agentRuntime.spawn", payload, auth);
      if (edgeReceipt) return edgeReceipt;
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-run"), auth);
      await context.attemptHostRecovery(repoId);
      guardCenterRelocation(repoId, true);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      const receipt = await cell.spawnRuntime(
        payload,
        await context.binding(cell.status().rootDir, auth, undefined, repoId),
      );
      return annotateHostingCredentialNotice(receipt, payload, cell.status().rootDir, {
        repoId,
        instances: context.instances.list(),
      });
    },
    cancelRuntime: async (repoId, payload, auth) => {
      const edgeReceipt = await runRemoteEdgeRuntime(repoId, "repo.agentRuntime.cancel", payload, auth);
      if (edgeReceipt) return edgeReceipt;
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-cancel"), auth);
      await context.attemptHostRecovery(repoId);
      guardCenterRelocation(repoId, true);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return cell.cancelRuntime(payload, await context.binding(cell.status().rootDir, auth, undefined, repoId));
    },
    steerRuntime: async (repoId, payload, auth) => {
      const edgeReceipt = await runRemoteEdgeRuntime(repoId, "repo.agentRuntime.steer", payload, auth);
      if (edgeReceipt) return edgeReceipt;
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-steer"), auth);
      await context.attemptHostRecovery(repoId);
      guardCenterRelocation(repoId, true);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return cell.steerRuntime(payload, await context.binding(cell.status().rootDir, auth, undefined, repoId));
    },
    handoffRuntime: async (repoId, payload, auth) => {
      const edgeReceipt = await runRemoteEdgeRuntime(repoId, "repo.agentRuntime.handoff", payload, auth);
      if (edgeReceipt) return edgeReceipt;
      context.requireHostMode(repoId, commandDescriptorForAction(`runtime-handoff-${String(payload.operation)}`), auth);
      await context.attemptHostRecovery(repoId);
      guardCenterRelocation(repoId, true);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return cell.handoffRuntime(payload, await context.binding(cell.status().rootDir, auth, undefined, repoId));
    },
    batchRuntime: async (repoId, payload, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-batch"), auth);
      await context.attemptHostRecovery(repoId);
      guardCenterRelocation(repoId, true);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return orchestrateRuntimeBatch(
        payload,
        hostOrchestration(repoId, cell, await context.binding(cell.status().rootDir, auth, undefined, repoId), auth),
      );
    },
    awaitRuntimeSessions: async (repoId, payload, auth) => {
      const edgeReceipt = await runRemoteEdgeRuntime(repoId, "repo.agentRuntime.sessions.await", payload, auth);
      if (edgeReceipt) return edgeReceipt;
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-sessions-await"), auth);
      await context.attemptHostRecovery(repoId);
      context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return orchestrateRuntimeSessionsAwait(payload, {
        readSession: (runtimeSessionId) =>
          context.host.read(repoId, "repo.agentRuntime.sessions.read", { runtimeSessionId }, auth),
        readTaskDispatches: (taskIds) =>
          readAllTaskDispatchPages((facets) =>
            context.host.read(
              repoId,
              "repo.task.dispatches",
              { taskIds: taskIds as string[], limit: 16, ...facets },
              auth,
            ),
          ),
        signalVersion: () =>
          context.requiredCell(context.cells, context.warming, context.unavailable, repoId).runtimeSignalVersion(),
        awaitSignal: async (observedVersion) => {
          await context.waitForWarming(repoId);
          return context
            .requiredCell(context.cells, context.warming, context.unavailable, repoId)
            .awaitRuntimeSignal(observedVersion);
        },
        connectionSignal: auth.connectionSignal,
        codedError: context.hostCodedError,
      });
    },
    runtimeIngress: async (repoId, action, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-run"), auth);
      await context.attemptHostRecovery(repoId);
      guardCenterRelocation(repoId, true);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      const receipt = await cell.runtimeIngress(
        action,
        await context.binding(cell.status().rootDir, auth, undefined, repoId),
      );
      if (
        cell.status().mode === "local" &&
        action.kind === "event" &&
        action.type === "runtime_session_outcome_observed" &&
        receipt.outcome === "applied"
      ) {
        void context
          .decisionPointExecutorFor(repoId, cell.status().rootDir)
          .settle(
            cell,
            receipt.event as unknown as Extract<
              import("@harness-anything/kernel").AgentRuntimeEventV1,
              { readonly type: "runtime_session_outcome_observed" }
            >,
          )
          .catch((error: unknown) => console.error(error));
      }
      return receipt;
    },
    terminalAttach: async (repoId, { sessionId, afterSeq, daemonGeneration }, auth) => {
      context.requireHostMode(repoId, repoReadCommandTopology, auth);
      await context.attemptHostRecovery(repoId);
      guardCenterRelocation(repoId, false);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      await context.binding(cell.status().rootDir, auth);
      return cell.terminal.attach(sessionId, afterSeq, daemonGeneration);
    },
    terminalAction: async (repoId, method, payload, auth) => {
      if (
        method === "repo.gui.catalog.reread" &&
        readDaemonRegistry({ userRoot: context.input.userRoot }).repos.some(
          (repo) => repo.repoId === repoId && repo.state === "enabled" && repo.mode === "remote-edge",
        )
      ) {
        const snapshot = await context.host.read(repoId, "repo.gui.catalog.snapshot", {}, auth);
        const digest = snapshot.catalogDigest as string;
        return catalogRereadReceipt({
          repoId,
          beforeDigest: digest,
          afterDigest: digest,
          observedAt: new Date().toISOString(),
          rejected: typeof payload.expectedDigest === "string" && payload.expectedDigest !== digest,
        }) as JsonObject;
      }
      const commandTopology = daemonRpcCommandTopology(method);
      context.requireHostMode(repoId, commandTopology, auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId),
        serverBinding = await context.binding(
          cell.status().rootDir,
          auth,
          undefined,
          commandTopology.commandClass === "repo-read" ? undefined : repoId,
        );
      if (method === "repo.gui.catalog.reread") return cell.catalog.reread(payload) as Promise<JsonObject>;
      const kind =
          method === "repo.terminal.spawn"
            ? "terminal-spawn"
            : method === "repo.terminal.input"
              ? "terminal-input"
              : method === "repo.terminal.resize"
                ? "terminal-resize"
                : method === "repo.terminal.terminate"
                  ? "terminal-terminate"
                  : null,
        authorizationDecision = kind
          ? await requireAuthorizedHostAction({
              kind,
              repoId,
              binding: serverBinding,
              actionId: `${kind}:${String(payload.idempotencyKey ?? payload.sessionId ?? "current")}`,
              evaluatedAtCut: `repository:${repoId}:current`,
            })
          : null,
        authorizedBinding = authorizationDecision ? { ...serverBinding, authorizationDecision } : serverBinding,
        frame = (result: JsonObject): JsonObject =>
          authorizationDecision
            ? { ...result, authorizationDecision: authorizationDecision as unknown as JsonObject }
            : result;
      if (method === "repo.terminal.spawn") return frame(await cell.terminal.spawn(payload, authorizedBinding));
      if (method === "repo.terminal.input") return frame(cell.terminal.input(payload, authorizedBinding));
      if (method === "repo.terminal.resize") return frame(cell.terminal.resize(payload, authorizedBinding));
      if (method === "repo.terminal.detach") return cell.terminal.detach(payload);
      if (method === "repo.terminal.terminate") return frame(cell.terminal.terminate(payload, authorizedBinding));
      throw context.hostCodedError("unsupported_command", `Unsupported terminal or catalog method: ${method}.`);
    },
    authorize: async (repoId, kind, auth, target) => {
      guardCenterRelocation(repoId, false);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      const binding = await context.binding(cell.status().rootDir, auth);
      const scopes = await resolveTaskReadAuthorizationScopes(cell, target, auth.connectionSignal);
      if (binding.executionPrincipal)
        for (const entityRef of scopes)
          requireExecutionActionScope(binding.executionPrincipal, {
            kind,
            ...(entityRef === undefined ? {} : { taskId: entityRef.slice("task/".length) }),
          });
      const readTask = await prepareBatchTaskAncestorReader(cell, scopes, auth.connectionSignal);
      if (kind === "repository-read" || kind === "fleet-overview-read")
        return evaluateFleetActionBatch({
          kind,
          binding,
          repoId,
          scopes,
          evaluatedAtCut: `repository:${repoId}:current`,
          ...(readTask === undefined ? {} : { readTask }),
          ...(target?.opaqueDenial === true ? { opaqueDenial: true } : {}),
        });
      let decision: AuthorizationDecision | undefined;
      for (const entityRef of scopes) {
        const taskId = entityRef?.slice("task/".length);
        decision =
          taskId !== undefined
            ? await evaluateRepoCellAction({
                action: { kind, taskId },
                binding,
                actionId: `${kind}:${repoId}:${taskId}`,
                repoId,
                revision: cell.status().ledgerRevision ?? 0,
                now: new Date().toISOString(),
                ...(readTask === undefined ? {} : { readTask }),
              })
            : await evaluateFleetAction({
                kind,
                binding,
                actionId: `${kind}:${repoId}`,
                evaluatedAtCut: `repository:${repoId}:current`,
                repoId,
              });
        if (decision.outcome === "denied") return decision;
      }
      return decision!;
    },
    fleet: {
      readCenterExternalAddress: async (auth) => {
        const config = readFleetCenterConfig(context.input.userRoot, context.input.daemonId);
        if (!config) return { ok: true, externalUrl: null };
        await authorizeCenterConfiguration(config.repoId, auth);
        const importedRouting = readCenterRelocationRouting(config.stateRoot, config.repoId);
        return { ok: true, externalUrl: config.externalUrl ?? importedRouting?.externalUrl ?? null };
      },
      readCenterState: async (auth) => {
        const config = readFleetCenterConfig(context.input.userRoot, context.input.daemonId);
        if (!config)
          return {
            ok: true,
            running: false,
            port: null,
            bind: null,
            externalUrl: null,
            repoId: null,
            quotaBytes: null,
            certificateSource: null,
            uploads: null,
          };
        await authorizeCenterConfiguration(config.repoId, auth);
        const loginListener = context.loginListenerCertificate();
        return {
          ok: true,
          running: context.fleetCenter !== null,
          port: config.port,
          bind: config.bind,
          externalUrl: config.externalUrl ?? null,
          repoId: config.repoId,
          quotaBytes: config.quotaBytes,
          uploads: context.fleetCenter?.status().uploads ?? null,
          certificateSource:
            loginListener !== null && loginListener.certificateFile === config.certPath ? "login-listener" : "explicit",
        };
      },
      setCenterExternalAddress: async (payload, auth) => {
        if (centerStarting)
          throw context.hostCodedError(
            "fleet_center_running",
            "Fleet center configuration is already changing on this daemon; wait for that operation to finish.",
          );
        centerStarting = true;
        try {
          const config = readFleetCenterConfig(context.input.userRoot, context.input.daemonId);
          if (!config)
            throw context.hostCodedError(
              "fleet_center_unavailable",
              "Start the fleet center before setting its external address.",
            );
          await authorizeCenterConfiguration(config.repoId, auth);
          const externalUrl = parseFleetCenterExternalUrl(String(payload.externalUrl));
          validateCertificateNames(readFileSync(config.certPath), [
            new URL(externalUrl).hostname.replace(/^\[|\]$/gu, ""),
          ]);
          saveFleetCenterConfig(context.input.userRoot, context.input.daemonId, { ...config, externalUrl });
          const reachable = await probeTlsAddress(externalUrl);
          return {
            ok: true,
            externalUrl,
            ...(reachable
              ? { warning: null }
              : {
                  warning:
                    `The center could not reach ${externalUrl} from this machine. This can be caused by hairpin NAT; ` +
                    "the address is saved, but each edge node must still be able to reach it.",
                }),
          };
        } finally {
          centerStarting = false;
        }
      },
      startCenter: async (payload, auth) => {
        if (centerStarting)
          throw context.hostCodedError(
            "fleet_center_running",
            "A fleet center start is already in progress on this daemon; wait for its receipt before retrying.",
          );
        centerStarting = true;
        let releaseCertificates: (() => void) | undefined;
        try {
          const rawRequest = payload as unknown as FleetCenterAdmissionRequest["payload"];
          if ((rawRequest.keyPath === undefined) !== (rawRequest.certPath === undefined))
            throw context.hostCodedError(
              "invalid_field",
              "Fleet TLS takes --key and --cert together; pass both, or neither to reuse the login service certificate.",
            );
          const authorityRepoId = rawRequest.repoId,
            authorityRepo = readDaemonRegistry({ userRoot: context.input.userRoot }).repos.find(
              (repo): repo is typeof repo & { readonly canonicalRoot: string } =>
                repo.repoId === authorityRepoId &&
                repo.state === "enabled" &&
                repo.mode !== "remote-proxy" &&
                repo.canonicalRoot !== null,
            );
          if (!authorityRepo)
            throw context.hostCodedError(
              "repo_namespace_unknown",
              "Fleet center requires one enabled authority repository.",
            );
          const authorizationDecision = await requireAuthorizedHostAction({
            kind: "daemon-fleet-center-start",
            repoId: authorityRepo.repoId,
            binding: await context.binding(authorityRepo.canonicalRoot, auth),
            actionId: `daemon-fleet-center-start:${authorityRepo.repoId}`,
            evaluatedAtCut: "fleet-center:current",
          });
          const loginListener = rawRequest.keyPath === undefined ? context.loginListenerCertificate() : null;
          const certificate =
            rawRequest.keyPath !== undefined
              ? { keyPath: rawRequest.keyPath, certPath: rawRequest.certPath as string }
              : loginListener !== null
                ? { keyPath: loginListener.certificateKeyFile, certPath: loginListener.certificateFile }
                : null;
          if (certificate === null)
            throw context.hostCodedError(
              "rbac_listener_invalid",
              "The start carried no certificate and the login service has no listener certificate to reuse; configure the login listener first, or pass --key and --cert.",
            );
          const stateRootForRouting = rawRequest.stateRoot ?? path.join(context.input.userRoot, "fleet"),
            externalUrl =
              rawRequest.externalUrl ??
              readFleetCenterConfig(context.input.userRoot, context.input.daemonId)?.externalUrl ??
              readCenterRelocationRouting(stateRootForRouting, authorityRepoId)?.externalUrl,
            request = {
              ...rawRequest,
              keyPath: certificate.keyPath,
              certPath: certificate.certPath,
              ...(externalUrl === undefined ? {} : { externalUrl: parseFleetCenterExternalUrl(externalUrl) }),
            };
          releaseCertificates = retainFleetCenterCertificatePaths(
            context.input.userRoot,
            request.certPath,
            request.keyPath,
          );
          const prepared = await prepareFleetCenterAdmission({
            host: context.host,
            storage: context.input.storage,
            buildDraining: context.input.buildDraining,
            onDeliverySettled: context.input.onRepoStatusChange,
            onNodeDisconnected: () => context.triggerCenterReviewFallback?.("fleet-node-disconnected"),
            recordTraffic: context.input.recordTraffic,
            onRequestStarted: context.input.onFleetRequestStarted,
            onRequestSettled: context.input.onFleetRequestSettled,
            ...(context.input.authenticateExecutionPrincipal
              ? { authenticateExecutionPrincipal: context.input.authenticateExecutionPrincipal }
              : {}),
            userRoot: context.input.userRoot,
            writerEpochLease: context.writerEpochLease,
            onSwitchoverControl: createDaemonSwitchoverControlHandler({
              userRoot: context.input.userRoot,
              stateRoot: stateRootForRouting,
              withReplicaSyncFence: context.withReplicaSyncFence,
              closeCell: context.closeCell,
              attachLocalRepo: async (canonicalRootDir, targetRepoId) => {
                await context.attach(canonicalRootDir, targetRepoId, "local");
              },
              resetWriterEpochCache: context.resetWriterEpochHandle,
              rebindRouting: (params) =>
                rebindCenterRelocationRouting({
                  ...params,
                  userRoot: context.input.userRoot,
                  daemonId: context.input.daemonId,
                  stateRoot: stateRootForRouting,
                }),
              now: context.now,
            }),
            payload: request,
            nodes: {
              ...keycloakNodeRegistry(context.keycloakCenter),
              loginAuthority: (nodeId) => context.oidc.discovery(nodeId),
              ...(context.oidc.revokeDeviceSessions
                ? { revokeDeviceSessions: (nodeId: string) => context.oidc.revokeDeviceSessions!(nodeId) }
                : {}),
              ...(context.oidc.receiveDeviceNotice
                ? {
                    deviceLoginNotice: (nodeId: string, personId: string, notice: FleetDeviceLoginNotice) =>
                      context.oidc.receiveDeviceNotice!(nodeId, personId, notice),
                  }
                : {}),
              verifyHuman: (auth) => context.oidc.bind(auth),
              ...(context.oidc.bindReplica
                ? { verifyReplica: (auth: DaemonAuthenticationContext) => context.oidc.bindReplica!(auth) }
                : {}),
              createMemberEdgeJoin: (repos, person, token) =>
                context.accessAdmin.createMemberEdgeJoin(repos, person, token),
              edgeJoinStatus: (input) => context.accessAdmin.edgeJoinStatus(input),
              edgeJoin: (input) =>
                context.accessAdmin.admitEdgeJoin({
                  joinId: input.joinId,
                  inviteToken: input.inviteToken,
                  ...(input.recovery ? { recovery: input.recovery } : {}),
                  accessToken: input.accessToken,
                }),
            },
          });
          await context.waitForWarming(authorityRepoId);
          if (!context.input?.userRoot || centerMovedError(context.input.userRoot, authorityRepoId) === null)
            context.requiredCell(context.cells, context.warming, context.unavailable, authorityRepoId);
          const replaced = context.fleetCenter !== null;
          if (context.fleetCenter) {
            const previous = context.fleetCenter;
            context.fleetCenter = null;
            await context.accessAdmin.stopEdgeJoinTunnels();
            await previous.close();
          }
          try {
            const started = await startFleetCenterAdmission(prepared);
            try {
              saveFleetCenterConfig(context.input.userRoot, context.input.daemonId, {
                port: started.center.port,
                bind: request.bind ?? "127.0.0.1",
                ...(request.externalUrl ? { externalUrl: request.externalUrl } : {}),
                keyPath: path.resolve(request.keyPath),
                certPath: path.resolve(request.certPath),
                repoId: request.repoId,
                quotaBytes: request.quotaBytes,
                stateRoot: path.resolve(started.stateRoot),
              });
              releaseCertificates();
              releaseCertificates = undefined;
            } catch (error) {
              await started.center.close();
              throw error;
            }
            context.fleetCenter = started.center;
            context.triggerCenterReviewFallback?.("fleet-center-started");
            await context.accessAdmin.resumeEdgeJoinTunnels(started.center.port);
            if (authorityRepo.mode === "remote-edge") {
              const edgeConfig = readFleetEdgeConfig(context.input.userRoot, authorityRepo.repoId);
              if (edgeConfig) {
                const candidateTokenReader = createFleetReplicaAccessTokenReader({
                  config: edgeConfig,
                  configDir: fleetEdgeConfigDir(context.input.userRoot, authorityRepo.repoId),
                  readUserAccessToken: async () =>
                    resolveBoundAccessToken(await context.oidc.bind(auth, authorityRepo.canonicalRoot)),
                });
                const discoveredLogin = context.oidc.discovery(edgeConfig.nodeId);
                await announceSwitchoverCandidateToCenter({
                  userRoot: context.input.userRoot,
                  repoId: authorityRepo.repoId,
                  canonicalRoot: authorityRepo.canonicalRoot,
                  listenerPort: started.center.port,
                  listenerBind: request.bind ?? "127.0.0.1",
                  ...(request.externalUrl ? { listenerExternalUrl: request.externalUrl } : {}),
                  listenerCertPath: path.resolve(request.certPath),
                  ...(discoveredLogin?.url ? { fallbackLoginUrl: discoveredLogin.url } : {}),
                  ...(discoveredLogin?.certificate ? { fallbackLoginCertificate: discoveredLogin.certificate } : {}),
                  ...(discoveredLogin?.servername ? { fallbackLoginServername: discoveredLogin.servername } : {}),
                  readAccessToken: candidateTokenReader,
                });
              }
            }
            const externalAddressReachable = request.externalUrl
              ? await probeTlsAddress(request.externalUrl)
              : undefined;
            return {
              schema: "command-receipt/v2",
              ok: true,
              command: "daemon-fleet-center-start",
              outcome: "applied",
              port: started.center.port,
              bind: request.bind ?? "127.0.0.1",
              ...(request.externalUrl ? { externalUrl: request.externalUrl } : {}),
              ...(externalAddressReachable === false
                ? {
                    externalAddressWarning:
                      `The center could not reach ${request.externalUrl} from this machine. This can be caused by hairpin NAT; ` +
                      "the address is saved, but each edge node must still be able to reach it.",
                  }
                : {}),
              stateRoot: started.stateRoot,
              quotaBytes: request.quotaBytes,
              replicas: started.center.status().replicas,
              replaced,
              serviceStatus: "listening",
              authorizationDecision: authorizationDecision as unknown as JsonObject,
            };
          } catch (error) {
            throw context.hostCodedError(
              "fleet_center_start_failed",
              `Fleet center is not listening; start failed: ${error instanceof Error ? error.message : String(error)}. ` +
                "The last successfully saved configuration is retained for daemon restart; no automatic rollback was performed.",
            );
          }
        } finally {
          releaseCertificates?.();
          centerStarting = false;
        }
      },
      edgeSync: async (payload, auth) => {
        const request = payload as unknown as FleetEdgeSyncRequest["payload"] & { readonly repoint?: unknown },
          repoint = request.repoint === true,
          registered = readDaemonRegistry({ userRoot: context.input.userRoot }).repos.find(
            (repo) => repo.repoId === request.repoId && repo.state === "enabled",
          ),
          registeredRoot = registered?.canonicalRoot;
        if (
          !registered ||
          registered.mode !== "remote-edge" ||
          typeof registeredRoot !== "string" ||
          canonicalRoot(request.workspaceRoot) !== canonicalRoot(registeredRoot)
        )
          throw context.hostCodedError(
            "repo_mode_read_only",
            repoint
              ? "Fleet edge repoint requires the matching enabled remote-edge registration."
              : "Fleet edge sync requires the matching enabled remote-edge registration.",
          );
        context.localOnly(auth);
        // Ensure startup repository attachments have settled before sync/repoint starts or waits on
        // the resident replica stream; otherwise startReplicaSyncs() defers and waitForFleetReplicaReady()
        // observes no live stream and surfaces stale on-disk replica-health failures.
        if (context.initialAttachments && !context.initialAttachmentsSettled?.())
          await context.startInitialAttachments();
        const persistedConfig = readFleetEdgeConfig(context.input.userRoot, request.repoId),
          edgeRoot = registeredRoot as string;
        if (repoint) {
          const { workspaceRoot: _workspaceRoot, repoint: _repoint, ...repointPayload } = request;
          return repointFleetEdgeMirror(
            {
              userRoot: context.input.userRoot,
              workspaceRoot: edgeRoot,
              payload: repointPayload as FleetEdgeRepointRequest["payload"],
            },
            context.withReplicaSyncFence,
            context.repointStreamHooks(request.repoId),
          );
        }
        const syncRequest = request as FleetEdgeSyncRequest["payload"],
          matchingConfig =
            persistedConfig?.repoId === syncRequest.repoId &&
            persistedConfig.host === syncRequest.host &&
            persistedConfig.port === syncRequest.port &&
            persistedConfig.nodeId === syncRequest.nodeId
              ? persistedConfig
              : null,
          effectiveSyncPayload: FleetEdgeSyncRequest["payload"] =
            matchingConfig?.spkiPinOnly &&
            matchingConfig.caPath === syncRequest.caPath &&
            (!syncRequest.spkiSha256 || syncRequest.spkiSha256 === matchingConfig.spkiSha256)
              ? { ...syncRequest, spkiSha256: matchingConfig.spkiSha256, spkiPinOnly: true }
              : syncRequest,
          readAccessToken = createFleetReplicaAccessTokenReader({
            config: {
              ...effectiveSyncPayload,
              ...(matchingConfig?.loginUrl ? { loginUrl: matchingConfig.loginUrl } : {}),
              ...(matchingConfig?.loginRealm ? { loginRealm: matchingConfig.loginRealm } : {}),
              ...(matchingConfig?.loginServername ? { loginServername: matchingConfig.loginServername } : {}),
              ...(matchingConfig?.loginCertificate ? { loginCertificate: matchingConfig.loginCertificate } : {}),
            },
            configDir: fleetEdgeConfigDir(context.input.userRoot, syncRequest.repoId),
            readUserAccessToken: async () =>
              resolveBoundAccessToken(await context.oidc.bind(auth, syncRequest.workspaceRoot)),
          });
        const receipt = await syncFleetEdgeMirror(
          { userRoot: context.input.userRoot, payload: effectiveSyncPayload },
          readAccessToken,
          () => context.startReplicaSyncs(),
          context.edgeSyncConfigFence,
        );
        await runReplicaConfirmedRound({
          reconcile: async () => {
            const result = await context.forwardRuntime({
              repoId: syncRequest.repoId,
              method: "repo.squad.control",
              action: {},
              operation: "reconcile",
              auth: { transportKind: "unix-socket" },
            });
            if (!result)
              throw context.hostCodedError("fleet_edge_config_invalid", "The registered remote-edge is unavailable.");
          },
          observeRecovery: (failures) =>
            context.runtimeRecoveryWatch.observe(syncRequest.repoId, failures, context.now()),
          triggers: [() => context.scheduleScheduler.refresh()],
        });
        return receipt;
      },
      edgeRuntime: async (payload, auth) => {
        context.localOnly(auth);
        const request = payload as unknown as FleetEdgeRuntimeRequest["payload"],
          receipt = await runRemoteEdgeRuntime(request.repoId, request.method, request.action, auth);
        if (!receipt)
          throw context.hostCodedError(
            "repo_mode_read_only",
            "Fleet runtime requires an enabled remote-edge registration.",
          );
        return receipt;
      },
    },
    system: context.system,
    runtimeInstance: async (method, payload, auth, repoId) => {
      const readOnlyExecution = auth.executionPrincipal?.role === "read-only";
      let parsedReadOnlyList: { readonly all: boolean } | null = null;
      if (auth.executionPrincipal) {
        if (!readOnlyExecution) throw executionCredentialRejected();
        if (method !== "daemon.runtimeInstance.list") throw executionCredentialRejected("read-only-allowlist");
        if (repoId !== undefined && repoId !== auth.executionPrincipal.repoId) throw executionCredentialRejected();
        parsedReadOnlyList = parseReadOnlyRuntimeInstanceListPayload(payload);
      }
      const operation = method.replace("daemon.runtimeInstance.", ""),
        effectiveRepoId = repoId ?? auth.executionPrincipal?.repoId,
        nodeId = runtimeNodeId(effectiveRepoId),
        actionKind =
          operation === "hostingCredential.set" || operation === "hostingCredential.unset"
            ? `runtime-instance-${operation === "hostingCredential.set" ? "hosting-credential-set" : "hosting-credential-unset"}`
            : ["create", "list", "show", "update", "delete"].includes(operation)
              ? `runtime-instance-${operation}`
              : null;
      if (!actionKind)
        throw context.hostCodedError("unsupported_command", `Unsupported runtime instance method: ${method}.`);
      const authorizationDecision = await requireAuthorizedFleetAction({
        kind: actionKind,
        userRoot: context.input.userRoot,
        auth,
        actionId: `${actionKind}:${String(payload.instanceId ?? "catalog")}`,
        evaluatedAtCut: "runtime-instances:current",
        now: context.now(),
      });
      const needsInstallationWitness =
        !readOnlyExecution &&
        (payload.probe === true ||
          actionKind === "runtime-instance-create" ||
          (actionKind === "runtime-instance-update" &&
            (payload.installationId !== undefined || context.instances.recordedInstallations() === null)) ||
          (actionKind === "runtime-instance-list" && context.instances.recordedInstallations() === null));
      if (needsInstallationWitness) await context.instances.refreshInstallations();
      const commandPayload = parsedReadOnlyList ?? payload;
      const receipt = (await context.instances.command({
        ...commandPayload,
        kind: actionKind,
      })) as JsonObject;
      if (operation === "update" && payload.clearFreeze === true && typeof payload.instanceId === "string")
        context.runtimePorts.runtimeProviderHealth.reset(payload.instanceId, context.now());
      const withHealth = (value: unknown): unknown => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
        const instance = value as Record<string, unknown>;
        return typeof instance.instanceId === "string"
          ? {
              ...instance,
              providerHealth: {
                ...context.runtimePorts.runtimeProviderHealth.get(instance.instanceId),
                nodeId,
              },
            }
          : value;
      };
      const instances = Array.isArray(receipt.instances) ? receipt.instances.map(withHealth) : undefined;
      if (readOnlyExecution)
        return projectReadOnlyRuntimeInstanceList({
          instances: (instances ?? []) as readonly Record<string, unknown>[],
          nodeId,
          now: context.now(),
        });
      const instance = receipt.instance === undefined ? undefined : withHealth(receipt.instance),
        summary =
          instances === undefined
            ? receipt.summary
            : [
                receipt.summary,
                "",
                "NODE\tID\tNAME\tKIND\tMODEL\tENABLED\tHEALTH\tREASON\tRECOVER AT",
                ...(instances as Record<string, unknown>[]).map((row) => {
                  const health = row.providerHealth as Record<string, unknown>,
                    stringField = (value: unknown): string | null => (typeof value === "string" ? value : null),
                    projected = projectRuntimeProviderHealth(
                      {
                        frozen: health.frozen === true,
                        cooldownUntil: stringField(health.cooldownUntil),
                        frozenUntil: stringField(health.frozenUntil),
                        quotaExhaustedUntil: stringField(health.quotaExhaustedUntil),
                        reason: stringField(health.reason),
                      },
                      context.now(),
                    );
                  return [
                    health.nodeId,
                    row.instanceId,
                    row.name,
                    row.kindId,
                    Array.isArray(row.models) ? row.models.join(",") : "",
                    row.enabled ? "enabled" : "disabled",
                    projected.status,
                    projected.reason ?? "-",
                    projected.recoverAt ?? "-",
                  ].join("\t");
                }),
              ]
                .filter((value): value is string => typeof value === "string")
                .join("\n");
      return {
        ...receipt,
        ...(operation === "list" ? { nodeId } : {}),
        ...(instances === undefined ? {} : { instances }),
        ...(instance === undefined ? {} : { instance }),
        ...(summary === undefined ? {} : { summary }),
        ...(operation === "update" && payload.clearFreeze === true ? { providerHealthCleared: true } : {}),
        authorizationDecision: authorizationDecision as unknown as JsonObject,
      } as JsonObject;
    },
    decisionProvider: async (method, payload, auth) => {
      context.localOnly(auth);
      const operation = method.replace("daemon.provider.", ""),
        actionKind = ["create", "list", "show", "update", "probe", "delete"].includes(operation)
          ? `provider-${operation}`
          : null;
      if (!actionKind) throw context.hostCodedError("unsupported_command", `Unsupported provider method: ${method}.`);
      const authorizeProvider = (kind: string) =>
        requireAuthorizedFleetAction({
          kind,
          userRoot: context.input.userRoot,
          auth,
          actionId: `${kind}:${String(payload.providerId ?? "current")}`,
          evaluatedAtCut: "host:current",
        });
      const authorizationDecision = await (actionKind === "provider-show"
        ? authorizeProvider("provider-show")
        : authorizeProvider(actionKind));
      return {
        ...((await context.decisionProviders.command({ ...payload, kind: actionKind })) as JsonObject),
        authorizationDecision: authorizationDecision as unknown as JsonObject,
      };
    },
    runtimeInstanceAuth: async (repoId, method, payload, auth) => {
      context.requireHostMode(repoId, ledgerWriteCommandTopology, auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId),
        serverBinding = await context.binding(cell.status().rootDir, auth),
        operation = method.slice("repo.runtimeInstance.auth.".length);
      if (!["login", "logout"].includes(operation))
        throw context.hostCodedError("unsupported_command", `Unsupported runtime auth method: ${method}.`);
      const instanceId = context.requiredText(payload.instanceId, "instanceId"),
        actionKind = operation === "logout" ? "runtime-instance-logout" : "runtime-instance-login",
        authorizationDecision = await requireAuthorizedHostAction({
          kind: actionKind,
          repoId,
          binding: serverBinding,
          actionId: `${actionKind}:${instanceId}`,
          evaluatedAtCut: `repository:${repoId}:current`,
        });
      await context.instances.refreshInstallations();
      const command = context.instances.prepareAuthCommand(instanceId, operation as "login" | "logout"),
        env = Object.fromEntries(
          Object.entries(command.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
        idempotencyKey = context.requiredText(payload.idempotencyKey, "idempotencyKey");
      let sessionCut: RuntimeInstanceAccountCut | undefined;
      const result = cell.terminal.spawnTrusted(
        {
          idempotencyKey,
          name: `${command.name} · ${operation === "logout" ? "Sign out" : "Sign in"}`,
          executablePath: command.executablePath,
          args: command.args,
          env,
          cwd: command.cwd,
          publicCwd: `runtime-instance:${command.instanceId}`,
          profile: "runtime-auth",
          onBeforeSpawn: () => {
            context.instances.rejectActiveAuthSession(command.instanceId);
          },
          onAdmitted: () => {
            sessionCut =
              context.instances.beginAuthSession(
                command.instanceId,
                idempotencyKey,
                command.accountCut,
                operation as "login" | "logout",
              ) ?? undefined;
          },
          onExit: (exitCode) => {
            context.instances.completeAuthSession(
              command.instanceId,
              idempotencyKey,
              operation as "login" | "logout",
              exitCode,
              sessionCut ?? command.accountCut,
            );
          },
        },
        { ...serverBinding, authorizationDecision },
      ) as JsonObject;
      return { ...result, authorizationDecision: authorizationDecision as unknown as JsonObject };
    },
  };
}
