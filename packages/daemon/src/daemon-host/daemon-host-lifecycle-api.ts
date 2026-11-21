import { existsSync } from "node:fs";
import { daemonPackageVersion } from "./build-identity.ts";
import { observeDaemonOperation, markDaemonOperationPhase } from "./daemon-operation.ts";
import type { DaemonHost } from "./daemon-host-types.ts";
import type { DaemonHostApiContext } from "./daemon-host-context.ts";
import type { RepoCell, RepoCellStatus } from "./repo-cell-types.ts";
import { readDaemonRegistry, type RepoMetricsSnapshot } from "@harness-anything/kernel";

export interface TrackedRepoMaps {
  readonly cells: Map<string, RepoCell>;
  readonly warming: Map<string, RepoCellStatus>;
  readonly unavailable: Map<string, RepoCellStatus>;
  readonly sortedRepoIds: () => readonly string[];
}

export type IdentityProbeCode =
  | "ready"
  | "identity_not_configured"
  | "identity_verifying"
  | "identity_authority_sync_pending"
  | "identity_unavailable";

export interface IdentityReadinessController {
  readonly start: () => void;
  readonly currentState: () => IdentityProbeCode;
  readonly observeConfigured: <T>(outcome: T, loginTarget?: string) => Promise<T>;
  readonly observeConfigureFailure: (error: unknown) => never;
}

const DEFAULT_IDENTITY_READY_REVERIFY_INTERVAL_MS = 10_000;

