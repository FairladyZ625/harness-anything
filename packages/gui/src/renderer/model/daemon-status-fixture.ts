import type { DaemonStatusModel } from "./daemon-status.ts";
import { readDaemonStatus } from "./daemon-status.ts";

/**
 * Healthy two-repo fixture mirroring draft statusHealthyTwoRepo.
 * Lock-owner identity from the wire shape is omitted: the panel only shows
 * lock paths, and privileged identity material must not live in the renderer.
 */
export const DAEMON_STATUS_HEALTHY_TWO_REPO_RAW = {
  schema: "daemon-status/v2",
  service: {
    daemonId: "ha-user-501",
    pid: 41001,
    endpoint: "/Users/example/.harness/daemon.sock",
    userRoot: "/Users/example",
    started: true,
    startedAt: "2026-07-16T08:00:00.000Z",
    uptimeMs: 1_800_000,
    build: {
      version: "0.1.0",
      loadedIdentity:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      installedIdentity:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      identitySource: "installed-artifact-set",
      stale: false,
    },
    queue: {
      interactive: 0,
      normal: 0,
      background: 1,
      maintenance: 0,
      running: true,
      depth: 1,
    },
    connections: { active: 2, total: 17 },
    repoCount: 2,
    attachedCount: 2,
    unavailableCount: 0,
    lastReconcileAt: "2026-07-16T08:29:59.000Z",
    lastReconcileError: null,
    activeControl: null,
  },
  requestedRepo: {
    repoId: "canonical",
    canonicalRoot: "/work/canonical",
    displayName: "Canonical",
    state: "attached",
    lock: { path: ".harness/journal/global.lock" },
    queue: {
      interactive: 0,
      normal: 0,
      background: 1,
      maintenance: 0,
      running: true,
      depth: 1,
    },
    lastRecovery: null,
    projectionGeneration: null,
    lastError: null,
    lastMaterializerError: null,
    lastReconcileError: null,
  },
  repos: [
    {
      repoId: "canonical",
      canonicalRoot: "/work/canonical",
      displayName: "Canonical",
      state: "attached",
      lock: { path: ".harness/journal/global.lock" },
      queue: {
        interactive: 0,
        normal: 0,
        background: 1,
        maintenance: 0,
        running: true,
        depth: 1,
      },
      lastRecovery: null,
      projectionGeneration: null,
      lastError: null,
      lastMaterializerError: null,
      lastReconcileError: null,
    },
    {
      repoId: "experiment",
      canonicalRoot: "/work/experiment",
      displayName: "Experiment",
      state: "attached",
      lock: { path: ".harness/journal/global.lock" },
      queue: {
        interactive: 0,
        normal: 0,
        background: 0,
        maintenance: 0,
        running: false,
        depth: 0,
      },
      lastRecovery: null,
      projectionGeneration: null,
      lastError: null,
      lastMaterializerError: null,
      lastReconcileError: null,
    },
  ],
} as const;

/**
 * One-unavailable + stale-build fixture mirroring draft
 * statusOneUnavailableAndStale. Exercises the stale chip, unavailableCount,
 * danger state pills, and lastReconcileError.
 */
