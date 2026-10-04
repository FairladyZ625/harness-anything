import { requireExecutionActionScope } from "./runtime-execution-scope.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import { readDaemonRegistry } from "@harness-anything/kernel";
import {
  ledgerWriteCommandTopology,
  repoReadCommandTopology,
} from "@harness-anything/preset/internal/preset-command-contract";
import type { DaemonHost } from "./daemon-host.ts";
import {
  keycloakNodeRegistry,
  startFleetCenterAdmission,
  syncFleetEdgeMirror,
  type FleetCenterAdmissionRequest,
  type FleetEdgeSyncRequest,
} from "./fleet-center-admission.ts";
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
      return cell.spawnRuntime(payload, await context.binding(cell.status().rootDir, auth, undefined, repoId));
    },
    cancelRuntime: async (repoId, payload, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-cancel"), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return cell.cancelRuntime(payload, await context.binding(cell.status().rootDir, auth, undefined, repoId));
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
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return orchestrateRuntimeSessionsAwait(payload, {
        readSession: (runtimeSessionId) =>
          context.host.read(repoId, "repo.agentRuntime.sessions.read", { runtimeSessionId }, auth),
        readTaskDispatches: (taskIds) =>
          context.host.read(repoId, "repo.task.dispatches", { taskIds: taskIds as string[] }, auth),
        awaitSignal: cell.awaitRuntimeSignal,
        connectionSignal: auth.connectionSignal,
        codedError: context.hostCodedError,
      });
    },
    runtimeIngress: async (repoId, action, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-run"), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return cell.runtimeIngress(action, await context.binding(cell.status().rootDir, auth, undefined, repoId));
    },
    terminalAttach: async (repoId, sessionId, afterSeq, auth) => {
      context.requireHostMode(repoId, repoReadCommandTopology, auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      await context.binding(cell.status().rootDir, auth);
      return cell.terminal.attach(sessionId, afterSeq);
    },
    terminalAction: async (repoId, method, payload, auth) => {
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
      startCenter: async (payload, auth) => {
        const request = payload as unknown as FleetCenterAdmissionRequest["payload"],
          authorityRepoId = request.repoId,
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
        if (context.fleetCenter)
          throw context.hostCodedError(
            "fleet_center_running",
            "A fleet center is already listening on this daemon; stop the daemon before starting a replacement.",
          );
        const started = await startFleetCenterAdmission({
          host: context.host,
          userRoot: context.input.userRoot,
          writerEpochLease: context.writerEpochLease,
          payload: request,
          nodes: {
            ...keycloakNodeRegistry(context.keycloakCenter),
            loginAuthority: (nodeId) => context.oidc.discovery(nodeId),
            verifyHuman: (auth) => context.oidc.bind(auth),
          },
        });
        context.fleetCenter = started.center;
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "daemon-fleet-center-start",
          outcome: "applied",
          port: started.center.port,
          bind: request.bind ?? "127.0.0.1",
          stateRoot: started.stateRoot,
          quotaBytes: request.quotaBytes,
          replicas: started.center.status().replicas,
          authorizationDecision: authorizationDecision as unknown as JsonObject,
        };
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
        const receipt = await syncFleetEdgeMirror({
          payload: request,
        });
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
        const result = await context.edgeRuntimeFor(request).run(request.method, request.action, auth.connectionSignal);
        await context.scheduleScheduler.refresh();
        return result;
      },
    },
    system: context.system,
    runtimeInstance: async (method, payload, auth) => {
      const operation = method.replace("daemon.runtimeInstance.", ""),
        actionKind =
          operation === "githubCredential.set"
            ? "runtime-instance-github-credential-set"
            : operation === "githubCredential.unset"
              ? "runtime-instance-github-credential-unset"
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
      return { ...receipt, authorizationDecision: authorizationDecision as unknown as JsonObject };
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
