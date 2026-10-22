import path from "node:path";
import { readFileSync } from "node:fs";
import { parseFleetCenterExternalUrl, readFleetCenterConfig, saveFleetCenterConfig } from "./fleet-center-config.ts";
import { annotateHostingCredentialNotice } from "./hosting-credential-readiness.ts";
import { requireExecutionActionScope } from "./runtime-execution-scope.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import { readDaemonRegistry } from "@harness-anything/kernel";
import { catalogRereadReceipt } from "./gui-catalog.ts";
import {
  ledgerWriteCommandTopology,
  repoReadCommandTopology,
} from "@harness-anything/preset/internal/preset-command-contract";
import type { DaemonHost } from "./daemon-host.ts";
import {
  keycloakNodeRegistry,
  prepareFleetCenterAdmission,
  startFleetCenterAdmission,
  syncFleetEdgeMirror,
  type FleetCenterAdmissionRequest,
  type FleetEdgeSyncRequest,
} from "./fleet-center-admission.ts";
import { probeTlsAddress, validateCertificateNames } from "./tls-listener-admission.ts";
import type { FleetEdgeRuntimeRequest } from "./fleet-edge-runtime.ts";
import { canonicalRoot, commandDescriptorForAction } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { DaemonHostApiContext } from "./daemon-host-context.ts";
import {
  evaluateFleetAction,
  requireAuthorizedFleetAction,
  requireAuthorizedHostAction,
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
  // Runtime orchestration (bounded batch window) is a host-level composer of
  // single-writer primitives: spawns and settlement reads all re-enter the cell
  // through the normal request path, so ingress events flow while a saga is parked.
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
  return {
    attach: async (repoId, runtimeSessionId, afterCursor, auth) => {
      context.requireHostMode(repoId, repoReadCommandTopology, auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      await context.binding(cell.status().rootDir, auth);
      return cell.attach(runtimeSessionId, afterCursor);
    },
    spawnRuntime: async (repoId, payload, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-run"), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      const receipt = await cell.spawnRuntime(
        payload,
        await context.binding(cell.status().rootDir, auth, undefined, repoId),
      );
      // The dispatch still runs; the notice only tells the operator the worker will not be
      // able to publish its delivery until the hosting credential is configured.
      return annotateHostingCredentialNotice(receipt, payload, cell.status().rootDir, {
        instances: context.instances.list(),
      });
    },
    cancelRuntime: async (repoId, payload, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-cancel"), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return cell.cancelRuntime(payload, await context.binding(cell.status().rootDir, auth, undefined, repoId));
    },
    steerRuntime: async (repoId, payload, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-steer"), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return cell.steerRuntime(payload, await context.binding(cell.status().rootDir, auth, undefined, repoId));
    },
    handoffRuntime: async (repoId, payload, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction(`runtime-handoff-${String(payload.operation)}`), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return cell.handoffRuntime(payload, await context.binding(cell.status().rootDir, auth, undefined, repoId));
    },
    batchRuntime: async (repoId, payload, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-batch"), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return orchestrateRuntimeBatch(
        payload,
        hostOrchestration(repoId, cell, await context.binding(cell.status().rootDir, auth, undefined, repoId), auth),
      );
    },
    awaitRuntimeSessions: async (repoId, payload, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-sessions-await"), auth);
      await context.attemptHostRecovery(repoId);
      context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return orchestrateRuntimeSessionsAwait(payload, {
        readSession: (runtimeSessionId) =>
          context.host.read(repoId, "repo.agentRuntime.sessions.read", { runtimeSessionId }, auth),
        readTaskDispatches: (taskIds) =>
          context.host.read(repoId, "repo.task.dispatches", { taskIds: taskIds as string[] }, auth),
        awaitSignal: async () => {
          await context.waitForWarming(repoId);
          return context.requiredCell(context.cells, context.warming, context.unavailable, repoId).awaitRuntimeSignal();
        },
        connectionSignal: auth.connectionSignal,
        codedError: context.hostCodedError,
      });
    },
    runtimeIngress: async (repoId, action, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-run"), auth);
      await context.attemptHostRecovery(repoId);
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
    terminalAttach: async (repoId, sessionId, afterSeq, auth) => {
      context.requireHostMode(repoId, repoReadCommandTopology, auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      await context.binding(cell.status().rootDir, auth);
      return cell.terminal.attach(sessionId, afterSeq);
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
      const commandTopology =
        method === "repo.gui.catalog.reread" || method === "repo.terminal.detach"
          ? repoReadCommandTopology
          : ledgerWriteCommandTopology;
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
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      const binding = await context.binding(cell.status().rootDir, auth);
      if (binding.executionPrincipal)
        requireExecutionActionScope(binding.executionPrincipal, { kind, taskId: target?.taskId });
      if (target)
        return evaluateRepoCellAction({
          action: { kind, taskId: target.taskId },
          binding,
          actionId: `${kind}:${repoId}:${target.taskId}`,
          repoId,
          revision: cell.status().ledgerRevision ?? 0,
          now: new Date().toISOString(),
          readTask: async (taskId) =>
            cell.read("repo.tasks.runtimeContext.read", { taskId }, binding).then((result) => result.snapshot.task),
        });
      return evaluateFleetAction({
        kind,
        binding: await context.binding(cell.status().rootDir, auth),
        actionId: `${kind}:${repoId}`,
        evaluatedAtCut: `repository:${repoId}:current`,
        repoId,
      });
    },
    fleet: {
      readCenterExternalAddress: async (auth) => {
        const config = readFleetCenterConfig(context.input.userRoot, context.input.daemonId);
        if (!config) return { ok: true, externalUrl: null };
        await authorizeCenterConfiguration(config.repoId, auth);
        return { ok: true, externalUrl: config.externalUrl ?? null };
      },
      // The read the GUI's center panel and invite entry consult: an honest running flag (the live
      // listener, not the saved config) plus the fields the panel displays. A saved config whose
      // restore failed reports running=false — that machine still needs an authorized start.
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
        try {
          // A start without an explicit certificate reuses the login service's listener pair; the
          // private-key path is resolved daemon-side and never crosses a transport. Both paths or
          // neither — half a pair is a caller's mistake, not a defaultable state.
          const rawRequest = payload as unknown as FleetCenterAdmissionRequest["payload"];
          if ((rawRequest.keyPath === undefined) !== (rawRequest.certPath === undefined))
            throw context.hostCodedError(
              "invalid_field",
              "Fleet TLS takes --key and --cert together; pass both, or neither to reuse the login service certificate.",
            );
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
          const externalUrl =
              rawRequest.externalUrl ??
              readFleetCenterConfig(context.input.userRoot, context.input.daemonId)?.externalUrl,
            request = {
              ...rawRequest,
              keyPath: certificate.keyPath,
              certPath: certificate.certPath,
              ...(externalUrl === undefined ? {} : { externalUrl: parseFleetCenterExternalUrl(externalUrl) }),
            };
          const prepared = await prepareFleetCenterAdmission({
            host: context.host,
            buildDraining: context.input.buildDraining,
            onDeliverySettled: context.input.onRepoStatusChange,
            userRoot: context.input.userRoot,
            writerEpochLease: context.writerEpochLease,
            payload: request,
            nodes: {
              ...keycloakNodeRegistry(context.keycloakCenter),
              loginAuthority: (nodeId) => context.oidc.discovery(nodeId),
              revokeDeviceSessions: (nodeId) => context.oidc.revokeDeviceSessions(nodeId),
              deviceLoginNotice: (nodeId, personId, notice) =>
                context.oidc.receiveDeviceNotice(nodeId, personId, notice),
              verifyHuman: (auth) => context.oidc.bind(auth),
              edgeJoin: (input) =>
                context.accessAdmin.admitEdgeJoin({
                  joinId: input.joinId,
                  inviteToken: input.inviteToken,
                  accessToken: input.accessToken ?? "",
                }),
            },
          });
          await context.waitForWarming(authorityRepoId);
          context.requiredCell(context.cells, context.warming, context.unavailable, authorityRepoId);
          const replaced = context.fleetCenter !== null;
          if (context.fleetCenter) {
            const previous = context.fleetCenter;
            context.fleetCenter = null;
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
            } catch (error) {
              await started.center.close();
              throw error;
            }
            context.fleetCenter = started.center;
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
          centerStarting = false;
        }
      },
      edgeSync: async (payload, auth) => {
        const request = payload as unknown as FleetEdgeSyncRequest["payload"],
          registered = readDaemonRegistry({ userRoot: context.input.userRoot }).repos.find(
            (repo) => repo.repoId === request.repoId && repo.state === "enabled",
          );
        const modeMatches =
          registered !== undefined &&
          registered.mode === "remote-edge" &&
          registered.canonicalRoot !== null &&
          canonicalRoot(request.workspaceRoot) === canonicalRoot(registered.canonicalRoot);
        if (!modeMatches)
          throw context.hostCodedError(
            "repo_mode_read_only",
            "Fleet edge sync requires the matching enabled remote-edge registration.",
          );
        // The edge only relays its machine credential; the center decides whether the node's owner may sync.
        context.localOnly(auth);
        const receipt = await syncFleetEdgeMirror(
          { payload: request },
          async () => (await context.oidc.bind(auth)).oidcPrincipal?.accessToken,
          () => context.startReplicaSyncs(),
        );
        await context.edgeRuntimeFor({ ...request, method: "repo.squad.control", action: {} }).reconcile();
        await context.scheduleScheduler.refresh();
        return receipt;
      },
      edgeRuntime: async (payload, auth) => {
        context.localOnly(auth);
        const request = payload as unknown as FleetEdgeRuntimeRequest["payload"],
          registered = readDaemonRegistry({
            userRoot: context.input.userRoot,
          }).repos.find((repo) => repo.repoId === request.repoId && repo.state === "enabled");
        if (
          !registered ||
          registered.mode !== "remote-edge" ||
          registered.canonicalRoot === null ||
          canonicalRoot(request.workspaceRoot) !== canonicalRoot(registered.canonicalRoot)
        )
          throw context.hostCodedError(
            "repo_mode_read_only",
            "Fleet runtime launch requires the matching enabled remote-edge registration.",
          );
        if (request.method === "repo.agentRuntime.overview" || request.method === "repo.agentRuntime.sessions.read")
          return context.host.read(request.repoId, request.method, request.action, auth) as unknown as Promise<
            Record<string, unknown>
          >;
        // Runtime reads may race the asynchronous resident stream startup after daemon attach.
        // Register the stream before ensureReady decides whether its first generation exists.
        context.startReplicaSyncs();
        const result = await context.edgeRuntimeFor(request).run(request.method, request.action, auth.connectionSignal);
        await context.scheduleScheduler.refresh();
        return result;
      },
    },
    system: context.system,
    runtimeInstance: async (method, payload, auth) => {
      const operation = method.replace("daemon.runtimeInstance.", ""),
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
      await context.instances.refreshInstallations();
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
                nodeId: context.input.daemonId,
                ...context.runtimePorts.runtimeProviderHealth.get(instance.instanceId),
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
                  const health = row.providerHealth as Record<string, unknown>;
                  return [
                    health.nodeId,
                    row.instanceId,
                    row.name,
                    row.kindId,
                    Array.isArray(row.models) ? row.models.join(",") : "",
                    row.enabled ? "enabled" : "disabled",
                    health.frozen ? "frozen" : health.cooldownUntil ? "cooldown" : "ready",
                    health.reason ?? "-",
                    health.frozenUntil ?? health.cooldownUntil ?? "-",
                  ].join("\t");
                }),
              ]
                .filter((value): value is string => typeof value === "string")
                .join("\n");
      return {
        ...receipt,
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
        serverBinding = await context.binding(cell.status().rootDir, auth);
      const operation = method.slice("repo.runtimeInstance.auth.".length);
      if (!["login", "logout"].includes(operation))
        throw context.hostCodedError("unsupported_command", `Unsupported runtime auth method: ${method}.`);
      await context.instances.refreshInstallations();
      const command = context.instances.prepareAuthCommand(
          context.requiredText(payload.instanceId, "instanceId"),
          operation as "login" | "logout",
        ),
        env = Object.fromEntries(
          Object.entries(command.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
      const actionKind = operation === "logout" ? "runtime-instance-logout" : "runtime-instance-login",
        authorizationDecision = await requireAuthorizedHostAction({
          kind: actionKind,
          repoId,
          binding: serverBinding,
          actionId: `${actionKind}:${context.requiredText(payload.instanceId, "instanceId")}`,
          evaluatedAtCut: `repository:${repoId}:current`,
        }),
        result = cell.terminal.spawnTrusted(
          {
            idempotencyKey: context.requiredText(payload.idempotencyKey, "idempotencyKey"),
            name: `${command.name} · ${operation === "logout" ? "Sign out" : "Sign in"}`,
            executablePath: command.executablePath,
            args: command.args,
            env,
            cwd: command.cwd,
            publicCwd: `runtime-instance:${command.instanceId}`,
            profile: "runtime-auth",
          },
          { ...serverBinding, authorizationDecision },
        ) as JsonObject;
      return { ...result, authorizationDecision: authorizationDecision as unknown as JsonObject };
    },
  };
}
