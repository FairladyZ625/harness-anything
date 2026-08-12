import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { localUserDaemonEndpoint } from "./client/local-daemon-target.ts";
import { openDaemonHost } from "./daemon-host.ts";
import { createJsonRpcProtocolServer } from "./protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "./transport/unix-socket.ts";

export interface RunningDaemon { readonly endpoint: string; readonly stop: () => Promise<void> }
export async function startDaemon(input: { readonly daemonId: string; readonly userRoot: string }): Promise<RunningDaemon> {
  const host = await openDaemonHost(input), endpoint = localUserDaemonEndpoint(input.userRoot, input.daemonId);
  const transport = createUnixSocketTransportServer({ daemonId: input.daemonId, socketPath: endpoint,
    createProtocolServer: (authContext) => createJsonRpcProtocolServer({ host, authContext }) });
  try { await transport.start(); }
  catch (error) { await host.close(); throw error; }
  const pidPath = daemonPidPath(input.userRoot, input.daemonId);
  mkdirSync(path.dirname(pidPath), { recursive: true }); writeFileSync(pidPath, `${process.pid}\n`, "utf8");
  return { endpoint, stop: async () => { await transport.stop(); await host.close(); rmSync(pidPath, { force: true }); } };
}
export function daemonPidPath(userRoot: string, daemonId: string): string { return path.join(userRoot, `daemon-${safeRuntimeId(daemonId)}.pid`); }
export function readDaemonPid(userRoot: string, daemonId: string): number | null { const file = daemonPidPath(userRoot, daemonId);
  if (!existsSync(file)) return null; const pid = Number(readFileSync(file, "utf8").trim()); return Number.isInteger(pid) && pid > 0 ? pid : null; }
function safeRuntimeId(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/gu, "-"); }
