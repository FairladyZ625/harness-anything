import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDaemonPid } from "../../../daemon/src/runtime.ts";
import { startDetachedProcess, terminateProcess } from "../../../daemon/src/process-port.ts";
import { requestDaemonJsonRpcAt } from "../../../daemon/src/client/local-json-rpc-client.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";
import { createDaemonSupervisor } from "./daemon-supervisor.ts";
import { createRuntimeCredentialController } from "./secure-credential-broker.ts";

type Target = { readonly repoId: string; readonly socketPath: string; readonly userRoot: string; readonly daemonId: string };
export function addLocalMainControls(input: { readonly bridge: GuiServiceBridge; readonly target: (repoId?: string) => Promise<Target>; readonly packaged?: { readonly resourcesPath: string } }): GuiServiceBridge {
  const supervisor = createDaemonSupervisor({ authorize: async (payload) => asRecord(await input.bridge.invoke("requestDaemonControl", payload)), restart: async (repoId) => restartResidentDaemon(await input.target(repoId), input.packaged) });
  return { stream: input.bridge.stream, invoke: async (method, payload) => {
    if (method === "configureRuntimeCredential") { const target = await input.target(), controller = createRuntimeCredentialController({ authorityRepoId: target.repoId, bind: (bound) => requestDaemonJsonRpcAt(target.socketPath, "daemon.agentRuntime.credentials.bind", bound as never, 500) }); return controller.configure(asRecord(payload) as { kindId: "claude" | "codex"; baseUrl?: string }); }
    if (method === "requestDaemonControl" && asRecord(payload).kind === "restart") return supervisor.request(asRecord(payload));
    if (method === "getDaemonControlReceipt") { const local = supervisor.receipt(String(asRecord(payload).operationId)); if (local) return local; }
    const result = asRecord(await input.bridge.invoke(method, payload)); return method === "getSystemStatus" ? supervisor.overlaySystem(result) : result;
  } };
}
async function restartResidentDaemon(target: Target, packaged?: { readonly resourcesPath: string }) { const before = point(await requestDaemonJsonRpcAt(target.socketPath, "daemon.gui.system.read", {}, 500)), pid = readDaemonPid(target.userRoot, target.daemonId); if (pid === null || pid !== before.pid) throw new Error("Daemon pid file does not match the authorized resident daemon."); terminateProcess(pid); await waitForExit(pid); const node = packaged ? path.join(packaged.resourcesPath, "node", `${process.platform}-${process.arch}`, process.platform === "win32" ? "node.exe" : "node") : process.execPath, entry = packaged ? path.join(packaged.resourcesPath, "app", "packages/cli/dist/index.js") : fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)), env = childEnvironment(!packaged && Boolean(process.versions.electron)); startDetachedProcess(node, [entry, "daemon", "serve", "--user-root", target.userRoot, "--daemon-id", target.daemonId], env); for (let attempt = 0; attempt < 100; attempt += 1) { try { const after = point(await requestDaemonJsonRpcAt(target.socketPath, "daemon.gui.system.read", {}, 100)); if (after.pid !== before.pid && after.startedAt !== before.startedAt) return { before, after }; } catch (error) { consumeKnownError(error); } await delay(20); } throw new Error("New daemon generation did not become ready."); }
async function waitForExit(pid: number): Promise<void> { for (let attempt = 0; attempt < 100; attempt += 1) { try { process.kill(pid, 0); } catch (error) { if (isCode(error, "ESRCH")) { consumeKnownError(error); return; } throw error; } await delay(10); } throw new Error("Old daemon did not drain before restart."); }
function point(value: Record<string, unknown>) { const daemon = asRecord(value.daemon); if (typeof daemon.daemonId !== "string" || typeof daemon.pid !== "number" || typeof daemon.startedAt !== "string") throw new Error("Daemon system status is incomplete."); return { daemonId: daemon.daemonId, pid: daemon.pid, startedAt: daemon.startedAt }; }
function childEnvironment(electronAsNode: boolean): NodeJS.ProcessEnv { const env: NodeJS.ProcessEnv = {}; for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key]; if (electronAsNode) env.ELECTRON_RUN_AS_NODE = "1"; return env; }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function consumeKnownError(error: unknown): void { void error; }
