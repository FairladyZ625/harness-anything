import { readDaemonPid } from "../../../daemon/src/runtime.ts";
import { startDetachedProcess, terminateProcess } from "../../../daemon/src/process-port.ts";
import { daemonLifecycleLogPath } from "../../../daemon/src/lifecycle-log.ts";
import { requestDaemonJsonRpcAt } from "../../../daemon/src/client/local-json-rpc-client.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";
import { consumeKnownError } from "../api/error-consumption.ts";
import { createDaemonSupervisor } from "./daemon-supervisor.ts";
import { daemonServeLaunch, type PackagedRuntime } from "./daemon-serve-launch.ts";
import { createRuntimeInstanceCredentialController } from "./secure-credential-broker.ts";
import type { CredentialPort } from "../../../daemon/src/agent-runtime-credential-port.ts";

type Target = {
  readonly repoId: string;
  readonly socketPath: string;
  readonly userRoot: string;
  readonly daemonId: string;
};
export function addLocalMainControls(input: {
  readonly bridge: GuiServiceBridge;
  readonly target: (repoId?: string) => Promise<Target>;
  readonly clientBuildCommit: string | null;
  readonly packaged?: PackagedRuntime;
  readonly credentialPort?: CredentialPort;
}): GuiServiceBridge {
  const supervisor = createDaemonSupervisor({
    authorize: async (payload) => asRecord(await input.bridge.invoke("requestDaemonControl", payload)),
    restart: async (repoId) => restartResidentDaemon(await input.target(repoId), input.packaged),
  });
  // API-key creation remains main-process-bound so the daemon receives only an opaque
  // credential reference; the resulting create call returns to the registry-derived bridge.
  const credentialController = createRuntimeInstanceCredentialController({
    ...(input.credentialPort ? { port: input.credentialPort } : {}),
    create: async (payload) => asRecord(await input.bridge.invoke("createRuntimeInstance", payload)),
  });
  return {
    stream: input.bridge.stream,
    invoke: async (method, payload) => {
      if (method === "createRuntimeInstance") return credentialController.create(asRecord(payload) as never);
      if (method === "requestDaemonControl" && asRecord(payload).kind === "restart")
        return supervisor.request(asRecord(payload));
      if (method === "getDaemonControlReceipt") {
        const local = supervisor.receipt(String(asRecord(payload).operationId));
        if (local) return local;
      }
      const result = asRecord(await input.bridge.invoke(method, payload));
      return method === "getSystemStatus"
        ? supervisor.overlaySystem(overlayBuildSkew(await overlayLocalUserRoot(result)))
        : result;
    },
  };
  // The daemon system-status contract does not carry the user root; the System
  // page needs it (which user root this daemon serves), and main already
  // resolves the target, so overlay it here instead of extending the daemon
  // contract. Daemon-provided fields always win if the contract grows one.
  async function overlayLocalUserRoot(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!asRecord(value.daemon).daemonId) return value;
    try {
      return { ...value, daemon: { userRoot: (await input.target()).userRoot, ...asRecord(value.daemon) } };
    } catch {
      return value;
    }
  }
  // A resident daemon serves the code it was started from, so the same overlay carries the verdict
  // the renderer cannot compute for itself: whether the daemon's build commit still matches this
  // GUI's. Without it, the mismatch surfaces as a wall of schema rejections from newer panels
  // reading an older daemon; with it, the System page can say "restart the daemon" in one line.
  function overlayBuildSkew(value: Record<string, unknown>): Record<string, unknown> {
    const daemon = asRecord(value.daemon);
    if (!daemon.daemonId) return value;
    const reported = asRecord(daemon.build).commitSha,
      clientCommit = input.clientBuildCommit;
    const stale =
      typeof reported === "string" && clientCommit !== null && reported !== clientCommit
        ? { daemonCommit: reported, clientCommit }
        : null;
    return { ...value, daemon: { buildStale: stale, ...daemon } };
  }
}
async function restartResidentDaemon(target: Target, packaged?: PackagedRuntime) {
  const before = point(await requestDaemonJsonRpcAt(target.socketPath, "daemon.gui.system.read", {}, 500)),
    pid = readDaemonPid(target.userRoot, target.daemonId);
  if (pid === null || pid !== before.pid)
    throw new Error("Daemon pid file does not match the authorized resident daemon.");
  terminateProcess(pid);
  await waitForExit(pid);
  const { command, args, env } = daemonServeLaunch(target, packaged);
  startDetachedProcess(command, args, env, daemonLifecycleLogPath(target.userRoot, target.daemonId));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const after = point(await requestDaemonJsonRpcAt(target.socketPath, "daemon.gui.system.read", {}, 100));
      if (after.pid !== before.pid && after.startedAt !== before.startedAt) return { before, after };
    } catch (error) {
      consumeKnownError(error);
    }
    await delay(20);
  }
  throw new Error("New daemon generation did not become ready.");
}
async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isCode(error, "ESRCH")) {
        consumeKnownError(error);
        return;
      }
      throw error;
    }
    await delay(10);
  }
  throw new Error("Old daemon did not drain before restart.");
}
function point(value: Record<string, unknown>) {
  const daemon = asRecord(value.daemon);
  if (typeof daemon.daemonId !== "string" || typeof daemon.pid !== "number" || typeof daemon.startedAt !== "string")
    throw new Error("Daemon system status is incomplete.");
  return { daemonId: daemon.daemonId, pid: daemon.pid, startedAt: daemon.startedAt };
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
