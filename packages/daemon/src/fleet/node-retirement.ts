import type { AuthorizationProvider, AccessAdminRequest } from "@harness-anything/kernel";
import { coded, text } from "../access-admin-utils.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import { makeTaskProjectionReader, openReplicationSlots } from "@harness-anything/storage";
import { FleetFault } from "./center-types.ts";
import type { FleetTlsCenter } from "./center-types.ts";

export interface NodeRetirementSnapshot {
  readonly online: boolean;
  readonly inFlight: number;
  readonly slots: readonly { readonly nodeId: string; readonly repoId: string }[];
  readonly leases: readonly { readonly repoId: string; readonly taskId: string; readonly executionId: string }[];
  readonly executions: readonly { readonly repoId: string; readonly runtimeSessionId: string }[];
}

/** The identity writer owns this port; the listener owns live admission and replication state. */
export function createNodeRetirement(input: {
  readonly stateRoot: string | (() => string);
  readonly center?: () => FleetTlsCenter | null;
  readonly repositories?: () => readonly {
    readonly repoId: string;
    readonly rootDir: string;
    readonly state: string;
  }[];
}) {
  const withSlots = <T>(read: (slots: ReturnType<typeof openReplicationSlots>) => T): T | undefined => {
    const file = path.join(
      typeof input.stateRoot === "function" ? input.stateRoot() : input.stateRoot,
      "replication-slots.sqlite",
    );
    if (!existsSync(file)) return undefined;
    const slots = openReplicationSlots(file);
    try {
      return read(slots);
    } finally {
      slots.close();
    }
  };
  return {
    inspect(nodeId: string): NodeRetirementSnapshot {
      const center = input.center?.(),
        live = center?.inspectNode(nodeId);
      const leases: NodeRetirementSnapshot["leases"][number][] = [],
        executions: NodeRetirementSnapshot["executions"][number][] = [];
      for (const repo of input.repositories?.() ?? []) {
        if (repo.state !== "attached")
          throw Object.assign(new Error(`Cannot inspect work in unavailable repository ${repo.repoId}.`), {
            code: "node_retirement_unavailable",
          });
        const reader = makeTaskProjectionReader({ rootDir: repo.rootDir });
        try {
          reader.withSession((projection) => {
            for (const row of projection.list().rows) {
              const lease = row.snapshot.lease;
              if (
                lease &&
                lease.phase !== "released" &&
                typeof lease.source === "object" &&
                lease.source.kind === "node" &&
                lease.source.nodeId === nodeId
              )
                leases.push({ repoId: repo.repoId, taskId: row.taskId, executionId: lease.executionId });
            }
            const owned = new Set(
              projection
                .readRuntimeDispatches()
                .filter(
                  (event) =>
                    typeof event.source === "object" && event.source.kind === "node" && event.source.nodeId === nodeId,
                )
                .map((event) => event.payload.runtimeSessionId),
            );
            for (const session of projection.readRuntimeSessions())
              if (session.liveness !== "exited" && owned.has(session.runtimeSessionId))
                executions.push({ repoId: repo.repoId, runtimeSessionId: session.runtimeSessionId });
          });
        } finally {
          reader.close();
        }
      }
      return {
        online: live?.online ?? false,
        inFlight: live?.inFlight ?? 0,
        slots: live?.slots ?? withSlots((slots) => slots.list().filter((slot) => slot.nodeId === nodeId)) ?? [],
        leases,
        executions,
      };
    },
    fence(nodeId: string): () => void {
      return input.center?.()?.fenceNode(nodeId) ?? (() => undefined);
    },
    async drain(nodeId: string): Promise<void> {
      await input.center?.()?.drainNode(nodeId);
    },
    remove(nodeId: string): void {
      const center = input.center?.();
      if (center) center.removeNode(nodeId);
      else withSlots((slots) => slots.removeNode(nodeId));
    },
  };
}
export type NodeRetirement = ReturnType<typeof createNodeRetirement>;

