import path from "node:path";
import { daemonUserRoot, readRegisteredRepos } from "@harness-anything/daemon/internal/client/local-daemon-target";
import {
  canonicalRoot,
  commandDescriptorForAction,
  daemonProtocolCommands,
} from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { cliErrorMessage } from "../cli-error.ts";
import type { ThinCommand } from "../cli/thin-command.ts";
import { readWorkspaceTextFile } from "../cli-workspace-file.ts";

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
  const descriptor = commandDescriptorForAction(action.kind),
    resolvedAction = await resolveFleetPacketAction(command, action, "inputs" in descriptor ? descriptor.inputs : []);
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
    action: { kind: "fleet-schedule", payload: resolvedAction },
  };
}

/** Resolve a Schedule mission file on the edge before either local or Fleet execution. */
export function materializeScheduleMission(command: ThinCommand): ThinCommand {
  if (
    !["schedule-create", "schedule-update"].includes(command.action.kind) ||
    typeof command.action.missionFile !== "string"
  )
    return command;
  const { missionFile, ...action } = command.action;
  return {
    ...command,
    action: { ...action, mission: readWorkspaceTextFile(command.rootDir, missionFile, "--mission-file") },
  };
}

async function resolveFleetPacketAction(
  command: ThinCommand,
  action: Record<string, unknown>,
  inputs: readonly { readonly name: string; readonly jsonAllowedFields?: readonly string[] }[],
): Promise<Record<string, unknown>> {
  const fromFile = action.fromFile,
    jsonInput = action.jsonInput;
  const { fromFile: _fromFile, jsonInput: _jsonInput, ...directAction } = action;
  if (typeof fromFile !== "string" && typeof jsonInput !== "string") return directAction;
  const source = typeof fromFile === "string" ? `--from-file ${fromFile}` : "--json-input";
  let packet: unknown;
  try {
    packet = JSON.parse(
      typeof fromFile === "string"
        ? readWorkspaceTextFile(command.rootDir, fromFile, "--from-file")
        : String(jsonInput),
    );
  } catch (error) {
    throw Object.assign(new Error(`${source} could not be read as JSON on this edge: ${cliErrorMessage(error)}`), {
      code: "invalid_field",
    });
  }
  if (packet === null || typeof packet !== "object" || Array.isArray(packet))
    throw Object.assign(new Error(`${source} must contain one JSON object.`), { code: "invalid_field" });
  const packetInput = inputs.find(
      (input) => input.name === (typeof fromFile === "string" ? "--from-file" : "--json-input"),
    ),
    allowed = packetInput?.jsonAllowedFields;
  if (allowed) {
    const fields = packet as Record<string, unknown>,
      unsupported = Object.keys(fields).filter((field) => !allowed.includes(field));
    if (unsupported.length)
      throw Object.assign(new Error(`${source} cannot carry ${unsupported.join(", ")} over the fleet channel.`), {
        code: "invalid_field",
      });
    return { ...fields, ...directAction };
  }
  return { ...directAction, submission: packet };
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
    bodyFile,
    idsFile,
    ...action
  } = command.action as Record<string, unknown> & {
    executor?: unknown;
    createMode?: unknown;
    verb?: unknown;
    commandType?: unknown;
    fromFile?: unknown;
    jsonInput?: unknown;
    planFile?: unknown;
    bodyFile?: unknown;
    idsFile?: unknown;
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
      action.plan = readWorkspaceTextFile(command.rootDir, planFile, "--plan-file");
    } catch (error) {
      throw Object.assign(
        new Error(`--plan-file ${planFile} could not be read on this edge: ${cliErrorMessage(error)}`),
        {
          code: "invalid_field",
        },
      );
    }
  }
  // Decision prose sources are edge-local just like task plans. Send the authored bytes, never
  // the edge path, so the center's closed action schema and writer see the same body as a local
  // invocation. `--body-file` is declared only for Decision propose/amend and the CLI has already
  // rejected other action kinds before this route is selected.
  // Source files belong to the addressed edge; only decoded authored values cross TLS.
  if (typeof bodyFile === "string") action.body = readWorkspaceTextFile(command.rootDir, bodyFile, "--body-file");
  if (typeof idsFile === "string")
    action.factIds = readWorkspaceTextFile(command.rootDir, idsFile, "--ids-file")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
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
  payload.action = await resolveFleetPacketAction(
    command,
    { ...action, ...(command.pathCoordinate ? { pathCoordinate: command.pathCoordinate } : {}), fromFile, jsonInput },
    descriptor.inputs,
  );
  return payload;
}
