import { resolveLocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";
import { consumeKnownError } from "./client.ts";
import type { ThinCommand } from "../cli/thin-command.ts";

export interface DoctorCheck {
  readonly id: string;
  readonly status: "ok" | "warn" | "fail" | "indeterminate";
  readonly summary: string;
  readonly count: number;
  readonly next: string;
}

/**
 * The one doctor check the repo cell cannot answer: whether the running daemon's loaded build
 * matches the build on disk. Reads `daemon.status`; any transport failure degrades to
 * `indeterminate` — doctor never guesses at process state it could not observe.
 */
export async function daemonBuildDrift(command: ThinCommand): Promise<DoctorCheck | null> {
  try {
    const target = await resolveLocalDaemonTarget({
        rootDir: command.rootDir,
        repoIdOverride: command.repoId,
      }),
      { requestDaemonJsonRpcAt } = await import("../../../daemon/src/client/local-json-rpc-client.ts"),
      result = (await requestDaemonJsonRpcAt(target.socketPath, "daemon.status", {}, 75)) as Record<string, unknown>,
      build =
        typeof result.build === "object" && result.build !== null ? (result.build as Record<string, unknown>) : null;
    if (build === null) return null;
    return build.drifted === true
      ? {
          id: "build-drift",
          status: "warn",
          summary:
            `Daemon loaded build ${String(build.loadedBuildId ?? "missing")} while disk has ` +
            `${String(build.diskBuildId ?? "missing")}.`,
          count: 1,
          next: "Let the daemon drain, or restart it with ha daemon start --service.",
        }
      : {
          id: "build-drift",
          status: "ok",
          summary: `Daemon build ${String(build.loadedBuildId ?? "unknown")} matches disk.`,
          count: 0,
          next: "Nothing to do.",
        };
  } catch (error) {
    consumeKnownError(error);
    return {
      id: "build-drift",
      status: "indeterminate",
      summary: "daemon.status could not answer the loaded/disk build pair.",
      count: 0,
      next: "Run ha daemon status directly to inspect the daemon build state.",
    };
  }
}
