/**
 * Renderer fixtures for daemon-status/v2.
 *
 * The healthy fixture is a VERBATIM copy of
 * packages/daemon/fixtures/api-schemas/daemon.status-result__v2/valid.json
 * projected through projectDaemonStatusForRenderer (main-side helper) so the
 * renderer never sees lock-owner identity. Regenerate from the canonical
 * fixture when that file changes.
 *
 * Stale/unavailable + active-control fixtures exercise additional panel paths
 * and remain derived from the projected healthy baseline without reintroducing
 * owner identity fields.
 */

import type { DaemonStatusModel } from "./daemon-status.ts";

/**
 * Verbatim copy of packages/daemon/fixtures/api-schemas/daemon.status-result__v2/valid.json
 * after projectDaemonStatusForRenderer (lock fields carry path only).
 */
export const DAEMON_STATUS_HEALTHY_TWO_REPO_RAW = {
  schema: "daemon-status/v2",
  daemonId: "ha-user-501",
  pid: 41001,
  started: true,
  rootDir: "/work/canonical",
  repoId: "canonical",
  endpoint: "/Users/example/.harness/daemon.sock",
  version: "0.1.0",
  protocolVersion: 1,
  queue: {
    interactive: 0,
    normal: 0,
    background: 1,
    maintenance: 0,
    running: true,
    depth: 1
  },
  queueDepth: 1,
  connections: { active: 2, total: 17 },
  lastReconcileAt: "2026-07-16T08:29:59.000Z",
  lastReconcileError: null,
  lastRecovery: null,
  projectionGeneration: null,
  service: {
    daemonId: "ha-user-501",
    pid: 41001,
    endpoint: "/Users/example/.harness/daemon.sock",
    userRoot: "/Users/example/.harness",
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
      stale: false
    },
    queue: {
      interactive: 0,
      normal: 0,
      background: 1,
      maintenance: 0,
      running: true,
      depth: 1
    },
    connections: { active: 2, total: 17 },
    repoCount: 2,
    attachedCount: 2,
    unavailableCount: 0,
    lastReconcileAt: "2026-07-16T08:29:59.000Z",
    lastReconcileError: null,
    activeControl: null
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
      depth: 1
    },
    lastRecovery: null,
    projectionGeneration: null,
    lastError: null,
    lastMaterializerError: null,
    lastReconcileError: null
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
        depth: 1
      },
      lastRecovery: null,
      projectionGeneration: null,
      lastError: null,
      lastMaterializerError: null,
      lastReconcileError: null
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
        depth: 0
      },
      lastRecovery: null,
      projectionGeneration: null,
      lastError: null,
      lastMaterializerError: null,
      lastReconcileError: null
    }
  ]
} as const satisfies DaemonStatusModel;

/**
 * One-unavailable + stale-build fixture derived from the projected healthy
 * baseline (lock.path only — no lock-owner identity).
 */
export const DAEMON_STATUS_STALE_UNAVAILABLE_RAW = {
  ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW,
  connections: { active: 1, total: 18 },
  queue: {
    interactive: 0,
    normal: 0,
    background: 0,
    maintenance: 0,
    running: false,
    depth: 0
  },
  queueDepth: 0,
  lastReconcileError: {
    at: "2026-07-16T08:29:59.000Z",
    code: "repo_reconcile_failed",
    message: "repo experiment remains unavailable",
    repoId: "experiment"
  },
  service: {
    ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.service,
    build: {
      ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.service.build,
      installedIdentity:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      stale: true
    },
    queue: {
      interactive: 0,
      normal: 0,
      background: 0,
      maintenance: 0,
      running: false,
      depth: 0
    },
    connections: { active: 1, total: 18 },
    attachedCount: 1,
    unavailableCount: 1,
    lastReconcileError: {
      at: "2026-07-16T08:29:59.000Z",
      code: "repo_reconcile_failed",
      message: "repo experiment remains unavailable",
      repoId: "experiment"
    }
  },
  requestedRepo: {
    ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.requestedRepo,
    queue: {
      interactive: 0,
      normal: 0,
      background: 0,
      maintenance: 0,
      running: false,
      depth: 0
    }
  },
  repos: [
    {
      ...DAEMON_STATUS_HEALTHY_TWO_REPO_RAW.repos[0],
      queue: {
        interactive: 0,
        normal: 0,
        background: 0,
        maintenance: 0,
        running: false,
        depth: 0
      }
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
        depth: 0
      },
      lastRecovery: null,
      projectionGeneration: null,
      lastError: "global lock already held",
      lastMaterializerError: null,
      lastReconcileError: {
        at: "2026-07-16T08:29:59.000Z",
        code: "repo_reconcile_failed",
        message: "global lock already held",
        repoId: "experiment"
      }
    }
  ]
} as const satisfies DaemonStatusModel;

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
      requestedAt: "2026-07-16T08:30:00.000Z"
    }
  }
} as const satisfies DaemonStatusModel;

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

function modelForKind(kind: DaemonStatusFixtureKind): DaemonStatusModel {
  switch (kind) {
    case "stale-unavailable":
      return DAEMON_STATUS_STALE_UNAVAILABLE_RAW;
    case "active-control":
      return DAEMON_STATUS_ACTIVE_CONTROL_RAW;
    case "unreachable":
      throw new DaemonStatusUnreachableError("Could not read daemon status.");
    case "healthy-two-repo":
    default:
      return DAEMON_STATUS_HEALTHY_TWO_REPO_RAW;
  }
}

/**
 * Async fixture loader used by unit tests. Production code paths call the
 * real harnessClient.getDaemonStatus() bridge.
 */
export async function loadDaemonStatusFixture(): Promise<DaemonStatusModel> {
  await Promise.resolve();
  return modelForKind(activeFixtureKind);
}
