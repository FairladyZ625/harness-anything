import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { resolveLocalDaemonTarget } from "@harness-anything/daemon/internal/client/local-daemon-target";
import type { ThinCommand } from "../cli/thin-command.ts";

export async function openDaemonStatusReader(
  command: ThinCommand,
  method: string,
  payload: JsonObject,
): Promise<{ readonly read: () => Promise<JsonObject>; readonly close: () => void }> {
  const target = await resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId }),
    { openDaemonJsonRpcReaderAt } = await import("@harness-anything/daemon/internal/client/local-json-rpc-client");
  return openDaemonJsonRpcReaderAt(
    target.socketPath,
    method,
    { repo: { repoId: target.repoId }, payload },
    2_000,
    30_000,
  );
}
