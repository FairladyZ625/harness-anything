import { readDaemonRegistry } from "../../kernel/src/index.ts";
import { ledgerWriteCommandTopology, repoReadCommandTopology } from "../../preset/src/preset-command-contract.ts";
import type { DaemonHost } from "./daemon-host.ts";
import {
  startFleetCenterAdmission,
  syncFleetEdgeMirror,
  readFleetRosterFile,
  type FleetCenterAdmissionRequest,
  type FleetEdgeSyncRequest,
} from "./fleet-center-admission.ts";
import type { FleetEdgeRuntimeRequest } from "./fleet-edge-runtime.ts";
import { canonicalRoot, commandDescriptorForAction } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { DaemonHostApiContext } from "./daemon-host-context.ts";
import { localDefaultBinding } from "./daemon-host-binding.ts";
import { requireAuthorizedHostAction } from "./host-action-authorization.ts";

export function createDaemonHostRuntimeApi(
  context: DaemonHostApiContext,
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
      await context.binding(cell.status().rootDir, auth);
      return cell.attach(runtimeSessionId, afterCursor);
    },
    spawnRuntime: async (repoId, payload, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-run"), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return cell.spawnRuntime(payload, await context.binding(cell.status().rootDir, auth));
    },
    cancelRuntime: async (repoId, payload, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-cancel"), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return cell.cancelRuntime(payload, await context.binding(cell.status().rootDir, auth));
    },
    runtimeIngress: async (repoId, action, auth) => {
      context.requireHostMode(repoId, commandDescriptorForAction("runtime-run"), auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId);
      return cell.runtimeIngress(action, await context.binding(cell.status().rootDir, auth));
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
        serverBinding = await context.binding(cell.status().rootDir, auth);
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
          ? requireAuthorizedHostAction({
              kind,
              binding: serverBinding,
              actionId: `${kind}:${String(payload.idempotencyKey ?? payload.sessionId ?? "current")}`,
              evaluatedAtCut: `repository:${repoId}:current`,
              now: context.now(),
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
    fleet: {
      startCenter: async (payload, auth) => {
        const request = payload as unknown as FleetCenterAdmissionRequest["payload"],
          roster = readFleetRosterFile(request.rosterPath),
          authorityRepoId = [...new Set(roster.assignments.map(({ repoId }) => repoId))].sort()[0],
          authorityRepo = readDaemonRegistry({ userRoot: context.input.userRoot }).repos.find(
            (repo) => repo.repoId === authorityRepoId && repo.state === "enabled",
          );
        if (!authorityRepo)
          throw context.hostCodedError(
            "repo_namespace_unknown",
            "Fleet roster requires one enabled authority repository.",
          );
        const authorizationDecision = requireAuthorizedHostAction({
          kind: "daemon-fleet-center-start",
          binding: await context.binding(authorityRepo.canonicalRoot, auth),
          actionId: `daemon-fleet-center-start:${authorityRepo.repoId}`,
          evaluatedAtCut: "fleet-center:current",
          now: context.now(),
        });
        if (context.fleetCenter)
          throw context.hostCodedError(
            "fleet_center_running",
            "A fleet center is already listening on this daemon; stop the daemon before starting a replacement.",
          );
        const started = await startFleetCenterAdmission({
          host: context.host,
          userRoot: context.input.userRoot,
          payload: request,
        });
        context.fleetCenter = started.center;
        // Retained for read-side joins (Schedule GUI availability): the roster is the
        // assignment authority, so repository reads on this center can resolve which
        // fleet edge owns execution instead of guessing.
        context.fleetRoster = started.roster;
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
          canonicalRoot(request.workspaceRoot) === canonicalRoot(registered.canonicalRoot);
        if (!modeMatches)
          throw context.hostCodedError(
            "repo_mode_read_only",
            "Fleet edge sync requires the matching enabled remote-edge registration.",
          );
        const authorizationDecision = requireAuthorizedHostAction({
          kind: "daemon-fleet-edge-sync",
          binding: await context.binding(registered.canonicalRoot, auth),
          actionId: `daemon-fleet-edge-sync:${request.repoId}:${request.assignmentId}`,
          evaluatedAtCut: `fleet-edge:${request.repoId}:current`,
          now: context.now(),
        });
        const receipt = await syncFleetEdgeMirror({
          payload: request,
        });
        await context.scheduleScheduler.refresh();
        return { ...receipt, authorizationDecision };
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
        const result = await context.edgeRuntimeFor(request).run(request.method, request.action);
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
      const authorityRepo = [...readDaemonRegistry({ userRoot: context.input.userRoot }).repos]
        .filter((repo) => repo.state === "enabled")
        .sort((left, right) => left.repoId.localeCompare(right.repoId))[0];
      const serverBinding = authorityRepo
        ? await context.binding(authorityRepo.canonicalRoot, auth)
        : localDefaultBinding(auth);
      const authorizationDecision = requireAuthorizedHostAction({
        kind: actionKind,
        binding: serverBinding,
        actionId: `${actionKind}:${String(payload.instanceId ?? "catalog")}`,
        evaluatedAtCut: "runtime-instances:current",
        now: context.now(),
      });
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
      const command = context.instances.prepareAuthCommand(
          context.requiredText(payload.instanceId, "instanceId"),
          operation as "login" | "logout",
        ),
        env = Object.fromEntries(
          Object.entries(command.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
      const actionKind = operation === "logout" ? "runtime-instance-logout" : "runtime-instance-login",
        authorizationDecision = requireAuthorizedHostAction({
          kind: actionKind,
          binding: serverBinding,
          actionId: `${actionKind}:${context.requiredText(payload.instanceId, "instanceId")}`,
          evaluatedAtCut: `repository:${repoId}:current`,
          now: context.now(),
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
