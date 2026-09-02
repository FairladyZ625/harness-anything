import type { DaemonBuildObserver } from "./build-identity.ts";
import type { DaemonHost } from "./daemon-host.ts";
import type { DaemonBuildDrainStatus, DaemonBuildStaleNotice } from "./protocol/daemon-protocol.contract.ts";

export function daemonBuildStaleNotice(
  observer?: DaemonBuildObserver,
  drainStatus?: () => DaemonBuildDrainStatus,
): DaemonBuildStaleNotice | null {
  const build = observer?.status();
  if (!build?.drifted) return null;
  const drain = drainStatus?.() ?? { liveRuntimeSessions: 0, pendingWrites: 0, attachingRepositories: 0 };
  return {
    code: "daemon_build_stale",
    loadedBuildId: build.loadedBuildId,
    diskBuildId: build.diskBuildId,
    ...drain,
    message:
      `Daemon loaded old build ${build.loadedBuildId ?? "missing"}; disk has ${build.diskBuildId ?? "missing"}. ` +
      `It is serving ${drain.liveRuntimeSessions} live runtime session(s), ` +
      `${drain.pendingWrites} queued write(s), and ` +
      `${drain.attachingRepositories} attaching repository/repositories; it will exit after they drain, and the next ` +
      "CLI command will autostart the disk build.",
  };
}

export function withDaemonBuildDrainSummary(
  status: ReturnType<DaemonHost["status"]>,
  warning: DaemonBuildStaleNotice | null,
): ReturnType<DaemonHost["status"]> {
  if (!warning) return status;
  return {
    ...status,
    summary:
      `${status.summary} Drain status: ${warning.liveRuntimeSessions} live runtime session(s), ` +
      `${warning.pendingWrites} queued write(s), ${warning.attachingRepositories} attaching repository/repositories.`,
  };
}
