import { existsSync } from "node:fs";
import { daemonPackageVersion } from "./build-identity.ts";
import { observeDaemonOperation, markDaemonOperationPhase } from "./daemon-operation.ts";
import type { DaemonHost } from "./daemon-host-types.ts";
import type { DaemonHostApiContext } from "./daemon-host-context.ts";
import { readDaemonRegistry, type RepoMetricsSnapshot } from "@harness-anything/kernel";

export function createDaemonHostLifecycleApi(
  context: DaemonHostApiContext,
): Pick<
  DaemonHost,
  | "status"
  | "writeQueues"
  | "observabilitySnapshot"
  | "probeSnapshot"
  | "pendingFleetDeliveries"
  | "startAttachments"
  | "attachmentsSettled"
  | "close"
> {
  // Resident sorted repo ID cache: avoids O(R log R) sorting on every Prometheus scrape
  // while membership across cells/warming/unavailable is unchanged.
  let cachedSortedRepoIds: string[] = [];
  let cachedRepoIdSet = new Set<string>();

  const syncSortedRepoIds = (): readonly string[] => {
    let unchanged = true;
    for (const id of context.cells.keys()) {
      if (!cachedRepoIdSet.has(id)) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) {
      for (const id of context.warming.keys()) {
        if (!cachedRepoIdSet.has(id)) {
          unchanged = false;
          break;
        }
      }
    }
    if (unchanged) {
      for (const id of context.unavailable.keys()) {
        if (!cachedRepoIdSet.has(id)) {
          unchanged = false;
          break;
        }
      }
    }
    if (unchanged) {
      for (const id of cachedSortedRepoIds) {
        if (!context.cells.has(id) && !context.warming.has(id) && !context.unavailable.has(id)) {
          unchanged = false;
          break;
        }
      }
    }
    if (!unchanged) {
      const nextSet = new Set<string>();
      for (const id of context.cells.keys()) nextSet.add(id);
      for (const id of context.warming.keys()) nextSet.add(id);
      for (const id of context.unavailable.keys()) nextSet.add(id);
      cachedRepoIdSet = nextSet;
      cachedSortedRepoIds = [...nextSet].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    }
    return cachedSortedRepoIds;
  };

  const readPublishedRepoStatus = (repoId: string) => {
    const warmingStatus = context.warming.get(repoId);
    if (warmingStatus) return warmingStatus;
    const cell = context.cells.get(repoId);
    if (cell) return cell.publishedStatus ? cell.publishedStatus() : cell.status();
    return context.unavailable.get(repoId);
  };

  const isIdentityRequired = (): boolean => {
    if (context.input.requireIdentityReady !== undefined) return context.input.requireIdentityReady;
    const raw = process.env.HARNESS_DAEMON_REQUIRE_IDENTITY;
    return raw === "1" || raw === "true";
  };

  return {
    status: () => {
      const { entry, ...observedBuild } = context.buildObserver.status(),
        build = {
          ...observedBuild,
          version: daemonPackageVersion(),
        },
        registry = readDaemonRegistry({ userRoot: context.input.userRoot }),
        proxyRepos = registry.repos
          .filter((repo) => repo.state === "enabled" && repo.mode === "remote-proxy")
          .map((repo) => ({
            repoId: repo.repoId,
            rootDir: "",
            mode: repo.mode,
            state: "closed" as const,
            generation: null,
            queueDepth: null,
            recoveryMs: null,
            materialization: null,
            lastError: null,
            causeClass: null,
          })),
        disabledRepos = registry.repos
          .filter((repo) => repo.state === "disabled")
          .map((repo) => ({
            repoId: repo.repoId,
            rootDir: repo.canonicalRoot ?? "",
            mode: repo.mode,
            state: "closed" as const,
            generation: null,
            queueDepth: null,
            recoveryMs: null,
            materialization: null,
            lastError: repo.canonicalRoot && !existsSync(repo.canonicalRoot) ? "canonical root does not exist" : null,
            causeClass: repo.canonicalRoot && !existsSync(repo.canonicalRoot) ? ("infrastructure" as const) : null,
            registrationState: "disabled" as const,
            nextAction: `ha repo unbind ${repo.repoId}`,
          })),
        attachedRepos = context.cells.size + context.unavailable.size,
        attachTotal = attachedRepos + context.warming.size,
        attachProgress = context.warming.size > 0 ? ` attaching ${String(attachedRepos)}/${String(attachTotal)}` : "",
        base = [
          "daemon status: pid=",
          `${process.pid}`,
          " repos=",
          `${context.cells.size + context.warming.size + context.unavailable.size + proxyRepos.length}`,
          " entry=",
          entry,
          " commit=",
          build.commit ?? "unknown",
          attachProgress,
        ].join(""),
        summary = observedBuild.drifted
          ? [
              "",
              `${base}`,
              " \u2014 build drift: daemon loaded dist build ",
              `${observedBuild.loadedBuildId ?? "missing"}`,
              " while disk has ",
              `${observedBuild.diskBuildId ?? "missing"}`,
              "; it will keep serving the loaded build until queued writes drain, then exit and ",
              "restart on the disk build, re-adopting its live runtime sessions; ",
              "no `ha daemon stop` is required. ",
              "The next command finds the disk build running or autostarts it.",
            ].join("")
          : base,
        fleetWarnings = [
          ...(context.fleetCenter?.versionWarnings() ?? []),
          ...[...context.fleetVersionWarnings].map(
            ([repoId, warning]) => `[repoId=${repoId} role=remote-edge] ${warning.message}`,
          ),
        ],
        statusSummary = fleetWarnings.length
          ? `${summary}\nFleet version warning: ${fleetWarnings.join(" | ")} Run git pull --ff-only, then build CLI and daemon.`
          : summary;
      return {
        daemonId: context.input.daemonId,
        pid: process.pid,
        startedAt: context.startedAt,
        entry,
        build,
        connections: registry.connections,
        repos: [
          ...[...context.cells.values()].map((cell) => {
            const status = context.warming.get(cell.status().repoId) ?? cell.status();
            return status.state === "attached" ? { ...status, ...(cell.statusCuts() ?? {}) } : status;
          }),
          ...[...context.warming.values()].filter((status) => !context.cells.has(status.repoId)),
          ...context.unavailable.values(),
          ...proxyRepos,
          ...disabledRepos,
        ].sort((a, b) => a.repoId.localeCompare(b.repoId)),
        fleetVersionWarnings: fleetWarnings,
        summary: statusSummary,
      };
    },
    writeQueues: () =>
      [...context.cells.values()]
        .map((cell) => cell.status())
        .concat([...context.warming.values(), ...context.unavailable.values()])
        .map((status) => ({ repoId: status.repoId, queueDepth: status.queueDepth ?? null })),
    observabilitySnapshot: () => {
      const repos: RepoMetricsSnapshot[] = [];
      for (const repoId of syncSortedRepoIds()) {
        const status = readPublishedRepoStatus(repoId);
        if (!status) continue;
        repos.push({
          repoId: status.repoId,
          state: status.state,
          queueDepth: status.queueDepth ?? null,
          projectionWatermark: status.projectionWatermark ?? null,
          ledgerRevision: status.ledgerRevision ?? null,
        });
      }
      const centerMetrics = context.fleetCenter?.connectionMetrics();
      const fleet = centerMetrics
        ? { centerEnabled: true, ...centerMetrics }
        : {
            centerEnabled: false,
            activeConnections: 0,
            authenticatedNodes: 0,
            replicationStreams: 0,
            pendingDeliveries: 0,
          };
      return { repos, fleet };
    },
    probeSnapshot: () => {
      const reasons: string[] = [];
      if (context.closing) reasons.push("closing");
      if (context.initialAttachmentsSettled && !context.initialAttachmentsSettled()) {
        reasons.push("initial_attachments_pending");
      }
      if (context.warming.size > 0) reasons.push("repos_warming");
      let hasUnavailableRepo = context.unavailable.size > 0;
      if (!hasUnavailableRepo) {
        for (const cell of context.cells.values()) {
          const status = cell.publishedStatus ? cell.publishedStatus() : cell.status();
          if (status.state === "unavailable") {
            hasUnavailableRepo = true;
            break;
          }
        }
      }
      if (hasUnavailableRepo) reasons.push("repos_unavailable");
      if (context.fleetCenterRestoreFailed?.()) reasons.push("fleet_center_unavailable");
      if (isIdentityRequired() && context.identityReady && !context.identityReady()) {
        reasons.push("identity_not_configured");
      }
      return { ready: reasons.length === 0, reasons };
    },
    pendingFleetDeliveries: () => context.fleetCenter?.pendingDeliveries() ?? 0,
    startAttachments: () => {
      void context.startInitialAttachments();
    },
    attachmentsSettled: context.startInitialAttachments,
    close: async () => {
      context.closing = true;
      for (const { controller } of context.replicaSyncControllers.values()) controller.abort();
      context.replicaSyncControllers.clear();
      // The attach budget only bounds the caller's wait; the raw opening still owns a possible
      // writer worker and must settle before its singleton can be released. Replica tasks likewise
      // own their confirmation tail, including streams replaced by a later registry refresh.
      const settleBackground = async (): Promise<void> => {
        let pending = [...context.openings.values(), ...context.replicaSyncTasks];
        while (pending.length > 0) {
          await Promise.allSettled(pending);
          pending = [...context.openings.values(), ...context.replicaSyncTasks];
        }
      };
      // The cells close no matter what fails before them: they own the writer threads and Git follower drains
      // that the stop sequence releases the pid file and lock on top of. So the steps above them are
      // settled into a value instead of unwinding past the cell close.
      const preamble = await Promise.allSettled([
        (async () => {
          context.scheduleScheduler.close();
          markDaemonOperationPhase("initial-attachments");
          if (context.initialAttachments) await context.initialAttachments;
          markDaemonOperationPhase("openings-and-replica-syncs");
          await settleBackground();
          for (const repoId of [...context.warming.keys()]) context.settleWarming(repoId);
          try {
            markDaemonOperationPhase("fleet-center.close");
            if (context.fleetCenter) await context.fleetCenter.close();
          } finally {
            context.closeDaemonWriterEpoch();
          }
          for (const runtime of context.edgeRuntimeOwners.values()) runtime.close();
          context.edgeRuntimeOwners.clear();
          context.remoteProxy.close();
        })(),
      ]);
      // Every cell gets its close awaited even when one of them rejects (Promise.all would return on
      // the first rejection while the others were still tearing down), and the first rejection still
      // propagates so a drain failure is not swallowed.
      markDaemonOperationPhase("repo-cells.close");
      const settled = await Promise.allSettled(
          [...context.cells.entries()].map(([repoId, cell]) =>
            observeDaemonOperation(
              { method: "repo.close", repoId, actor: "daemon", phase: "writer-and-git-follower" },
              () => cell.close(),
            ),
          ),
        ),
        rejected = [...settled, ...preamble].find(
          (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
        );
      if (rejected) throw rejected.reason;
    },
  };
}
