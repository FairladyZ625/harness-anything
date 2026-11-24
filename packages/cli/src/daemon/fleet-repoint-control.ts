import path from "node:path";
import {
  localUserDaemonEndpoint,
  resolveLocalDaemonTarget,
} from "@harness-anything/daemon/internal/client/local-daemon-target";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { readFleetEdgeConfig } from "@harness-anything/daemon/internal/client/fleet-edge-config";
import { daemonFailure, daemonOption, parseTrustAnchorFlags } from "./control-support.ts";

export async function fleetRepointControl(
  argv: readonly string[],
  userRoot: string,
  daemonId: string,
  finish: (receipt: Record<string, unknown>, exitCode: number) => number,
): Promise<number> {
  const command = "daemon-fleet-edge-repoint",
    flag = (name: string) => daemonOption(argv, name),
    reject = (code: string, nextAction: string) => finish(daemonFailure(command, code, nextAction), 2),
    required = ["--host", "--port", "--ca", "--spki-sha256"],
    missing = required.filter((name) => !flag(name));
  if (missing.length > 0) return reject("missing_field", `Add ${missing.join(" ")} before repointing the edge center.`);

  const port = Number(flag("--port")),
    timeout = flag("--timeout-ms") ?? "60000",
    allowBasebackup = argv.includes("--allow-basebackup");
  if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(String(flag("--port"))) || port > 65535)
    return reject("invalid_field", "Use a TCP port from 0 to 65535.");
  if (!/^[1-9][0-9]{0,9}$/u.test(timeout)) return reject("invalid_field", "Use a positive integer for --timeout-ms.");
  if (!/^[a-f0-9]{64}$/u.test(String(flag("--spki-sha256"))))
    return reject("invalid_field", "Use a lowercase SHA-256 digest for --spki-sha256.");
  const trustAnchorParse = parseTrustAnchorFlags(argv);
  if (!trustAnchorParse.ok) return reject("invalid_field", trustAnchorParse.nextAction);

  const target = await resolveLocalDaemonTarget({
      rootDir: path.resolve(flag("--root") ?? process.cwd()),
      repoIdOverride: flag("--repo"),
      registrationMode: "remote-edge",
      userRoot,
      daemonId,
    }),
    edge = readFleetEdgeConfig(userRoot, target.repoId);
  if (!edge || edge.repoId !== target.repoId)
    return reject("fleet_edge_config_invalid", "A matching fleet-edge.json must exist before repoint.");
  const credential = flag("--credential") ?? edge.credential,
    servername = flag("--servername") ?? flag("--host"),
    payload = {
      host: flag("--host"),
      port,
      caPath: path.resolve(String(flag("--ca"))),
      spkiSha256: flag("--spki-sha256"),
      ...(trustAnchorParse.trustAnchors ? { trustAnchors: trustAnchorParse.trustAnchors } : {}),
      nodeId: edge.nodeId,
      credential,
      repoId: target.repoId,
      viewRoot: path.resolve(edge.viewRoot),
      quotaBytes: edge.quotaBytes,
      workspaceRoot: target.canonicalRoot,
      timeoutMs: Number(timeout),
      ...(servername ? { servername } : {}),
      repoint: true,
      ...(allowBasebackup ? { allowBasebackup: true } : {}),
    } as JsonObject;

  const result = await requestDaemonJsonRpcAt(
    target.socketPath ?? localUserDaemonEndpoint(userRoot, daemonId),
    "daemon.fleet.edge.sync",
    { payload },
    75,
  );
  return finish(result, result.ok === true ? 0 : 1);
}
