import { readFileSync } from "node:fs";
import path from "node:path";
import { daemonUserRoot, readRegisteredRepos } from "@harness-anything/daemon/internal/client/local-daemon-target";
import {
  canonicalRoot,
  commandDescriptorForAction,
  daemonProtocolCommands,
} from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { cliErrorMessage } from "../cli-error.ts";
import type { ThinCommand } from "../cli/thin-command.ts";

export async function fleetScheduleRoute(
  command: ThinCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
  if (
    (command.method !== "repo.task.run" && command.method !== "repo.task.read") ||
    !daemonProtocolCommands.some(
      (candidate) =>
        candidate.method === command.method && candidate.id === command.action.kind && candidate.path[0] === "schedule",
    )
  )
    return null;
  const config = await fleetEdgeRegistration(command, env);
  if (!config) return null;
  const { executor: _executor, ...action } = command.action;
  return {
    host: config.host,
    port: config.port,
    caPath: config.caPath,
    ...(config.servername ? { servername: config.servername } : {}),
    nodeId: config.nodeId,
    ...(config.rosterPath ? { rosterPath: config.rosterPath } : {}),
    ...(config.credential ? { credential: config.credential } : {}),
    assignmentId: config.assignmentId,
    repoId: config.repoId,
    viewRoot: config.viewRoot,
    quotaBytes: config.quotaBytes,
    workspaceRoot: config.workspaceRoot,
    action: { kind: "fleet-schedule", payload: action },
  };
}

// The registry-mode gate behind every fleet reroute: a workspace only takes a
// fleet channel when fleet-edge.json names it AND its canonical root is
// registered in remote-edge mode.
type FleetEdgeConfigModule = import("@harness-anything/daemon/internal/client/fleet-edge-config").FleetEdgeConfig;
export async function fleetEdgeRegistration(
  command: ThinCommand,
  env: NodeJS.ProcessEnv,
): Promise<(FleetEdgeConfigModule & { readonly workspaceRoot: string }) | null> {
  const { readFleetEdgeConfig } = await import("@harness-anything/daemon/internal/client/fleet-edge-config");
  const commandRoot = canonicalRoot(command.rootDir),
    registered = (await readRegisteredRepos(daemonUserRoot(env)))
      // 只解析 enabled 条目,且解析不了根目录的(已删除的 e2e 残留登记)直接丢弃:
      // 它们不可能是本命令的根,不能让一条死登记把所有命令的路由一起炸掉。
      .filter((repo) => repo.state === "enabled")
      .flatMap((repo) => {
        try {
          return [{ ...repo, canonicalRoot: canonicalRoot(repo.canonicalRoot, true) }];
        } catch {
          return [];
        }
      })
      .filter(
        (repo) =>
          commandRoot === path.resolve(repo.canonicalRoot) ||
          commandRoot.startsWith(`${path.resolve(repo.canonicalRoot)}${path.sep}`),
      )
      .sort((left, right) => path.resolve(right.canonicalRoot).length - path.resolve(left.canonicalRoot).length)[0];
  if (registered?.mode !== "remote-edge") return null;
  const config = readFleetEdgeConfig(registered.canonicalRoot);
  return config?.repoId === registered.repoId
    ? { ...config, workspaceRoot: path.resolve(registered.canonicalRoot) }
    : null;
}

