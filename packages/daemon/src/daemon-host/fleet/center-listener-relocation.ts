import path from "node:path";
import {
  openPersistentWriterEpoch,
  readCenterRelocated,
  readLedgerWriterEpoch,
  type PersistentWriterEpoch,
  type WriterEpochLease,
} from "@harness-anything/storage";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import type { CenterMovedDetails, CenterRelocatedTombstoneV1, FleetCenterOptions } from "./center-types.ts";
import { FleetFault } from "./center-types.ts";
import type { createNodeRetirementAdmission } from "./node-retirement.ts";

export function readListenerCenterRelocated(options: FleetCenterOptions): CenterRelocatedTombstoneV1 | null {
  return options.centerRelocated ?? readCenterRelocated(options.relocationRoot ?? path.dirname(options.stateRoot));
}

export function centerMovedFleetFault(details: CenterMovedDetails): FleetFault {
  return new FleetFault(
    "CENTER_MOVED",
    "The center has moved; repoint this edge before retrying.",
    false,
    null,
    details,
  );
}

export function openCenterRelocationEpochs(
  options: FleetCenterOptions,
  centerRelocated: CenterRelocatedTombstoneV1 | null,
  now: () => string,
): {
  readonly writerEpoch: PersistentWriterEpoch;
  readonly ownedEpochFor: (repoId: string) => WriterEpochLease;
  readonly currentEpochFor: (repoId: string) => WriterEpochLease;
  readonly drainAndCloseWriterEpochs: () => Promise<void>;
} {
  const writerEpoch = openPersistentWriterEpoch({
      stateRoot: options.writerEpochStateRoot ?? options.stateRoot,
      holderId: options.writerId,
      now,
      storageByRepo: options.storage,
    }),
    ownedEpochs = new Map<string, ReturnType<PersistentWriterEpoch["acquire"]>>(),
    acquireWriterEpoch =
      options.writerEpochLease ??
      ((repoId: string) => {
        if (centerRelocated) throw centerMovedFleetFault(centerRelocated);
        const rootDir = options.host.status().repos.find((repo) => repo.repoId === repoId)?.rootDir;
        return writerEpoch.acquire(repoId, readLedgerWriterEpoch(repoId, rootDir, options.storage?.[repoId]));
      });
  if (!centerRelocated)
    for (const repo of options.host.status().repos)
      if (repo.state === "attached") ownedEpochs.set(repo.repoId, acquireWriterEpoch(repo.repoId));
  // A center must keep using the epoch it acquired, even after another center
  // advances the shared state. Reading the latest row here would let a stale
  // process silently adopt its successor's epoch and defeat fencing.
  const ownedEpochFor = (repoId: string) => {
      const owned = ownedEpochs.get(repoId);
      if (owned) return owned;
      const acquired = acquireWriterEpoch(repoId);
      ownedEpochs.set(repoId, acquired);
      return acquired;
    },
    currentEpochFor = (repoId: string) => writerEpoch.current(repoId) ?? ownedEpochFor(repoId),
    drainAndCloseWriterEpochs = async () => {
      try {
        for (const [repoId, owned] of ownedEpochs) {
          const current = writerEpoch.current(repoId);
          if (current?.epoch === owned.epoch && current.holderId === owned.holderId)
            await options.host.settleMaterialization(repoId, "fleet center close");
        }
      } finally {
        writerEpoch.close();
      }
    };
  return { writerEpoch, ownedEpochFor, currentEpochFor, drainAndCloseWriterEpochs };
}

