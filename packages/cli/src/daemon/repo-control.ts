import path from "node:path";
import { localUserDaemonEndpoint } from "../../../daemon/src/client/local-daemon-target.ts";
import { requestDaemonJsonRpcAt } from "../../../daemon/src/client/local-json-rpc-client.ts";
import { daemonRepoModeWords } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { daemonFailure, daemonOption } from "./control-support.ts";

type ControlFinisher = (receipt: Record<string, unknown>, exitCode: number) => number;

export async function runDaemonRepoControl(
  argv: readonly string[],
  subcommand: string | undefined,
  userRoot: string,
  daemonId: string,
  finish: ControlFinisher,
): Promise<number | undefined> {
  if (subcommand === "register") {
    const root = daemonOption(argv, "--root"),
      repoId = daemonOption(argv, "--repo-id"),
      mode = daemonOption(argv, "--mode"),
      endpoint = daemonOption(argv, "--endpoint"),
      connectionId = daemonOption(argv, "--connection"),
      displayName = daemonOption(argv, "--display-name");
    if (!repoId) return finish(daemonFailure("daemon-repo-register", "missing_field", "Add --repo-id."), 2);
    if (mode !== undefined && !daemonRepoModeWords.includes(mode as (typeof daemonRepoModeWords)[number]))
      return finish(
        daemonFailure("daemon-repo-register", "invalid_field", `Use --mode ${daemonRepoModeWords.join(", ")}.`),
        2,
      );
    if (mode === "remote-proxy") {
      if (root || (endpoint === undefined) === (connectionId === undefined))
        return finish(
          daemonFailure(
            "daemon-repo-register",
            "invalid_field",
            "Remote-proxy registration omits --root and uses exactly one of --endpoint or --connection.",
          ),
          2,
        );
    } else if (!root || endpoint !== undefined || connectionId !== undefined)
      return finish(
        daemonFailure(
          "daemon-repo-register",
          "invalid_field",
          "Workspace-backed registration requires --root and does not accept --endpoint or --connection.",
        ),
        2,
      );
    const result = await requestDaemonJsonRpcAt(
      localUserDaemonEndpoint(userRoot, daemonId),
      "daemon.repo.register",
      {
        repoId,
        ...(root ? { rootDir: path.resolve(root) } : {}),
        ...(mode ? { mode } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(connectionId ? { connectionId } : {}),
        ...(displayName ? { displayName } : {}),
      },
      75,
    );
    return finish(result, result.ok === true ? 0 : 1);
  }
  if (subcommand === "update") {
    const repoId = daemonOption(argv, "--repo-id"),
      mode = daemonOption(argv, "--mode"),
      state = daemonOption(argv, "--state"),
      displayName = daemonOption(argv, "--display-name"),
      endpoint = daemonOption(argv, "--endpoint"),
      connectionId = daemonOption(argv, "--connection");
    if (!repoId) return finish(daemonFailure("daemon-repo-update", "missing_field", "Add --repo-id."), 2);
    if (mode !== undefined && !daemonRepoModeWords.includes(mode as (typeof daemonRepoModeWords)[number]))
      return finish(
        daemonFailure("daemon-repo-update", "invalid_field", `Use --mode ${daemonRepoModeWords.join(", ")}.`),
        2,
      );
    if (state !== undefined && state !== "enabled" && state !== "disabled")
      return finish(daemonFailure("daemon-repo-update", "invalid_field", "Use --state enabled or disabled."), 2);
    const result = await requestDaemonJsonRpcAt(
      localUserDaemonEndpoint(userRoot, daemonId),
      "daemon.repo.update",
      {
        repoId,
        ...(mode ? { mode } : {}),
        ...(state ? { state } : {}),
        ...(displayName ? { displayName } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(connectionId ? { connectionId } : {}),
      },
      75,
    );
    return finish(result, result.ok === true ? 0 : 1);
  }
  if (subcommand !== "unregister") return undefined;
  const repoId = daemonOption(argv, "--repo-id");
  if (!repoId) return finish(daemonFailure("daemon-repo-unregister", "missing_field", "Add --repo-id."), 2);
  const result = await requestDaemonJsonRpcAt(
    localUserDaemonEndpoint(userRoot, daemonId),
    "daemon.repo.unregister",
    { repoId },
    75,
  );
  return finish(result, result.ok === true ? 0 : 1);
}