export function createIdentityReadinessController(input: {
  readonly requireIdentityReady?: boolean;
  readonly hasConfiguredIdentity: () => boolean;
  readonly ensureRbacResumed: () => Promise<void>;
  readonly checkOidcStatus: (loginTarget?: string) => Promise<unknown>;
  readonly checkOidcCenter: (rejectedAccessToken?: string) => Promise<unknown>;
  readonly isClosing: () => boolean;
  readonly initialPendingTargets?: readonly string[];
  readonly nowMs?: () => number;
  readonly readyReverifyIntervalMs?: number;
  readonly recordDiagnostics?: (errorMessage: string) => void;
}): IdentityReadinessController {
  const nowMs = input.nowMs ?? Date.now;
  const readyReverifyIntervalMs = input.readyReverifyIntervalMs ?? DEFAULT_IDENTITY_READY_REVERIFY_INTERVAL_MS;
  const isIdentityRequired = (): boolean => {
    if (input.requireIdentityReady !== undefined) return input.requireIdentityReady;
    const raw = process.env.HARNESS_DAEMON_REQUIRE_IDENTITY;
    return raw === "1" || raw === "true";
  };
  let targetRevisionSeq = 0;
  const pendingSyncTargetRevisions = new Map<string, number>();
  const addPendingSyncTarget = (targetKey: string): void => {
    pendingSyncTargetRevisions.set(targetKey, ++targetRevisionSeq);
  };
  const clearPendingSyncTargetIfUnchanged = (targetKey: string, expectedRevision: number): void => {
    if (pendingSyncTargetRevisions.get(targetKey) === expectedRevision) {
      pendingSyncTargetRevisions.delete(targetKey);
    }
  };
  if (input.initialPendingTargets) {
    for (const target of input.initialPendingTargets) {
      addPendingSyncTarget(target);
    }
  }
  let current: IdentityProbeCode = !input.hasConfiguredIdentity()
    ? "identity_not_configured"
    : pendingSyncTargetRevisions.size > 0
      ? "identity_authority_sync_pending"
      : isIdentityRequired()
        ? "identity_verifying"
        : "ready";
  let verifyInFlight: Promise<void> | null = null;
  let verifyGeneration = 0;
  let lastVerifiedAtMs = Number.NEGATIVE_INFINITY;
  let lastAccessToken: string | undefined;
  let discoveryVerified = false;

  const assertStatusOk = (statusResult: unknown): void => {
    if (
      statusResult !== null &&
      typeof statusResult === "object" &&
      "ok" in statusResult &&
      statusResult.ok === false
    ) {
      throw new Error("OIDC status check reported ok=false");
    }
  };

  const verifyLiveAuthority = (forceFreshToken = false): Promise<void> => {
    if (!input.hasConfiguredIdentity()) {
      pendingSyncTargetRevisions.clear();
      discoveryVerified = false;
      lastAccessToken = undefined;
      current = "identity_not_configured";
      return Promise.resolve();
    }
    if (verifyInFlight) return verifyInFlight;
    const targetsToSync = [...pendingSyncTargetRevisions.entries()];
    const generation = ++verifyGeneration;
    const tokenToInvalidate = forceFreshToken ? lastAccessToken : undefined;
    const isStale = (): boolean => input.isClosing() || verifyGeneration !== generation;
    const run = (async () => {
      await input.ensureRbacResumed();
      if (isStale()) return;
      for (const [target, capturedRevision] of targetsToSync) {
        const statusResult = await input.checkOidcStatus(target === "" ? undefined : target);
        if (isStale()) return;
        assertStatusOk(statusResult);
        clearPendingSyncTargetIfUnchanged(target, capturedRevision);
      }
      if (!discoveryVerified) {
        const defaultStatus = await input.checkOidcStatus(undefined);
        if (isStale()) return;
        assertStatusOk(defaultStatus);
        discoveryVerified = true;
      }
      const centerResult = await input.checkOidcCenter(tokenToInvalidate);
      if (isStale()) return;
      if (
        centerResult !== null &&
        typeof centerResult === "object" &&
        "accessToken" in centerResult &&
        typeof centerResult.accessToken === "string"
      ) {
        lastAccessToken = centerResult.accessToken;
      }
    })()
      .then(
        () => {
          if (isStale()) return;
          if (pendingSyncTargetRevisions.size > 0) {
            current = "identity_authority_sync_pending";
            return;
          }
          current = "ready";
          lastVerifiedAtMs = nowMs();
        },
        (error: unknown) => {
          if (!isStale()) {
            if (forceFreshToken) lastAccessToken = undefined;
            current = pendingSyncTargetRevisions.size > 0 ? "identity_authority_sync_pending" : "identity_unavailable";
          }
          input.recordDiagnostics?.(error instanceof Error ? error.message : String(error));
        },
      )
      .finally(() => {
        if (verifyGeneration === generation) verifyInFlight = null;
      });
    verifyInFlight = run;
    return run;
  };

  return {
    start: () => {
      if (isIdentityRequired() && input.hasConfiguredIdentity()) void verifyLiveAuthority(false);
    },
    currentState: () => {
      if (!input.isClosing()) {
        if (
          current === "identity_unavailable" ||
          current === "identity_authority_sync_pending" ||
          current === "identity_verifying"
        ) {
          void verifyLiveAuthority(false);
        } else if (
          current === "ready" &&
          isIdentityRequired() &&
          nowMs() - lastVerifiedAtMs >= readyReverifyIntervalMs
        ) {
          void verifyLiveAuthority(true);
        }
      }
      return current;
    },
    observeConfigured: async <T>(outcome: T, loginTarget?: string): Promise<T> => {
      const targetKey = loginTarget ?? "";
      const sync =
        outcome !== null &&
        typeof outcome === "object" &&
        "authoritySync" in outcome &&
        outcome.authoritySync !== null &&
        typeof outcome.authoritySync === "object"
          ? (outcome.authoritySync as { readonly pending?: unknown })
          : null;
      ++verifyGeneration;
      verifyInFlight = null;
      if (sync?.pending === true) {
        addPendingSyncTarget(targetKey);
        discoveryVerified = false;
        lastAccessToken = undefined;
        current = "identity_authority_sync_pending";
        return outcome;
      }
      pendingSyncTargetRevisions.delete(targetKey);
      discoveryVerified = false;
      lastAccessToken = undefined;
      if (!input.hasConfiguredIdentity()) {
        pendingSyncTargetRevisions.clear();
        current = "identity_not_configured";
        return outcome;
      }
      if (pendingSyncTargetRevisions.size > 0) {
        current = "identity_authority_sync_pending";
        return outcome;
      }
      current = "identity_verifying";
      await verifyLiveAuthority(false);
      return outcome;
    },
    observeConfigureFailure: (error: unknown): never => {
      ++verifyGeneration;
      verifyInFlight = null;
      current = input.hasConfiguredIdentity()
        ? pendingSyncTargetRevisions.size > 0
          ? "identity_authority_sync_pending"
          : "identity_unavailable"
        : "identity_not_configured";
      throw error;
    },
  };
}

const nativeMapSet = Map.prototype.set;
const nativeMapDelete = Map.prototype.delete;
const nativeMapClear = Map.prototype.clear;