export function createCenterNodePrincipals(input: {
  readonly options: FleetCenterOptions;
  readonly nodeGate: ReturnType<typeof createNodeRetirementAdmission>;
  readonly writerEpoch: PersistentWriterEpoch;
  readonly ownedEpochFor: (repoId: string) => WriterEpochLease;
}) {
  const { options, nodeGate, writerEpoch, ownedEpochFor } = input;
  // dec_E610E1D99A39003886D1B5EE7C CH1: device admission and per-request person are independent.
  const readerAuth = async (node: { nodeId: string; repoId: string; accessToken?: string }) => {
      nodeGate.assertOpen(node.nodeId);
      const personId = await options.nodeOwner(node.nodeId);
      if (!personId) throw new FleetFault("node_owner_unregistered", `Node ${node.nodeId} has no registered owner.`);
      if (!node.accessToken || !options.verifyHuman)
        throw new FleetFault("authentication_required", "Sign in on this device before using Fleet.");
      try {
        const principal = await options.verifyHuman({
          transportKind: "fleet-tls",
          nodePrincipal: { nodeId: node.nodeId, personId },
          humanAccessToken: node.accessToken,
        });
        nodeGate.assertOpen(node.nodeId);
        return principal;
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
          // `daemon_error` is the Keycloak adapters' transport sentinel; a fleet session check that
          // could not reach the identity authority is a retryable outage, not an unclassified fault.
          const code = error.code === "daemon_error" ? "keycloak_unavailable" : error.code;
          throw new FleetFault(code, error instanceof Error ? error.message : "Device session was rejected.");
        }
        throw error;
      }
    },
    principalAuth = async (
      node: { nodeId: string; repoId: string; accessToken?: string },
      accessToken?: string,
      executionCredential?: string,
    ): Promise<DaemonAuthenticationContext> => {
      const principal = await readerAuth({ ...node, accessToken: accessToken ?? node.accessToken });
      if (!executionCredential) return principal;
      if (!options.authenticateExecutionPrincipal)
        throw new FleetFault("execution_credential_rejected", "Execution credential authentication is unavailable.");
      const executionPrincipal = await options.authenticateExecutionPrincipal(executionCredential);
      if (
        executionPrincipal.repoId !== node.repoId ||
        executionPrincipal.personId !== principal.oidcPrincipal?.personId
      )
        throw new FleetFault(
          "execution_credential_rejected",
          "Execution credential does not match this repository session.",
        );
      return { ...principal, executionCredential, executionPrincipal };
    },
    writerAuth = async (
      node: { nodeId: string; repoId: string; accessToken?: string },
      accessToken?: string,
      executionCredential?: string,
    ) => {
      const acquired = ownedEpochFor(node.repoId);
      const principal = await principalAuth(node, accessToken, executionCredential);
      nodeGate.assertOpen(node.nodeId);
      return {
        ...principal,
        writerEpoch: acquired.epoch,
        withWriterEpochFence: <T>(operation: () => T) =>
          writerEpoch.withAppendFence(node.repoId, acquired.epoch, acquired.holderId, operation),
        writerEpochFence: {
          schema: "harness-writer-epoch-fence/v1" as const,
          stateRoot: options.writerEpochStateRoot ?? options.stateRoot,
          repoId: node.repoId,
          epoch: acquired.epoch,
          holderId: acquired.holderId,
        },
      };
    },
    // The one repository admission port: verified request identity plus that person's grant on this
    // repository (dec_66CE6F92 — a cross-cutting responsibility has a single implementation that
    // callers reuse instead of copying).
    repoAdmission = async (node: { nodeId: string; repoId: string; accessToken?: string }) => {
      const principal = await readerAuth(node),
        decision = await options.host.authorize(node.repoId, "repository-read", principal);
      if (decision.outcome !== "allowed")
        throw new FleetFault("authorization_denied", "The request user may not read this repository.");
      return principal;
    },
    replicaAdmission = async (node: { nodeId: string; repoId: string; accessToken?: string }) => {
      nodeGate.assertOpen(node.nodeId);
      if (!options.verifyReplica) return repoAdmission(node);
      const personId = await options.nodeOwner(node.nodeId);
      if (!personId) throw new FleetFault("node_owner_unregistered", `Node ${node.nodeId} has no registered owner.`);
      let machine: DaemonAuthenticationContext | null;
      try {
        machine = await options.verifyReplica({
          transportKind: "fleet-tls",
          nodePrincipal: { nodeId: node.nodeId, personId },
          humanAccessToken: node.accessToken,
        });
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "daemon_error")
          throw new FleetFault(
            "keycloak_unavailable",
            "The identity authority could not verify the replica credential.",
            true,
          );
        throw error;
      }
      if (!machine) return repoAdmission(node);
      const principal = machine.fleetReplicaPrincipal;
      if (
        !principal ||
        principal.nodeId !== node.nodeId ||
        principal.personId !== personId ||
        principal.expiresAt <= Date.now()
      )
        throw new FleetFault("fleet_replica_credential_rejected", "The Fleet replica credential was rejected.");
      nodeGate.assertOpen(node.nodeId);
      const decision = await options.host.authorize(node.repoId, "repository-read", machine);
      if (decision.outcome !== "allowed")
        throw new FleetFault("authorization_denied", "The node owner may not read this repository.");
      return machine;
    };
  return { readerAuth, principalAuth, writerAuth, repoAdmission, replicaAdmission };
}
