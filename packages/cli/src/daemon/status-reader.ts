import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";
import { resolveLocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";
import type { ThinCommand } from "../cli/thin-command.ts";

export async function openDaemonStatusReader(
  command: ThinCommand,
  method: string,
  payload: JsonObject,
): Promise<{ readonly read: () => Promise<JsonObject>; readonly close: () => void }> {
  const target = await resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId }),
    { openDaemonJsonRpcReaderAt } = await import("../../../daemon/src/client/local-json-rpc-client.ts");
  return openDaemonJsonRpcReaderAt(
    target.socketPath,
    method,
    { repo: { repoId: target.repoId }, payload },
    2_000,
    30_000,
  );
}
