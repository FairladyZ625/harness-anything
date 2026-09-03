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

// One summary for both drains an operator can be waiting on: the build supersession that will end
// this daemon, and the shutdown that already has. The counts are the same three in either case.
export function withDaemonDrainSummary(
  status: ReturnType<DaemonHost["status"]>,
  warning: DaemonBuildStaleNotice | null,
  shutdown?: { readonly stopping?: () => boolean; readonly buildDrainStatus?: () => DaemonBuildDrainStatus },
): ReturnType<DaemonHost["status"]> {
  const drain = shutdown?.stopping?.() === true ? (shutdown.buildDrainStatus?.() ?? null) : null;
  if (!warning && !drain) return status;
  const stale = warning
    ? ` Drain status: ${warning.liveRuntimeSessions} live runtime session(s), ` +
      `${warning.pendingWrites} queued write(s), ${warning.attachingRepositories} attaching repository/repositories.`
    : "";
  const stopping = drain
    ? ` Stopping: draining ${drain.liveRuntimeSessions} live runtime session(s), ` +
      `${drain.pendingWrites} queued write(s), ${drain.attachingRepositories} attaching ` +
      "repository/repositories before exit."
    : "";
  return { ...status, summary: `${status.summary}${stale}${stopping}` };
}
