import path from "node:path";
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
import { readCenterRelocationRouting } from "./fleet/center-relocation-command.ts";
import { readCenterRelocated, throwIfCenterMigrating, throwIfCenterRelocated } from "@harness-anything/storage";
import { annotateHostingCredentialNotice } from "./hosting-credential-readiness.ts";
import { requireExecutionActionScope } from "./runtime-execution-scope.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import {
  type AuthorizationDecision,
  projectRuntimeProviderHealth,
  readDaemonRegistry,
  type FleetDeviceLoginNotice,
  type RuntimeInstanceAccountCut,
} from "@harness-anything/kernel";
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
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { DaemonHostApiContext } from "./daemon-host-context.ts";
import { runReplicaConfirmedRound } from "./runtime-recovery-watch.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { readAllTaskDispatchPages } from "./dispatch-read.ts";
import {
  evaluateFleetAction,
  makeOpaqueTaskAncestorReader,
  requireAuthorizedFleetAction,
  requireAuthorizedHostAction,
  resolveTaskReadAuthorizationScopes,
} from "./host-action-authorization.ts";
import {
  orchestrateRuntimeBatch,
  orchestrateRuntimeSessionsAwait,
  type RuntimeOrchestrationContext,
} from "./runtime-orchestration.ts";

export function createDaemonHostRuntimeApi(
  context: DaemonHostApiContext,
): Pick<
  DaemonHost,
  | "attach"
  | "spawnRuntime"
  | "cancelRuntime"
  | "steerRuntime"
  | "handoffRuntime"
  | "batchRuntime"
  | "awaitRuntimeSessions"
  | "runtimeIngress"
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
    throwIfCenterRelocated(userRoot, repoId);
    if (mutating) throwIfCenterMigrating(userRoot, repoId);
  };
  return {
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
      const readTask = makeOpaqueTaskAncestorReader(cell, auth.connectionSignal);
      let decision: AuthorizationDecision | undefined;
      for (const entityRef of scopes) {
        const taskId = entityRef?.slice("task/".length);
        decision =
          kind === "repository-read" || kind === "fleet-overview-read"
            ? await evaluateFleetAction({
                kind,
                binding,
                actionId: entityRef === undefined ? `${kind}:${repoId}` : `${kind}:${repoId}:${entityRef}`,
                evaluatedAtCut: `repository:${repoId}:current`,
                repoId,
                ...(entityRef === undefined ? {} : { entityRef }),
                ...(entityRef === undefined || readTask === undefined ? {} : { readTask }),
                ...(target?.opaqueDenial === true ? { opaqueDenial: true } : {}),
              })
            : taskId !== undefined
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
          if (!context.input?.userRoot || readCenterRelocated(context.input.userRoot, authorityRepoId) === null)
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
            () => context.startReplicaSyncsFor(request.repoId),
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
          readAccessToken = createFleetReplicaAccessTokenReader({
            config: {
              ...syncRequest,
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
          { userRoot: context.input.userRoot, payload: syncRequest },
          readAccessToken,
          () => context.startReplicaSyncs(),
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
      const operation = method.replace("daemon.runtimeInstance.", ""),
        nodeId = runtimeNodeId(repoId),
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
        payload.probe === true ||
        actionKind === "runtime-instance-create" ||
        (actionKind === "runtime-instance-update" &&
          (payload.installationId !== undefined || context.instances.recordedInstallations() === null)) ||
        (actionKind === "runtime-instance-list" && context.instances.recordedInstallations() === null);
      if (needsInstallationWitness) await context.instances.refreshInstallations();
      const receipt = (await context.instances.command({
        ...payload,
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
      const instances = Array.isArray(receipt.instances) ? receipt.instances.map(withHealth) : undefined,
        instance = receipt.instance === undefined ? undefined : withHealth(receipt.instance),
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