export const DAEMON_STATUS_STALE_UNAVAILABLE_RAW = {
  schema: "daemon-status/v2",
  service: {
    daemonId: "ha-user-501",
    pid: 41001,
    endpoint: "/Users/example/.harness/daemon.sock",
    userRoot: "/Users/example",
    started: true,
    startedAt: "2026-07-16T08:00:00.000Z",
    uptimeMs: 1_800_000,
    build: {
      version: "0.1.0",
      loadedIdentity:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      installedIdentity:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      identitySource: "installed-artifact-set",
      stale: true,
    },
    queue: {
      interactive: 0,
      normal: 0,
      background: 0,
      maintenance: 0,
      running: false,
      depth: 0,
    },
    connections: { active: 1, total: 18 },
    repoCount: 2,
    attachedCount: 1,
    unavailableCount: 1,
    lastReconcileAt: "2026-07-16T08:29:59.000Z",
    lastReconcileError: {
      at: "2026-07-16T08:29:59.000Z",
      code: "repo_reconcile_failed",
      message: "repo experiment remains unavailable",
      repoId: "experiment",
    },
    activeControl: null,
  },
  requestedRepo: {
    repoId: "canonical",
    canonicalRoot: "/work/canonical",
    displayName: "Canonical",
    state: "attached",
    lock: { path: ".harness/journal/global.lock" },
    queue: {
      interactive: 0,
      normal: 0,
      background: 0,
      maintenance: 0,
      running: false,
      depth: 0,
    },
    lastRecovery: null,
    projectionGeneration: null,
    lastError: null,
    lastMaterializerError: null,
    lastReconcileError: null,
  },
  repos: [
    {
      repoId: "canonical",
      canonicalRoot: "/work/canonical",
      displayName: "Canonical",
      state: "attached",
      lock: { path: ".harness/journal/global.lock" },
      queue: {
        interactive: 0,
        normal: 0,
        background: 0,
        maintenance: 0,
        running: false,
        depth: 0,
      },
      lastRecovery: null,
      projectionGeneration: null,
      lastError: null,
      lastMaterializerError: null,
      lastReconcileError: null,
    },
    {
      repoId: "experiment",
      canonicalRoot: "/work/experiment",
      displayName: "Experiment",
      state: "unavailable",
      lock: { path: null },
      queue: {
        interactive: 0,
        normal: 0,
        background: 0,
        maintenance: 0,
        running: false,
        depth: 0,
      },
      lastRecovery: null,
      projectionGeneration: null,
      lastError: "global lock already held",
      lastMaterializerError: null,
      lastReconcileError: {
        at: "2026-07-16T08:29:59.000Z",
        code: "repo_reconcile_failed",
        message: "global lock already held",
        repoId: "experiment",
      },
    },
  ],
} as const;

/** Unreachable / error path — thrown by the loader for the error UI. */
export class DaemonStatusUnreachableError extends Error {
  constructor(message = "Daemon unreachable") {
    super(message);
    this.name = "DaemonStatusUnreachableError";
  }
}

/**
 * Fixture with an active restart control in progress — useful for manual flip
 * and for covering the activeControl banner path.
 */
export const DAEMON_STATUS_ACTIVE_CONTROL_RAW = {
  ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW,
  service: {
    ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.service,
    activeControl: {
      operationId: "control_01KXN0RESTART",
      kind: "restart",
      phase: "draining",
      requestedAt: "2026-07-16T08:30:00.000Z",
    },
  },
} as const;

export type DaemonStatusFixtureKind =
  | "healthy-two-repo"
  | "stale-unavailable"
  | "active-control"
  | "unreachable";

let activeFixtureKind: DaemonStatusFixtureKind = "healthy-two-repo";

/** Test-only seam to flip which fixture the loader returns. */
export function setDaemonStatusFixtureKind(kind: DaemonStatusFixtureKind): void {
  activeFixtureKind = kind;
}

export function getDaemonStatusFixtureKind(): DaemonStatusFixtureKind {
  return activeFixtureKind;
}

function rawForKind(kind: DaemonStatusFixtureKind): unknown {
  switch (kind) {
    case "stale-unavailable":
      return DAEMON_STATUS_STALE_UNAVAILABLE_RAW;
    case "active-control":
      return DAEMON_STATUS_ACTIVE_CONTROL_RAW;
    case "unreachable":
      return null;
    case "healthy-two-repo":
    default:
      return DAEMON_STATUS_HEALTHY_TWO_REPO_RAW;
  }
}

/**
 * Async fixture loader — shape matches a future bridge call so the hook can
 * swap implementations with a one-line change.
 *
 * // TODO(daemon-wire): replace fixture with real bridge call once X4 GUI route lands
 */
export async function loadDaemonStatusFixture(): Promise<DaemonStatusModel> {
  // Tiny yield so react-query can observe a loading tick under test if needed.
  await Promise.resolve();
  if (activeFixtureKind === "unreachable") {
    throw new DaemonStatusUnreachableError("Could not read daemon status.");
  }
  return readDaemonStatus(rawForKind(activeFixtureKind));
}
