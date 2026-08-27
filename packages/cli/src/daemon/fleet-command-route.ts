import path from "node:path";
import { daemonUserRoot, readRegisteredRepos } from "../../../daemon/src/client/local-daemon-target.ts";
import type { ThinCommand } from "../cli/thin-command.ts";

const fleetScheduleKinds = [
  "schedule-create",
  "schedule-list",
  "schedule-show",
  "schedule-update",
  "schedule-delete",
  "schedule-enable",
  "schedule-disable",
  "schedule-run-now",
] as const;

export async function fleetScheduleRoute(
  command: ThinCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | null> {
  if (command.method !== "repo.task.run" || !(fleetScheduleKinds as readonly string[]).includes(command.action.kind))
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
type FleetEdgeConfigModule = import("../../../daemon/src/client/fleet-edge-config.ts").FleetEdgeConfig;
export async function fleetEdgeRegistration(
  command: ThinCommand,
  env: NodeJS.ProcessEnv,
): Promise<(FleetEdgeConfigModule & { readonly workspaceRoot: string }) | null> {
  const { readFleetEdgeConfig } = await import("../../../daemon/src/client/fleet-edge-config.ts");
  const commandRoot = path.resolve(command.rootDir),
    registered = readRegisteredRepos(daemonUserRoot(env))
      .filter(
        (repo) =>
          repo.state === "enabled" &&
          (commandRoot === path.resolve(repo.canonicalRoot) ||
            commandRoot.startsWith(`${path.resolve(repo.canonicalRoot)}${path.sep}`)),
      )
      .sort((left, right) => path.resolve(right.canonicalRoot).length - path.resolve(left.canonicalRoot).length)[0];
  if (registered?.mode !== "remote-edge") return null;
  const config = readFleetEdgeConfig(registered.canonicalRoot);
  return config?.repoId === registered.repoId
    ? { ...config, workspaceRoot: path.resolve(registered.canonicalRoot) }
    : null;
}
