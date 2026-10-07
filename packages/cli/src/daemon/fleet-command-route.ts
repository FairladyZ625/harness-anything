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
        candidate.method === command.method &&
        candidate.id === command.action.kind &&
        candidate.path[0] === "schedule" &&
        candidate.admission["remote-edge"] !== "edge-replica",
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
    credential: config.credential,
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
const fleetRuntimeMethods = [
  "repo.agentRuntime.spawn",
  "repo.agentRuntime.cancel",
  "repo.agentRuntime.handoff",
  "repo.agentRuntime.overview",
  "repo.agentRuntime.sessions.read",
  "repo.agentRuntime.sessions.await",
] as const;

function hasCommandDescriptor(actionKind: string): boolean {
  return daemonProtocolCommands.some(
    (descriptor) => ("actionKind" in descriptor ? descriptor.actionKind : descriptor.id) === actionKind,
  );
}

export async function fleetRuntimeRoute(
  command: ThinCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
  const squadControl =
    command.method === "repo.task.run" &&
    (command.action.kind === "squad-run" || command.action.kind === "squad-cancel");
  if (!squadControl && !(fleetRuntimeMethods as readonly string[]).includes(command.method)) return null;
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
    credential: config.credential,
    repoId: config.repoId,
    viewRoot: config.viewRoot,
    quotaBytes: config.quotaBytes,
    workspaceRoot: config.workspaceRoot,
    action: {
      kind: "fleet-runtime",
      method: squadControl ? "repo.squad.control" : command.method,
      payload: squadControl ? { ...action, kind: command.action.kind } : action,
    },
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
  const actionKind = command.action.kind;
  if (!hasCommandDescriptor(actionKind)) return null;
  const descriptor = commandDescriptorForAction(actionKind);
  if (
    !("path" in descriptor) ||
    !("inputs" in descriptor) ||
    descriptor.method !== command.method ||
    (descriptor.admission["remote-edge"] !== "via-center-forward" &&
      descriptor.admission["remote-edge"] !== "edge-replica") ||
    (descriptor.path[0] === "doc" &&
      descriptor.admission["remote-edge"] !== "edge-replica" &&
      typeof command.action.taskId !== "string") ||
    (descriptor.path[0] === "schedule" && descriptor.admission["remote-edge"] !== "edge-replica")
  )
    return null;
  const config = await fleetEdgeRegistration(command, env);
  if (!config) return null;
  const {
    executor: _executor,
    createMode,
    verb: _verb,
    commandType: _commandType,
    fromFile,
    jsonInput,
    planFile,
    ...action
  } = command.action as Record<string, unknown> & {
    executor?: unknown;
    createMode?: unknown;
    verb?: unknown;
    commandType?: unknown;
    fromFile?: unknown;
    jsonInput?: unknown;
    planFile?: unknown;
  };
  // Migration/import/admin creation is intentionally
  // outside the remote-edge surface. Falling through produces the existing,
  // explicit repo_mode_read_only receipt instead of silently dropping their
  // authority-bearing fields on the fleet route.
  if (actionKind === "task-create" && createMode !== undefined) return null;
  // The plan file is edge-local like --from-file: only its resolved body crosses the wire, so the
  // center never re-reads a path against its own workspace root.
  if (actionKind === "task-create" && planFile !== undefined) {
    if (typeof planFile !== "string")
      throw Object.assign(new Error("--plan-file must name one markdown file on this edge."), {
        code: "invalid_field",
      });
    try {
      action.plan = readFileSync(path.isAbsolute(planFile) ? planFile : path.join(command.rootDir, planFile), "utf8");
    } catch (error) {
      throw Object.assign(
        new Error(`--plan-file ${planFile} could not be read on this edge: ${cliErrorMessage(error)}`),
        {
          code: "invalid_field",
        },
      );
    }
  }
  if (actionKind === "task-artifact-add" && typeof action.source === "string")
    action.source = path.resolve(command.rootDir, action.source);
  const payload: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    caPath: config.caPath,
    ...(config.servername ? { servername: config.servername } : {}),
    nodeId: config.nodeId,
    credential: config.credential,
    repoId: config.repoId,
    viewRoot: config.viewRoot,
    quotaBytes: config.quotaBytes,
    workspaceRoot: config.workspaceRoot,
    ...(config.waitTimeoutMs ? { waitTimeoutMs: config.waitTimeoutMs } : {}),
    ...(config.maxAgeMs !== undefined ? { maxAgeMs: config.maxAgeMs } : {}),
    ...(config.maxLagRevisions !== undefined ? { maxLagRevisions: config.maxLagRevisions } : {}),
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
    const packetInput = (
      descriptor.inputs as readonly {
        readonly name: string;
        readonly jsonAllowedFields?: readonly string[];
      }[]
    ).find((input) => input.name === (typeof fromFile === "string" ? "--from-file" : "--json-input"));
    if (packetInput?.jsonAllowedFields) {
      const fields = packet as Record<string, unknown>;
      const unsupported = Object.keys(fields).filter((field) => !packetInput.jsonAllowedFields!.includes(field));
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
export async function fleetDocRoute(
  command: ThinCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly method: string; readonly payload: Record<string, unknown> } | null> {
  const kind = command.action.kind;
  if (!hasCommandDescriptor(kind)) return null;
  const descriptor = commandDescriptorForAction(kind);
  if (descriptor.method !== command.method || descriptor.admission["remote-edge"] !== "via-center-forward") return null;
  const sync = kind === "doc-submit",
    conflict = kind.startsWith("doc-conflict-");
  if (!sync && !conflict) return null;
  const config = await fleetEdgeRegistration(command, env);
  if (!config) return null;
  const payload: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    caPath: config.caPath,
    ...(config.servername ? { servername: config.servername } : {}),
    nodeId: config.nodeId,
    credential: config.credential,
    repoId: config.repoId,
    viewRoot: config.viewRoot,
    quotaBytes: config.quotaBytes,
    workspaceRoot: config.workspaceRoot,
  };
  if (sync) {
    payload.dryRun = false;
    payload.paths = Array.isArray(command.action.paths)
      ? command.action.paths.filter((value): value is string => typeof value === "string")
      : [];
    if (command.action.all === true) payload.all = true;
  } else {
    payload.action = kind.slice("doc-conflict-".length);
    payload.conflictId = command.action.conflictId;
  }
  return { method: sync ? "daemon.fleet.doc.sync" : "daemon.fleet.conflict.exit", payload };
}