function instrumentRepoMap<V>(
  map: Map<string, V>,
  onAdd: (repoId: string) => void,
  onRemove: (repoId: string) => void,
  onClear: () => void,
): void {
  map.set = function set(key: string, value: V): Map<string, V> {
    const existed = Map.prototype.has.call(this, key);
    nativeMapSet.call(this, key, value);
    if (!existed) onAdd(key);
    return this;
  };
  map.delete = function remove(key: string): boolean {
    const removed = nativeMapDelete.call(this, key);
    if (removed) onRemove(key);
    return removed;
  };
  map.clear = function clear(): void {
    if (this.size === 0) return;
    nativeMapClear.call(this);
    onClear();
  };
}

function binarySearchIndex(sorted: readonly string[], target: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Instruments the host's repository membership maps so the sorted union of repository IDs
 * is maintained incrementally on attach/warming/unavailable/detach mutations (zero per-scrape sort).
 */
export function instrumentTrackedRepoMaps(maps: {
  readonly cells: Map<string, RepoCell>;
  readonly warming: Map<string, RepoCellStatus>;
  readonly unavailable: Map<string, RepoCellStatus>;
}): () => readonly string[] {
  const sortedIds: string[] = [];

  const onAdd = (repoId: string): void => {
    const index = binarySearchIndex(sortedIds, repoId);
    if (sortedIds[index] === repoId) return;
    sortedIds.splice(index, 0, repoId);
  };

  const onRemove = (repoId: string): void => {
    if (maps.cells.has(repoId) || maps.warming.has(repoId) || maps.unavailable.has(repoId)) return;
    const index = binarySearchIndex(sortedIds, repoId);
    if (sortedIds[index] === repoId) sortedIds.splice(index, 1);
  };

  const onClear = (): void => {
    sortedIds.length = 0;
    for (const id of maps.cells.keys()) onAdd(id);
    for (const id of maps.warming.keys()) onAdd(id);
    for (const id of maps.unavailable.keys()) onAdd(id);
  };

  instrumentRepoMap(maps.cells, onAdd, onRemove, onClear);
  instrumentRepoMap(maps.warming, onAdd, onRemove, onClear);
  instrumentRepoMap(maps.unavailable, onAdd, onRemove, onClear);
  onClear();

  return () => sortedIds;
}

export function createTrackedRepoMaps(): TrackedRepoMaps {
  const cells = new Map<string, RepoCell>();
  const warming = new Map<string, RepoCellStatus>();
  const unavailable = new Map<string, RepoCellStatus>();
  const sortedRepoIds = instrumentTrackedRepoMaps({ cells, warming, unavailable });
  return { cells, warming, unavailable, sortedRepoIds };
}

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
  // Resolve package version once at host startup so neither status() nor cold /metrics scrapes touch disk.
  const resolvedPackageVersion = daemonPackageVersion();

  const currentSortedRepoIds = (): readonly string[] => {
    if (context.sortedRepoIds) return context.sortedRepoIds();
    const ids = new Set<string>();
    for (const id of context.cells.keys()) ids.add(id);
    for (const id of context.warming.keys()) ids.add(id);
    for (const id of context.unavailable.keys()) ids.add(id);
    return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
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
          version: resolvedPackageVersion,
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
      for (const repoId of currentSortedRepoIds()) {
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
      let hasWarmingRepo = context.warming.size > 0;
      let hasUnavailableRepo = context.unavailable.size > 0;
      let hasUnreadableProjection = false;
      for (const cell of context.cells.values()) {
        const status = cell.publishedStatus ? cell.publishedStatus() : cell.status();
        if (status.state === "unavailable" || status.state === "closed") {
          hasUnavailableRepo = true;
        } else if (status.state === "warming") {
          hasWarmingRepo = true;
        } else if (status.projectionReadable === false) {
          hasUnreadableProjection = true;
        }
      }
      if (hasWarmingRepo) reasons.push("repos_warming");
      if (hasUnavailableRepo) reasons.push("repos_unavailable");
      if (hasUnreadableProjection) reasons.push("projections_unreadable");
      if (context.fleetCenterRestoreFailed?.()) reasons.push("fleet_center_unavailable");
      if (isIdentityRequired() && context.identityReadiness) {
        const identityState = context.identityReadiness();
        if (identityState !== "ready") reasons.push(identityState);
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
