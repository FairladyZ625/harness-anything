import assert from "node:assert/strict";
import path from "node:path";
import { openSqliteEventStore } from "@harness-anything/kernel";
import type { DaemonHost } from "../src/daemon-host.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { actionDeclarations, deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";

export function fleetHostWriterOptions(userRoot: string, repoIds: readonly string[]) {
  const writerEpochStateRoot = path.join(userRoot, "fleet"),
    authority = openPersistentWriterEpoch({ stateRoot: writerEpochStateRoot });
  try {
    const leases = new Map(
      repoIds.map((repoId) => {
        const lease = authority.current(repoId);
        assert.ok(lease, `host writer lease missing for ${repoId}`);
        return [repoId, lease] as const;
      }),
    );
    return {
      writerEpochStateRoot,
      writerEpochLease: (repoId: string) => {
        const lease = leases.get(repoId);
        assert.ok(lease, `unexpected fixture repo ${repoId}`);
        return lease;
      },
    };
  } finally {
    authority.close();
  }
}

export async function waitForFleetPublication(
  host: DaemonHost,
  repoId: string,
  opId: string,
  auth: Parameters<DaemonHost["run"]>[2],
): Promise<void> {
  const receipt = await host.run(
    repoId,
    { kind: "receipt-show", opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 5_000 },
    auth,
  );
  assert.equal(receipt.wait?.state, "satisfied", JSON.stringify(receipt));
}

/** dec_2665E58BA5AE42E37793193748/CH1: a machine starts only an explicitly assigned task. */
export async function assignFixtureTask(
  host: DaemonHost,
  subject: { repoId: string; taskId: string; nodeId: string },
  auth: Parameters<DaemonHost["run"]>[2],
): Promise<void> {
  const shown = await host.run(subject.repoId, { kind: "task-show", taskId: subject.taskId }, auth);
  const assigned = await host.run(
    subject.repoId,
    {
      kind: "task-assign",
      taskId: subject.taskId,
      nodeId: subject.nodeId,
      expectedVersion: JSON.parse(shown.evidence).revision,
    },
    auth,
  );
  assert.equal(assigned.outcome, "applied", JSON.stringify(assigned));
}

export function fleetLedgerRevision(rootInput: string, repoId: string): number {
  const reader = openSqliteEventStore({ rootInput, repoId, readOnly: true });
  try {
    return reader.revision();
  } finally {
    reader.close();
  }
}

/**
 * The center side of node identity for fleet tests: a fixture Keycloak bound to the center's user root,
 * where each node is registered to its owner and each owner holds every action on `repoIds`. Tests that
 * narrow authority call `keycloak.permit` themselves and pass `grantAll: false`.
 */
export async function fleetNodeOwners(input: {
  readonly userRoot: string;
  readonly owners: Readonly<Record<string, string>>;
  readonly repoIds: readonly string[];
  readonly grantAll?: boolean;
  readonly localPersonId?: string;
}) {
  const served = await serveKeycloak(),
    everyAction = actionDeclarations.map((declaration) => declaration.kind),
    ownerOf = (nodeId: string): string | null =>
      served.keycloak.nodeClients.get(`harness-node-${nodeId}`)?.attributes.harness_person_id ?? null;
  served.bind(input.userRoot);
  const known = new Set<string>(),
    register = (nodeId: string, personId: string): void => {
      if (!known.has(personId)) {
        known.add(personId);
        served.keycloak.account(personId);
        if (input.grantAll !== false)
          for (const repoId of input.repoIds) served.keycloak.permit(personId, repoId, everyAction);
      }
      served.keycloak.node(nodeId, personId);
      // dec_2665E58BA5AE42E37793193748/CH1: provision independent machine grants explicitly.
      if (input.grantAll !== false)
        for (const repoId of input.repoIds)
          served.keycloak.permit(
            `${served.keycloak.nodeClients.get(`harness-node-${nodeId}`)!.id}-service`,
            repoId,
            everyAction,
          );
    };
  for (const [nodeId, personId] of Object.entries(input.owners)) register(nodeId, personId);
  if (input.localPersonId !== undefined) {
    if (!known.has(input.localPersonId)) served.keycloak.account(input.localPersonId);
    for (const repoId of input.repoIds)
      served.keycloak.permit(
        input.localPersonId,
        repoId,
        effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"),
      );
    signInAt(input.userRoot, input.localPersonId);
  }
  return {
    keycloak: served.keycloak,
    bind: served.bind,
    url: served.url,
    close: served.close,
    nodeOwner: ownerOf,
    nodeSubject: async (nodeId: string) => {
      const client = served.keycloak.nodeClients.get(`harness-node-${nodeId}`);
      return client ? `${client.id}-service` : null;
    },
    /** Re-registers a node to another person, the way an administrator moves a machine between owners. */
    reassign: register,
    /** The authentication context the center derives for one authenticated node frame. */
    auth: (node: { readonly nodeId: string }) => {
      const personId = ownerOf(node.nodeId);
      assert.ok(personId, `fixture node ${node.nodeId} has no registered owner`);
      return {
        transportKind: "fleet-tls" as const,
        nodePrincipal: {
          nodeId: node.nodeId,
          personId,
          subject: `${served.keycloak.nodeClients.get(`harness-node-${node.nodeId}`)!.id}-service`,
        },
      };
    },
  };
}
