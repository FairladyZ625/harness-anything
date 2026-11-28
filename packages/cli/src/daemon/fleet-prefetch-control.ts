import path from "node:path";
import {
  localUserDaemonEndpoint,
  resolveLocalDaemonTarget,
} from "@harness-anything/daemon/internal/client/local-daemon-target";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { readFleetEdgeConfig } from "@harness-anything/daemon/internal/client/fleet-edge-config";
import { daemonFailure, daemonOption } from "./control-support.ts";

export async function fleetPrefetchControl(
  argv: readonly string[],
  userRoot: string,
  daemonId: string,
  finish: (receipt: Record<string, unknown>, exitCode: number) => number,
): Promise<number> {
  const command = "daemon-fleet-edge-prefetch",
    flag = (name: string) => daemonOption(argv, name),
    reject = (code: string, nextAction: string) => finish(daemonFailure(command, code, nextAction), 2);
  if (!argv.includes("--all")) {
    return reject("missing_field", "Pass --all to eagerly materialize all unfetched cold blobs.");
  }
  const timeout = flag("--timeout-ms") ?? "300000";
  if (!/^[1-9][0-9]{0,9}$/u.test(timeout)) {
    return reject("invalid_field", "Use a positive integer for --timeout-ms.");
  }

  const target = await resolveLocalDaemonTarget({
      rootDir: path.resolve(flag("--root") ?? process.cwd()),
      repoIdOverride: flag("--repo"),
      registrationMode: "remote-edge",
      userRoot,
      daemonId,
    }),
    edge = readFleetEdgeConfig(userRoot, target.repoId);
  if (!edge || edge.repoId !== target.repoId) {
    return reject("fleet_edge_config_invalid", "A matching fleet-edge.json must exist before prefetching cold blobs.");
  }
  const payload = {
    prefetch: true,
    all: true,
    repoId: target.repoId,
    workspaceRoot: target.canonicalRoot,
    timeoutMs: Number(timeout),
  } as JsonObject;

  const result = await requestDaemonJsonRpcAt(
    target.socketPath ?? localUserDaemonEndpoint(userRoot, daemonId),
    "daemon.fleet.edge.sync",
    { payload },
    75,
  );
  return finish(result, result.ok === true ? 0 : 1);
}
