import { existsSync } from "node:fs";
import { daemonPackageVersion } from "./build-identity.ts";
import { observeDaemonOperation, markDaemonOperationPhase } from "./daemon-operation.ts";
import type { DaemonHost } from "./daemon-host-types.ts";
import type { DaemonHostApiContext } from "./daemon-host-context.ts";
import type { RepoCell, RepoCellStatus } from "./repo-cell-types.ts";
import { readDaemonRegistry, type RepoMetricsAggregates, type RepoMetricsSnapshot } from "@harness-anything/kernel";

export interface TrackedRepoObservability {
  readonly sortedRepoIds: () => readonly string[];
  readonly publishRepoStatus: (repoId: string, status: RepoCellStatus) => void;
  readonly snapshot: () => {
    readonly repos: readonly RepoMetricsSnapshot[];
    readonly aggregates: RepoMetricsAggregates;
  };
}

export interface TrackedRepoMaps {
  readonly cells: Map<string, RepoCell>;
  readonly warming: Map<string, RepoCellStatus>;
  readonly unavailable: Map<string, RepoCellStatus>;
  readonly sortedRepoIds: () => readonly string[];
  readonly publishRepoStatus: (repoId: string, status: RepoCellStatus) => void;
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
  let pendingSyncTargets: Array<{ readonly targetKey: string; readonly revision: number }> = [];
  const addPendingSyncTarget = (targetKey: string): void => {
    const nextRevision = ++targetRevisionSeq;
    pendingSyncTargets = [
      ...pendingSyncTargets.filter((entry) => entry.targetKey !== targetKey),
      { targetKey, revision: nextRevision },
    ];
  };
  const removePendingSyncTarget = (targetKey: string, expectedRevision?: number): void => {
    pendingSyncTargets = pendingSyncTargets.filter((entry) => {
      if (entry.targetKey !== targetKey) return true;
      return expectedRevision !== undefined && entry.revision !== expectedRevision;
    });
  };
  if (input.initialPendingTargets) {
    for (const target of input.initialPendingTargets) {
      addPendingSyncTarget(target);
    }
  }
  let current: IdentityProbeCode = !input.hasConfiguredIdentity()
    ? "identity_not_configured"
    : pendingSyncTargets.length > 0
      ? "identity_authority_sync_pending"
      : isIdentityRequired()
        ? "identity_verifying"
        : "ready";
  let verifyInFlight: Promise<void> | null = null;
  let verifyGeneration = 0;
  let lastVerifiedAtMs = Number.NEGATIVE_INFINITY;
  let lastAccessToken: string | undefined;
  let discoveryVerified = false;