// The automatic lease product entry: on a remote-edge workspace the task write
// commands route through the fleet channel instead of a local cell. The
// operator never runs a lease command — acquisition, queueing, and renewal are
// the center's job (dec_9E7AC30E/CH2).
// task-create rides its own preset method; legacy reads and lifecycle commands ride task action methods.
const fleetTaskMethods = ["repo.task.run", "repo.task.read", "repo.task.create"];
const fleetRuntimeMethods = [
  "repo.agentRuntime.spawn",
  "repo.agentRuntime.cancel",
  "repo.agentRuntime.overview",
  "repo.agentRuntime.sessions.read",
] as const;
export async function fleetRuntimeRoute(
  command: ThinCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
  if (!(fleetRuntimeMethods as readonly string[]).includes(command.method)) return null;
  const config = await fleetEdgeRegistration(command, env);
  if (!config) return null;
  const {
    kind: _kind,
    executor: _executor,
    wait: _wait,
    noStream: _noStream,
    detach: _detach,
    ...action
  } = command.action as Record<string, unknown>;
  return {
    host: config.host,
    port: config.port,
    caPath: config.caPath,
    ...(config.servername ? { servername: config.servername } : {}),
    nodeId: config.nodeId,
    ...(config.rosterPath ? { rosterPath: config.rosterPath } : {}),
    ...(config.credential ? { credential: config.credential } : {}),
    assignmentId: config.assignmentId,
    repoId: config.repoId,
    viewRoot: config.viewRoot,
    quotaBytes: config.quotaBytes,
    workspaceRoot: config.workspaceRoot,
    action: { kind: "fleet-runtime", method: command.method, payload: action },
  };
}
// The fleet modules stay lazy for the same reason the autostart seam does: the
// thin dist static import graph stays entry/parser/transport-only. Registry mode
// is the single repo-mode source of truth; its matched canonical root also owns
// fleet-edge.json for commands launched from worktrees or descendants.
export async function fleetTaskRoute(
  command: ThinCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
  if (!fleetTaskMethods.includes(command.method)) return null;
  const config = await fleetEdgeRegistration(command, env);
  if (!config) return null;
  const { FLEET_TASK_COMMAND_KINDS } = await import("@harness-anything/daemon/internal/fleet/contract");
  if (!(FLEET_TASK_COMMAND_KINDS as readonly string[]).includes(command.action.kind)) return null;
  const actionKind = command.action.kind,
    descriptor = commandDescriptorForAction(actionKind);
  const {
    executor: _executor,
    createMode,
    verb: _verb,
    commandType: _commandType,
    fromFile,
    jsonInput,
    ...action
  } = command.action as Record<string, unknown> & {
    executor?: unknown;
    createMode?: unknown;
    verb?: unknown;
    commandType?: unknown;
    fromFile?: unknown;
    jsonInput?: unknown;
  };
  // Migration/import/admin creation is intentionally
  // outside the remote-edge surface. Falling through produces the existing,
  // explicit repo_mode_read_only receipt instead of silently dropping their
  // authority-bearing fields on the fleet route.
  if (actionKind === "task-create" && createMode !== undefined) return null;
  const payload: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    caPath: config.caPath,
    ...(config.servername ? { servername: config.servername } : {}),
    nodeId: config.nodeId,
    ...(config.rosterPath ? { rosterPath: config.rosterPath } : {}),
    ...(config.credential ? { credential: config.credential } : {}),
    assignmentId: config.assignmentId,
    repoId: config.repoId,
    viewRoot: config.viewRoot,
    quotaBytes: config.quotaBytes,
    workspaceRoot: config.workspaceRoot,
    ...(config.waitTimeoutMs ? { waitTimeoutMs: config.waitTimeoutMs } : {}),
    action,
  };
  if (typeof fromFile === "string" || typeof jsonInput === "string") {
    const source = typeof fromFile === "string" ? `--from-file ${fromFile}` : "--json-input",
      file =
        typeof fromFile === "string"
          ? path.isAbsolute(fromFile)
            ? fromFile
            : path.join(command.rootDir, fromFile)
          : null;
    let packet: unknown;
    try {
      packet = JSON.parse(file ? readFileSync(file, "utf8") : String(jsonInput));
    } catch (error) {
      throw Object.assign(new Error(`${source} could not be read as JSON on this edge: ${cliErrorMessage(error)}`), {
        code: "invalid_field",
      });
    }
    if (packet === null || typeof packet !== "object" || Array.isArray(packet))
      throw Object.assign(new Error(`${source} must contain one JSON object.`), { code: "invalid_field" });
    if (actionKind === "task-create" || ("path" in descriptor && descriptor.path[0] === "schedule")) {
      const fields = packet as Record<string, unknown>;
      const unsupported = Object.keys(fields).filter((field) =>
        ["fromFile", "jsonInput", "kind", "createMode"].includes(field),
      );
      if (unsupported.length)
        throw Object.assign(new Error(`--from-file cannot carry ${unsupported.join(", ")} over the fleet channel.`), {
          code: "invalid_field",
        });
      payload.action = { ...fields, ...action };
    } else payload.action = { ...action, submission: packet };
  }
  return payload;
}
// Class-B surface on a remote-edge workspace: `ha doc sync` becomes one
// compare→push/pull fleet round, and the three conflict exits become fleet
// conflict-exit rounds. Everything else keeps its local receipt path.
const fleetDocSyncKinds = new Map([
  ["doc-status", { method: "daemon.fleet.doc.sync", dryRun: true }],
  ["doc-dry-run", { method: "daemon.fleet.doc.sync", dryRun: true }],
  ["doc-submit", { method: "daemon.fleet.doc.sync", dryRun: false }],
  ["doc-conflict-resolve", { method: "daemon.fleet.conflict.exit", action: "resolve" }],
  ["doc-conflict-discard-local", { method: "daemon.fleet.conflict.exit", action: "discard-local" }],
  ["doc-conflict-overwrite-center", { method: "daemon.fleet.conflict.exit", action: "overwrite-center" }],
]);
export async function fleetDocRoute(
  command: ThinCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly method: string; readonly payload: Record<string, unknown> } | null> {
  const kind = command.action.kind,
    route = fleetDocSyncKinds.get(kind);
  if (route === undefined || (command.method !== "repo.task.run" && command.method !== "repo.task.read")) return null;
  const config = await fleetEdgeRegistration(command, env);
  if (!config) return null;
  const payload: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    caPath: config.caPath,
    ...(config.servername ? { servername: config.servername } : {}),
    nodeId: config.nodeId,
    ...(config.rosterPath ? { rosterPath: config.rosterPath } : {}),
    ...(config.credential ? { credential: config.credential } : {}),
    assignmentId: config.assignmentId,
    repoId: config.repoId,
    viewRoot: config.viewRoot,
    quotaBytes: config.quotaBytes,
    workspaceRoot: config.workspaceRoot,
  };
  if ("dryRun" in route) {
    payload.dryRun = route.dryRun;
    payload.paths = Array.isArray(command.action.paths)
      ? command.action.paths.filter((value): value is string => typeof value === "string")
      : [];
    if (command.action.all === true) payload.all = true;
  } else {
    payload.action = route.action;
    payload.conflictId = command.action.conflictId;
  }
  return { method: route.method, payload };
}
