import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDaemonPid } from "../../../daemon/src/runtime.ts";
import { startDetachedProcess, terminateProcess } from "../../../daemon/src/process-port.ts";
import { requestDaemonJsonRpcAt } from "../../../daemon/src/client/local-json-rpc-client.ts";
import type { GuiServiceBridge } from "../api/service-bridge.ts";
import { createDaemonSupervisor } from "./daemon-supervisor.ts";
import { createRuntimeInstanceCredentialController, type NativeCredentialBroker } from "./secure-credential-broker.ts";

type Target = { readonly repoId: string; readonly socketPath: string; readonly userRoot: string; readonly daemonId: string };
export function addLocalMainControls(input: { readonly bridge: GuiServiceBridge; readonly target: (repoId?: string) => Promise<Target>; readonly packaged?: { readonly resourcesPath: string }; readonly credentialBroker?: NativeCredentialBroker }): GuiServiceBridge {
  const supervisor = createDaemonSupervisor({ authorize: async (payload) => asRecord(await input.bridge.invoke("requestDaemonControl", payload)), restart: async (repoId) => restartResidentDaemon(await input.target(repoId), input.packaged) });
  const runtimeRpc = async (operation: string, payload: Record<string, unknown>) => requestDaemonJsonRpcAt((await input.target()).socketPath, `daemon.runtimeInstance.${operation}`, { payload } as never, ["create", "list", "status"].includes(operation) ? 12_000 : 2_000), credentialController = createRuntimeInstanceCredentialController({ ...(input.credentialBroker ? { broker: input.credentialBroker } : {}), create: (payload) => runtimeRpc("create", payload) });
  return { stream: input.bridge.stream, invoke: async (method, payload) => {
    if (method === "listRuntimeInstances") { const listed = asRecord(await runtimeRpc("list", {})), rows = Array.isArray(listed.instances) ? listed.instances.map(asRecord) : []; if (listed.ok !== true) return listed; const checked = await Promise.all(rows.map(async (instance) => asRecord(await runtimeRpc("status", { instanceId: instance.instanceId })))); return { ...listed, instances: rows.map((instance, index) => ({ ...instance, ...(asRecord(checked[index]).authReadiness ? { authReadiness: asRecord(checked[index]).authReadiness } : {}) })) }; }
    if (method === "showRuntimeInstance") return runtimeRpc("show", asRecord(payload));
    if (method === "createRuntimeInstance") return credentialController.create(asRecord(payload) as never);
    if (method === "deleteRuntimeInstance") return runtimeRpc("delete", asRecord(payload));
    if (method === "validateRuntimeInstanceAuth") return runtimeRpc("status", asRecord(payload));
    const authAction = method === "signInRuntimeInstance" ? "login" : method === "reauthRuntimeInstance" ? "reauth" : method === "signOutRuntimeInstance" ? "logout" : null;
    if (authAction) { const request = asRecord(payload), repoId = String(request.repoId), target = await input.target(repoId); return requestDaemonJsonRpcAt(target.socketPath, `repo.runtimeInstance.auth.${authAction}`, { repo: { repoId }, payload: { instanceId: String(request.instanceId), idempotencyKey: String(request.idempotencyKey) } }, 1_000); }
    if (method === "requestDaemonControl" && asRecord(payload).kind === "restart") return supervisor.request(asRecord(payload));
    if (method === "getDaemonControlReceipt") { const local = supervisor.receipt(String(asRecord(payload).operationId)); if (local) return local; }
    const result = asRecord(await input.bridge.invoke(method, payload)); return method === "getSystemStatus" ? supervisor.overlaySystem(await overlayLocalUserRoot(result)) : result;
  } };
  // The daemon system-status contract does not carry the user root; the System
  // page needs it (which user root this daemon serves), and main already
  // resolves the target, so overlay it here instead of extending the daemon
  // contract. Daemon-provided fields always win if the contract grows one.
  async function overlayLocalUserRoot(value: Record<string, unknown>): Promise<Record<string, unknown>> { if (!asRecord(value.daemon).daemonId) return value; try { return { ...value, daemon: { userRoot: (await input.target()).userRoot, ...asRecord(value.daemon) } }; } catch { return value; } }
}
async function restartResidentDaemon(target: Target, packaged?: { readonly resourcesPath: string }) { const before = point(await requestDaemonJsonRpcAt(target.socketPath, "daemon.gui.system.read", {}, 500)), pid = readDaemonPid(target.userRoot, target.daemonId); if (pid === null || pid !== before.pid) throw new Error("Daemon pid file does not match the authorized resident daemon."); terminateProcess(pid); await waitForExit(pid); const node = packaged ? path.join(packaged.resourcesPath, "node", `${process.platform}-${process.arch}`, process.platform === "win32" ? "node.exe" : "node") : process.execPath, entry = packaged ? path.join(packaged.resourcesPath, "app", "packages/cli/dist/index.js") : fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)), env = childEnvironment(!packaged && Boolean(process.versions.electron)); startDetachedProcess(node, [entry, "daemon", "serve", "--user-root", target.userRoot, "--daemon-id", target.daemonId], env); for (let attempt = 0; attempt < 100; attempt += 1) { try { const after = point(await requestDaemonJsonRpcAt(target.socketPath, "daemon.gui.system.read", {}, 100)); if (after.pid !== before.pid && after.startedAt !== before.startedAt) return { before, after }; } catch (error) { consumeKnownError(error); } await delay(20); } throw new Error("New daemon generation did not become ready."); }
async function waitForExit(pid: number): Promise<void> { for (let attempt = 0; attempt < 100; attempt += 1) { try { process.kill(pid, 0); } catch (error) { if (isCode(error, "ESRCH")) { consumeKnownError(error); return; } throw error; } await delay(10); } throw new Error("Old daemon did not drain before restart."); }
function point(value: Record<string, unknown>) { const daemon = asRecord(value.daemon); if (typeof daemon.daemonId !== "string" || typeof daemon.pid !== "number" || typeof daemon.startedAt !== "string") throw new Error("Daemon system status is incomplete."); return { daemonId: daemon.daemonId, pid: daemon.pid, startedAt: daemon.startedAt }; }
function childEnvironment(electronAsNode: boolean): NodeJS.ProcessEnv { const env: NodeJS.ProcessEnv = {}; for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key]; if (electronAsNode) env.ELECTRON_RUN_AS_NODE = "1"; return env; }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function consumeKnownError(error: unknown): void { void error; }
