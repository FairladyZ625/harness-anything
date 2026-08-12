import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";
import { canonicalRoot, workspaceId } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, resolveLocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";
import type { ThinCommand } from "../cli/thin-command.ts";

export { daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, resolveLocalDaemonTarget,
  type LocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";

export async function runCommandThroughDaemon(command: ThinCommand): Promise<JsonObject> {
  const { requestLocalDaemonJsonRpcForTarget } = await import("../../../daemon/src/client/local-json-rpc-client.ts");
  if (command.action.kind === "repo-bootstrap") { const userRoot = daemonUserRoot(), daemonId = daemonIdFromEnv(), { kind: _kind, ...params } = command.action; return requestLocalDaemonJsonRpcForTarget({ repoId: workspaceId("bootstrap"),
    canonicalRoot: canonicalRoot(command.rootDir, true), userRoot, daemonId, socketPath: localUserDaemonEndpoint(userRoot, daemonId) }, "daemon.repo.bootstrap", { rootDir: command.rootDir, ...params }, 75); }
  const target = resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId });
  const { kind: _kind, ...payload } = command.action;
  return requestLocalDaemonJsonRpcForTarget(target, command.method, {
    repo: { repoId: target.repoId }, payload: command.method === "repo.task.run" ? { action: command.action as JsonObject } : payload as JsonObject
  }, 75);
}
