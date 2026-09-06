import assert from "node:assert/strict";
import path from "node:path";
import { openSqliteEventStore } from "../../kernel/src/index.ts";
import type { DaemonHost } from "../src/daemon-host.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";

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

export function fleetLedgerRevision(rootInput: string, repoId: string): number {
  const reader = openSqliteEventStore({ rootInput, repoId, readOnly: true });
  try {
    return reader.revision();
  } finally {
    reader.close();
  }
}
