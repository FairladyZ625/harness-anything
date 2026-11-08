import { readFileSync } from "node:fs";
import path from "node:path";
import { daemonUserRoot, readRegisteredRepos } from "@harness-anything/daemon/internal/client/local-daemon-target";
import {
  canonicalRoot,
  commandDescriptorForAction,
  daemonProtocolCommands,
} from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import type { ThinCommand } from "../cli/thin-command.ts";
import { serializeFleetAction } from "./fleet-payload-serializer.ts";

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
  const { executor: _executor, ...action } = serializeFleetAction(command);
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

/** Resolve a Schedule mission file on the edge before either local or Fleet execution. */
export function materializeScheduleMission(command: ThinCommand): ThinCommand {
  if (
    !["schedule-create", "schedule-update"].includes(command.action.kind) ||
    typeof command.action.missionFile !== "string"
  )
    return command;
  const missionPath = path.resolve(command.rootDir, command.action.missionFile),
    relative = path.relative(command.rootDir, missionPath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw Object.assign(new Error("--mission-file must stay within the selected repository."), {
      code: "invalid_field",
    });
  const { missionFile: _missionFile, ...action } = command.action;
  return { ...command, action: { ...action, mission: readFileSync(missionPath, "utf8") } };
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
  const commandRoot = canonicalRoot(command.rootDir);
  // A relayed runtime already holds its canonical root and repo id: the daemon that dispatched it
  // bound both. The registry that records remote-edge mode belongs to the host and is not readable
  // inside the sandbox, so a relayed command reads the workspace-owned fleet-edge.json instead and
  // matches it against the injected repo. No match (the ordinary local workspace) stays on the
  // relay; a match keeps the fleet channel, including its center-side credential check.
  if (env.HARNESS_DAEMON_RELAY === "1") {
    const repoId = env.HARNESS_DAEMON_REPO_ID?.trim(),
      injectedRoot = env.HARNESS_CANONICAL_ROOT?.trim();
    if (!repoId || !injectedRoot) return null;
    // The dispatcher hands over an absolute workspace root. A symlinked root that resolves outside
    // the command root simply keeps this command on the relay; the target resolver owns refusing it.
    const workspaceRoot = path.resolve(injectedRoot);
    if (commandRoot !== workspaceRoot && !commandRoot.startsWith(`${workspaceRoot}${path.sep}`)) return null;
    const config = readFleetEdgeConfig(workspaceRoot);
    return config?.repoId === repoId ? { ...config, workspaceRoot } : null;
  }
  const registered = (await readRegisteredRepos(daemonUserRoot(env)))
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
  "repo.agentRuntime.steer",
  "repo.agentRuntime.handoff",
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
  } = serializeFleetAction(command);
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
    (descriptor.path[0] === "schedule" && descriptor.admission["remote-edge"] !== "edge-replica")
  )
    return null;
  const config = await fleetEdgeRegistration(command, env);
  if (!config) return null;
  // Migration/import/admin creation stays on the local authority path; the Fleet action only
  // carries ordinary task creation intent.
  if (actionKind === "task-create" && Object.hasOwn(command.action, "createMode")) return null;
  const action = serializeFleetAction(command);
  // Migration/import/admin creation is intentionally
  // outside the remote-edge surface. Falling through produces the existing,
  // explicit repo_mode_read_only receipt instead of silently dropping their
  // authority-bearing fields on the fleet route.
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
  payload.action = action;
  return payload;
}