  const verifyLiveAuthority = (forceFreshToken = false): Promise<void> => {
    if (!input.hasConfiguredIdentity()) {
      pendingSyncTargets = [];
      discoveryVerified = false;
      lastAccessToken = undefined;
      current = "identity_not_configured";
      return Promise.resolve();
    }
    if (verifyInFlight) return verifyInFlight;
    const targetsToSync = [...pendingSyncTargets];
    const generation = ++verifyGeneration;
    const tokenToInvalidate = forceFreshToken ? lastAccessToken : undefined;
    const isStale = (): boolean => input.isClosing() || verifyGeneration !== generation;
    const run = (async () => {
      await input.ensureRbacResumed();
      if (isStale()) return;
      for (const { targetKey, revision } of targetsToSync) {
        const statusResult = await input.checkOidcStatus(targetKey === "" ? undefined : targetKey);
        if (isStale()) return;
        if (
          statusResult !== null &&
          typeof statusResult === "object" &&
          "ok" in statusResult &&
          statusResult.ok === false
        ) {
          throw new Error("OIDC status check reported ok=false");
        }
        removePendingSyncTarget(targetKey, revision);
      }
      if (!discoveryVerified) {
        const defaultStatus = await input.checkOidcStatus(undefined);
        if (isStale()) return;
        if (
          defaultStatus !== null &&
          typeof defaultStatus === "object" &&
          "ok" in defaultStatus &&
          defaultStatus.ok === false
        ) {
          throw new Error("OIDC default status check reported ok=false");
        }
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
          if (pendingSyncTargets.length > 0) {
            current = "identity_authority_sync_pending";
            return;
          }
          current = "ready";
          lastVerifiedAtMs = nowMs();
        },
        (error: unknown) => {
          if (!isStale()) {
            if (forceFreshToken) lastAccessToken = undefined;
            current = pendingSyncTargets.length > 0 ? "identity_authority_sync_pending" : "identity_unavailable";
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
      removePendingSyncTarget(targetKey);
      discoveryVerified = false;
      lastAccessToken = undefined;
      if (!input.hasConfiguredIdentity()) {
        pendingSyncTargets = [];
        current = "identity_not_configured";
        return outcome;
      }
      if (pendingSyncTargets.length > 0) {
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
        ? pendingSyncTargets.length > 0
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
const trackedObservabilityByCells = new WeakMap<Map<string, RepoCell>, TrackedRepoObservability>();

function instrumentRepoMap<V>(
  map: Map<string, V>,
  onSet: (repoId: string, value: V) => void,
  onDelete: (repoId: string) => void,
  onClear: () => void,
): void {
  map.set = function set(key: string, value: V): Map<string, V> {
    nativeMapSet.call(this, key, value);
    onSet(key, value);
    return this;
  };
  map.delete = function remove(key: string): boolean {
    const removed = nativeMapDelete.call(this, key);
    if (removed) onDelete(key);
    return removed;
  };
  map.clear = function clear(): void {
    if (this.size === 0) return;
    nativeMapClear.call(this);
    onClear();
  };
}

function toRepoMetricsSnapshot(status: RepoCellStatus): RepoMetricsSnapshot {
  const attached = status.state === "attached";
  return {
    repoId: status.repoId,
    state: status.state,
    queueDepth: status.queueDepth ?? null,
    projectionWatermark: attached ? (status.projectionWatermark ?? null) : null,
    ledgerRevision: attached ? (status.ledgerRevision ?? null) : null,
  };
}

function safeMetricNonNegative(value: number | null): number {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : 0;
}

function computeRepoLag(entry: RepoMetricsSnapshot): number | null {
  if (entry.projectionWatermark === null || entry.ledgerRevision === null) return null;
  return Math.max(0, safeMetricNonNegative(entry.ledgerRevision) - safeMetricNonNegative(entry.projectionWatermark));
}

function isCountedRepoState(state: RepoCellStatus["state"]): state is "attached" | "warming" | "unavailable" {
  return state === "attached" || state === "warming" || state === "unavailable";
}

/**
 * Instruments the host's repository membership maps so per-repo status and queue-depth updates
 * perform strict O(1) single-entry Map writes with incremental counters and zero array cloning
 * on the writer hot path; sorted snapshots and max-lag rescans happen lazily only at /metrics scrape.
 */
export function instrumentTrackedRepoMaps(maps: {
  readonly cells: Map<string, RepoCell>;
  readonly warming: Map<string, RepoCellStatus>;
  readonly unavailable: Map<string, RepoCellStatus>;
}): TrackedRepoObservability {
  const entriesById = new Map<string, RepoMetricsSnapshot>();
  const lagByRepoId = new Map<string, number>();
  const stateCounts = { attached: 0, warming: 0, unavailable: 0 };
  let totalQueueDepth = 0;
  let maxProjectionLag = 0;
  let maxLagDirty = false;
  let sortedIds: string[] = [];
  let membershipDirty = false;

  const ensureSortedIds = (): readonly string[] => {
    if (membershipDirty) {
      sortedIds = [...entriesById.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      membershipDirty = false;
    }
    return sortedIds;
  };

  const resolveMaxLag = (): number => {
    if (maxLagDirty) {
      let nextMax = 0;
      for (const lag of lagByRepoId.values()) {
        if (lag > nextMax) nextMax = lag;
      }
      maxProjectionLag = nextMax;
      maxLagDirty = false;
    }
    return maxProjectionLag;
  };

  const upsertEntry = (next: RepoMetricsSnapshot): void => {
    const prev = entriesById.get(next.repoId);
    if (
      prev &&
      prev.state === next.state &&
      prev.queueDepth === next.queueDepth &&
      prev.projectionWatermark === next.projectionWatermark &&
      prev.ledgerRevision === next.ledgerRevision
    ) {
      return;
    }
    if (prev) {
      if (isCountedRepoState(prev.state)) stateCounts[prev.state] -= 1;
      totalQueueDepth -= safeMetricNonNegative(prev.queueDepth);
    } else {
      membershipDirty = true;
    }
    if (isCountedRepoState(next.state)) stateCounts[next.state] += 1;
    totalQueueDepth += safeMetricNonNegative(next.queueDepth);

    const prevLag = lagByRepoId.get(next.repoId);
    const nextLag = computeRepoLag(next);
    if (nextLag === null) nativeMapDelete.call(lagByRepoId, next.repoId);
    else lagByRepoId.set(next.repoId, nextLag);
    if (!maxLagDirty) {
      if (nextLag !== null && nextLag >= maxProjectionLag) {
        maxProjectionLag = nextLag;
      } else if (prevLag !== undefined && prevLag === maxProjectionLag && (nextLag === null || nextLag < prevLag)) {
        maxLagDirty = true;
      }
    }

    entriesById.set(next.repoId, next);
  };

  const removeEntry = (repoId: string): void => {
    const prev = entriesById.get(repoId);
    if (!prev) return;
    nativeMapDelete.call(entriesById, repoId);
    membershipDirty = true;
    if (isCountedRepoState(prev.state)) stateCounts[prev.state] -= 1;
    totalQueueDepth -= safeMetricNonNegative(prev.queueDepth);
    const prevLag = lagByRepoId.get(repoId);
    nativeMapDelete.call(lagByRepoId, repoId);
    if (prevLag !== undefined && prevLag === maxProjectionLag) maxLagDirty = true;
  };

  const syncRepoFromMaps = (repoId: string): void => {
    const warmingStatus = maps.warming.get(repoId);
    if (warmingStatus) {
      upsertEntry(toRepoMetricsSnapshot(warmingStatus));
      return;
    }
    const cell = maps.cells.get(repoId);
    if (cell) {
      upsertEntry(toRepoMetricsSnapshot(cell.publishedStatus ? cell.publishedStatus() : cell.status()));
      return;
    }
    const unavailableStatus = maps.unavailable.get(repoId);
    if (unavailableStatus) {
      upsertEntry(toRepoMetricsSnapshot(unavailableStatus));
      return;
    }
    removeEntry(repoId);
  };

  const rebuildAll = (): void => {
    entriesById.clear();
    lagByRepoId.clear();
    stateCounts.attached = 0;
    stateCounts.warming = 0;
    stateCounts.unavailable = 0;
    totalQueueDepth = 0;
    maxProjectionLag = 0;
    maxLagDirty = false;
    sortedIds = [];
    membershipDirty = false;
    const seen = new Set<string>();
    for (const id of maps.warming.keys()) seen.add(id);
    for (const id of maps.cells.keys()) seen.add(id);
    for (const id of maps.unavailable.keys()) seen.add(id);
    for (const id of seen) syncRepoFromMaps(id);
  };

  instrumentRepoMap(
    maps.cells,
    (repoId) => {
      if (!maps.warming.has(repoId)) syncRepoFromMaps(repoId);
    },
    (repoId) => syncRepoFromMaps(repoId),
    rebuildAll,
  );
  instrumentRepoMap(
    maps.warming,
    (_repoId, status) => upsertEntry(toRepoMetricsSnapshot(status)),
    (repoId) => syncRepoFromMaps(repoId),
    rebuildAll,
  );
  instrumentRepoMap(
    maps.unavailable,
    (repoId, status) => {
      if (!maps.warming.has(repoId) && !maps.cells.has(repoId)) upsertEntry(toRepoMetricsSnapshot(status));
    },
    (repoId) => syncRepoFromMaps(repoId),
    rebuildAll,
  );
  rebuildAll();

  const observability: TrackedRepoObservability = {
    sortedRepoIds: ensureSortedIds,
    publishRepoStatus: (repoId, status) => {
      if (!maps.warming.has(repoId) && maps.cells.has(repoId)) {
        upsertEntry(toRepoMetricsSnapshot(status));
      }
    },
    snapshot: () => {
      const ids = ensureSortedIds();
      const repos: RepoMetricsSnapshot[] = new Array(ids.length);
      for (let index = 0; index < ids.length; index += 1) {
        repos[index] = entriesById.get(ids[index]!)!;
      }
      return {
        repos,
        aggregates: {
          stateCounts: {
            attached: stateCounts.attached,
            warming: stateCounts.warming,
            unavailable: stateCounts.unavailable,
          },
          totalQueueDepth,
          maxProjectionLag: resolveMaxLag(),
        },
      };
    },
  };
  trackedObservabilityByCells.set(maps.cells, observability);
  return observability;
}

export function createTrackedRepoMaps(): TrackedRepoMaps {
  const cells = new Map<string, RepoCell>();
  const warming = new Map<string, RepoCellStatus>();
  const unavailable = new Map<string, RepoCellStatus>();
  const observability = instrumentTrackedRepoMaps({ cells, warming, unavailable });
  return {
    cells,
    warming,
    unavailable,
    sortedRepoIds: observability.sortedRepoIds,
    publishRepoStatus: observability.publishRepoStatus,
  };
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
      const tracked = trackedObservabilityByCells.get(context.cells);
      let repos: readonly RepoMetricsSnapshot[];
      let repoAggregates: RepoMetricsAggregates;
      if (tracked) {
        const precomputed = tracked.snapshot();
        repos = precomputed.repos;
        repoAggregates = precomputed.aggregates;
      } else {
        const fallbackRepos: RepoMetricsSnapshot[] = [];
        const stateCounts = { attached: 0, warming: 0, unavailable: 0 };
        let totalQueueDepth = 0;
        let maxProjectionLag = 0;
        for (const repoId of currentSortedRepoIds()) {
          const status = readPublishedRepoStatus(repoId);
          if (!status) continue;
          const entry = toRepoMetricsSnapshot(status);
          fallbackRepos.push(entry);
          if (isCountedRepoState(entry.state)) stateCounts[entry.state] += 1;
          totalQueueDepth += safeMetricNonNegative(entry.queueDepth);
          const lag = computeRepoLag(entry);
          if (lag !== null && lag > maxProjectionLag) maxProjectionLag = lag;
        }
        repos = fallbackRepos;
        repoAggregates = { stateCounts, totalQueueDepth, maxProjectionLag };
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
      return { repos, repoAggregates, fleet };
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
          await Promise.allSettled([...context.edgeRuntimeOwners.values()].map((runtime) => runtime.close()));
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