export async function planNodeRetirement(
  session: { readonly adapter: AuthorizationProvider; readonly token: string },
  request: AccessAdminRequest,
  retirement: NodeRetirement,
) {
  const nodeId = text(request.nodeId, "nodeId");
  const current = await session.adapter.readNode(session.token, nodeId);
  const snapshot = retirement.inspect(nodeId);
  if (!current && !snapshot.slots.length && !snapshot.online && !snapshot.leases.length && !snapshot.executions.length)
    throw coded("node_unknown", `Node ${nodeId} is not registered and has no fleet state.`);
  const currentVersion = current ? String(current.revision) : "unregistered",
    preview = {
      nodeId,
      personId: current?.personId ?? null,
      expectedVersion: currentVersion,
      ...snapshot,
      force: request.force === true,
      effects: [
        "revoke-device-credentials-and-consent",
        "disconnect-sessions",
        "remove-all-replication-slots",
        "remove-sync-failures",
      ],
      workRecovery:
        "Existing leases and executions are preserved for explicit recovery; further node writes are fenced. Rejoin using ha edge join with a new node identity.",
    };
  if (request.confirm === true) {
    const expectedVersion = text(request.expectedVersion, "expectedVersion");
    if (expectedVersion !== currentVersion) {
      return { conflict: { nodeId, expectedVersion, currentVersion } };
    }
    if (
      !request.force &&
      (snapshot.online || snapshot.inFlight || snapshot.leases.length || snapshot.executions.length)
    )
      throw coded(
        "node_busy",
        `Node ${nodeId} is online or owns active work. Preview the work and pass --force to fence it without releasing its leases or terminating processes.`,
      );
  }
  return {
    expect: { kind: "node" as const, nodeId, version: String((current?.revision ?? 0) + 1), state: "removed" as const },
    preview,
    release: request.confirm === true ? retirement.fence(nodeId) : undefined,
    apply: async () => {
      await retirement.drain(nodeId);
      await session.adapter.deleteNode(session.token, nodeId);
    },
  };
}

/** Stop new commands, then drain the ones already dispatched to repository writers before revocation.
 * Function fences cannot cross the RepoWriter worker boundary; draining covers that boundary. */
export function createNodeRetirementAdmission() {
  const retiring = new Set<string>(),
    removed = new Set<string>(),
    counts = new Map<string, number>(),
    waiters = new Map<string, Set<() => void>>();
  const isOpen = (nodeId: string) => !retiring.has(nodeId) && !removed.has(nodeId),
    assertOpen = (nodeId: string) => {
      if (!isOpen(nodeId))
        throw new FleetFault(
          "node_retired",
          "Node admission was revoked. Rejoin using ha edge join with a new node identity.",
        );
    };
  return {
    isOpen,
    assertOpen,
    inFlight: (nodeId: string) => counts.get(nodeId) ?? 0,
    async run<T>(nodeId: string, operation: () => Promise<T>): Promise<T> {
      assertOpen(nodeId);
      counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
      try {
        return await operation();
      } finally {
        const remaining = (counts.get(nodeId) ?? 1) - 1;
        if (remaining) counts.set(nodeId, remaining);
        else {
          counts.delete(nodeId);
          for (const done of waiters.get(nodeId) ?? []) done();
          waiters.delete(nodeId);
        }
      }
    },
    fence(nodeId: string): () => void {
      retiring.add(nodeId);
      return () => {
        retiring.delete(nodeId);
      };
    },
    remove(nodeId: string): void {
      removed.add(nodeId);
    },
    async drain(nodeId: string): Promise<void> {
      if (!counts.has(nodeId)) return;
      await new Promise<void>((resolve, reject) => {
        const waiting = waiters.get(nodeId) ?? new Set<() => void>(),
          timer = setTimeout(() => {
            waiting.delete(done);
            reject(
              new FleetFault(
                "node_retirement_inflight",
                "Admitted node writes did not drain within 30 seconds; retry retirement after work settles.",
              ),
            );
          }, 30_000),
          done = () => {
            clearTimeout(timer);
            resolve();
          };
        waiting.add(done);
        waiters.set(nodeId, waiting);
      });
    },
  };
}
