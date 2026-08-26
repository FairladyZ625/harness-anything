import { readDaemonRegistry } from "../../kernel/src/index.ts";
import { ledgerWriteCommandTopology, repoReadCommandTopology } from "../../preset/src/preset-command-contract.ts";
import type { DaemonHost } from "./daemon-host.ts";
import {
  startFleetCenterAdmission,
  syncFleetEdgeMirror,
  type FleetCenterAdmissionRequest,
  type FleetEdgeSyncRequest,
} from "./fleet-center-admission.ts";
import { openFleetEdgeRuntime, type FleetEdgeRuntimeRequest } from "./fleet-edge-runtime.ts";
import { canonicalRoot, commandDescriptorForAction } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";

export function createDaemonHostRuntimeApi(
  context: any,
): Pick<
  DaemonHost,
  | "attach"
  | "spawnRuntime"
  | "cancelRuntime"
  | "runtimeIngress"
  | "terminalAttach"
  | "terminalAction"
  | "fleet"
  | "system"
  | "runtimeInstance"
  | "runtimeInstanceAuth"
> {
  return {
    attach: async (repoId, runtimeSessionId, afterCursor, auth) => {
      context.requireHostMode(repoId, repoReadCommandTopology, auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      await context.binding(cell.status().rootDir, auth, "repo-read");
      return cell.attach(runtimeSessionId, afterCursor);
    },
    spawnRuntime: async (repoId, payload, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-run"), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId),
        { executor: declared, ...intent } = payload,
        executor = context.declaredExecutor(declared);
      return cell.spawnRuntime(
        intent,
        await context.binding(cell.status().rootDir, auth, "repo-write", false, executor),
      );
    },
    cancelRuntime: async (repoId, payload, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-cancel"), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId),
        { executor: declared, ...intent } = payload,
        executor = context.declaredExecutor(declared);
      return cell.cancelRuntime(
        intent,
        await context.binding(cell.status().rootDir, auth, "repo-write", false, executor),
      );
    },
    runtimeIngress: async (repoId, action, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-run"), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return cell.runtimeIngress(action, await context.binding(cell.status().rootDir, auth, "repo-write"));
    },
    terminalAttach: async (repoId, sessionId, afterSeq, auth) => {
      context.requireHostMode(repoId, repoReadCommandTopology, auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      await context.binding(cell.status().rootDir, auth, "repo-read");
      return cell.terminal.attach(sessionId, afterSeq);
    },
    terminalAction: async (repoId, method, payload, auth) => {
      const commandClass =
          method === "repo.gui.catalog.reread" || method === "repo.terminal.detach" ? "repo-read" : "repo-write",
        commandTopology = commandClass === "repo-read" ? repoReadCommandTopology : ledgerWriteCommandTopology;
      context.requireHostMode(repoId, commandTopology, auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId),
        serverBinding = await context.binding(cell.status().rootDir, auth, commandClass);
      if (method === "repo.gui.catalog.reread") return cell.catalog.reread(payload) as Promise<JsonObject>;
      if (method === "repo.terminal.spawn") return cell.terminal.spawn(payload, serverBinding);
      if (method === "repo.terminal.input") return cell.terminal.input(payload, serverBinding);
      if (method === "repo.terminal.resize") return cell.terminal.resize(payload, serverBinding);
      if (method === "repo.terminal.detach") return cell.terminal.detach(payload);
      if (method === "repo.terminal.terminate") return cell.terminal.terminate(payload, serverBinding);
      throw context.hostCodedError("unsupported_command", `Unsupported terminal or catalog method: ${method}.`);
    },
    fleet: {
      startCenter: async (payload, auth) => {
        context.localOnly(auth);
        if (context.fleetCenter)
          throw context.hostCodedError(
            "fleet_center_running",
            "A fleet center is already listening on this daemon; stop the daemon before starting a replacement.",
          );
        const request = payload as unknown as FleetCenterAdmissionRequest["payload"],
          started = await startFleetCenterAdmission({
            host: context.host,
            userRoot: context.input.userRoot,
            payload: request,
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
          nodes: started.roster.nodes.length,
          assignments: started.roster.assignments.length,
          replicas: started.center.status().replicas,
        };
      },
      edgeSync: async (payload, auth) => {
        context.localOnly(auth);
        const request = payload as unknown as FleetEdgeSyncRequest["payload"],
          registered = readDaemonRegistry({ userRoot: context.input.userRoot }).repos.find(
            (repo) => repo.repoId === request.repoId && repo.state === "enabled",
          );
        const modeMatches =
          registered !== undefined &&
          registered.mode === "remote-edge" &&
          canonicalRoot(request.workspaceRoot) === canonicalRoot(registered.canonicalRoot);
        if (!modeMatches)
          throw context.hostCodedError(
            "repo_mode_read_only",
            "Fleet edge sync requires the matching enabled remote-edge registration.",
          );
        return syncFleetEdgeMirror({
          payload: request,
        });
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
          canonicalRoot(request.workspaceRoot) !== canonicalRoot(registered.canonicalRoot)
        )
          throw context.hostCodedError(
            "repo_mode_read_only",
            "Fleet runtime launch requires the matching enabled remote-edge registration.",
          );
        const key = `${request.repoId}\0${request.assignmentId}\0${request.host}\0${request.port}`,
          runtime =
            context.fleetEdgeRuntimes.get(key) ??
            openFleetEdgeRuntime({
              request,
              daemonGeneration: Date.now() * 1000 + (process.pid % 1000),
              daemonRoute: context.runtimeDaemonRoute,
              ports: context.runtimePorts,
              ...(context.input.runtimeLaunch ? { launch: context.input.runtimeLaunch } : {}),
              now: context.now,
            });
        context.fleetEdgeRuntimes.set(key, runtime);
        return runtime.run(request.method, request.action);
      },
    },
    system: context.system,
    runtimeInstance: async (method, payload, auth) => {
      context.localOnly(auth);
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
      return (await context.instances.command({
        ...payload,
        kind: actionKind,
      })) as JsonObject;
    },
    runtimeInstanceAuth: async (repoId, method, payload, auth) => {
      context.requireHostMode(repoId, ledgerWriteCommandTopology, auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId),
        serverBinding = await context.binding(cell.status().rootDir, auth, "repo-write");
      const operation = method.slice("repo.runtimeInstance.auth.".length);
      if (!["login", "logout"].includes(operation))
        throw context.hostCodedError("unsupported_command", `Unsupported runtime auth method: ${method}.`);
      const command = context.instances.prepareAuthCommand(
          context.requiredText(payload.instanceId, "instanceId"),
          operation as "login" | "logout",
        ),
        env = Object.fromEntries(
          Object.entries(command.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
      return cell.terminal.spawnTrusted(
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
        serverBinding,
      ) as JsonObject;
    },
  };
}
