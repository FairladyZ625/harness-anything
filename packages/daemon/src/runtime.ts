import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { localUserDaemonEndpoint } from "./client/local-daemon-target.ts";
import { acquireDaemonSingleton, daemonPidPath } from "./daemon-singleton.ts";
import { openDaemonHost } from "./daemon-host.ts";
import { createJsonRpcProtocolServer } from "./protocol/json-rpc-server.ts";
import { openDaemonRequestLog } from "./request-log.ts";
import { openDaemonLifecycleLog } from "./lifecycle-log.ts";
import { createUnixSocketTransportServer } from "./transport/unix-socket.ts";

export interface RunningDaemon { readonly endpoint: string; readonly stop: () => Promise<void> }
export interface DaemonServeDeferred { readonly pid: number | null; readonly endpoint: string; readonly witness: "unix-socket" | "singleton-lock" }
export type DaemonServeStart = RunningDaemon | DaemonServeDeferred;
export async function startDaemon(input: { readonly daemonId: string; readonly userRoot: string; readonly runtimeFile?: string; readonly shutdownRequested?: () => boolean; readonly requestShutdown?: () => void }): Promise<DaemonServeStart> {
  const endpoint = localUserDaemonEndpoint(input.userRoot, input.daemonId);
  // The singleton claim precedes every workspace attachment and the socket
  // bind, so the socket and the workspace writer locks can only ever share
  // one holder.
  const singleton = await acquireDaemonSingleton({ userRoot: input.userRoot, daemonId: input.daemonId, endpoint });
  if (singleton.claim === "incumbent") return { pid: singleton.pid, endpoint, witness: singleton.witness };
  const pidPath = daemonPidPath(input.userRoot, input.daemonId);
  mkdirSync(path.dirname(pidPath), { recursive: true }); writeFileSync(pidPath, `${process.pid}\n`, "utf8");
  const lifecycle = openDaemonLifecycleLog({ userRoot: input.userRoot, daemonId: input.daemonId }); lifecycle.record({ event: "process_start", endpoint });
  let host: Awaited<ReturnType<typeof openDaemonHost>> | undefined, transport: ReturnType<typeof createUnixSocketTransportServer> | undefined;
  try {
    host = await openDaemonHost({ ...input, endpoint, recordLifecycle: lifecycle.record });
    // One sink for the daemon; the protocol server is created per connection and reports into it.
    const requestLog = openDaemonRequestLog({ resolveRootDir: (repoId) => host!.status().repos.find((repo) => repo.repoId === repoId)?.rootDir });
    transport = createUnixSocketTransportServer({ daemonId: input.daemonId, socketPath: endpoint,
      createProtocolServer: (authContext, emit) => createJsonRpcProtocolServer({ host: host!, authContext, emit, recordRequest: requestLog.record }) });
    await transport.start(); lifecycle.record({ event: "socket_bound", endpoint }); host.startAttachments();
  } catch (error) { lifecycle.record({ event: "process_exit", outcome: "startup_failed", error: error instanceof Error ? error.stack ?? error.message : String(error) }); await host?.close(); rmSync(pidPath, { force: true }); singleton.release(); throw error; }
  let stopped = false;
  return { endpoint, stop: async () => { if (stopped) return; stopped = true; lifecycle.record({ event: "process_exit", outcome: "stop_requested" }); await transport!.stop(); await host!.close(); rmSync(pidPath, { force: true }); singleton.release(); } };
}
export { daemonPidPath, readDaemonPid } from "./daemon-singleton.ts";
