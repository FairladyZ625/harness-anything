import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  createCompoundReceiptServiceV2,
  type AckCommittedFrameV1,
  type AuthorityOperationReceipt,
  type CompoundOperationReceiptV2,
  type GetWaiterFrameV1,
  type ReplicaChangeLog,
  type ReceiptIdentityV2,
  type ResultPreparedFrameV1,
  type WaiterOpenedFrameV1,
  type WaiterStateFrameV1
} from "../../../application/src/index.ts";
import {
  createBrokerCompoundReceiptCoordinatorV2,
  ReplicaBroker
} from "../../../daemon/src/index.ts";
import { createDurableCompoundReceiptStoreV2, renderCompoundCliExit } from "../receipt/index.ts";

/**
 * The daemon-owned compound path.  Keeping this owner beside the daemon
 * lifecycle is deliberate: receipt state survives clients and is never a CLI
 * process-local cache.
 */
export interface ProductionCompoundReceiptComposition {
  readonly openWaiter: (input: { readonly requestId: string; readonly opId: string }) => Promise<WaiterOpenedFrameV1>;
  readonly recordAuthority: (identity: ReceiptIdentityV2, receipt: AuthorityOperationReceipt) => Promise<ResultPreparedFrameV1 | CompoundOperationReceiptV2>;
  readonly acknowledge: (input: Omit<Parameters<ProductionCompoundReceiptComposition["recover"]>[0], "requestId"> & {
    readonly preparedSequence: number;
    readonly preparedReceiptDigest: string;
  }) => Promise<AckCommittedFrameV1>;
  readonly recover: (input: Omit<GetWaiterFrameV1, "type" | "kind">) => Promise<WaiterStateFrameV1>;
  readonly renderExit: (receipt: CompoundOperationReceiptV2) => ReturnType<typeof renderCompoundCliExit>;
}

export function createProductionCompoundReceiptComposition(input: {
  readonly workspaceId: string;
  readonly viewId: string;
  readonly canonicalRoot: string;
  readonly stateDirectory: string;
  readonly replicaChangeLog: ReplicaChangeLog;
}): ProductionCompoundReceiptComposition {
  mkdirSync(input.stateDirectory, { recursive: true, mode: 0o700 });
  const receipts = createCompoundReceiptServiceV2({
    store: createDurableCompoundReceiptStoreV2({ directory: path.join(input.stateDirectory, "receipts") })
  });
  const coordinator = createBrokerCompoundReceiptCoordinatorV2({
    receipts,
    broker: new ReplicaBroker({
      workspaceId: input.workspaceId,
      viewId: input.viewId,
      viewRoot: input.canonicalRoot,
      stateRoot: path.join(input.stateDirectory, "broker"),
      replicaChangeLog: input.replicaChangeLog,
      snapshotSource: { snapshotAt: (change) => gitSnapshot(input.canonicalRoot, change.workspaceId, change.revision, change.commitSha) },
      writerExclusion: processWriterExclusion(),
      watcherFence: processWatcherFence()
    })
  });
  return {
    openWaiter: async ({ requestId, opId }) => {
      const frame = await coordinator.wire.handle({
        type: "harness-compound-receipt-wire/v1",
        kind: "OPEN_WAITER",
        requestId,
        workspaceId: input.workspaceId,
        viewId: input.viewId,
        opId
      });
      if (frame.kind !== "WAITER_OPENED") throw new Error("COMPOUND_WAITER_OPEN_PROTOCOL_DAMAGED");
      return frame;
    },
    recordAuthority: async (identity, receipt) => {
      const resolved = await coordinator.recordAuthorityAndResolve(identity, receipt);
      return resolved.delivery === "RESULT_PREPARED" ? coordinator.wire.resultPrepared(resolved) : resolved;
    },
    acknowledge: async (frame) => {
      const result = await coordinator.wire.handle({ type: "harness-compound-receipt-wire/v1", kind: "DELIVERY_ACK", ...frame });
      if (result.kind !== "ACK_COMMITTED") throw new Error("COMPOUND_ACK_PROTOCOL_DAMAGED");
      return result;
    },
    recover: async (frame) => {
      const result = await coordinator.wire.handle({ type: "harness-compound-receipt-wire/v1", kind: "GET_WAITER", ...frame });
      if (result.kind !== "WAITER_STATE") throw new Error("COMPOUND_WAITER_QUERY_PROTOCOL_DAMAGED");
      return result;
    },
    renderExit: (receipt) => renderCompoundCliExit({ kind: "RECEIPT", receipt })
  };
}

async function gitSnapshot(root: string, workspaceId: string, revision: number, commitSha: string) {
  const listing = execFileSync("git", ["-C", root, "ls-tree", "-r", "-z", "--full-tree", commitSha], { windowsHide: true });
  const entries = Buffer.from(listing).toString("utf8").split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t");
    if (tab < 0) throw new Error("COMPOUND_GIT_TREE_PROTOCOL_DAMAGED");
    const pathName = row.slice(tab + 1);
    return { path: pathName, content: execFileSync("git", ["-C", root, "show", `${commitSha}:${pathName}`], { windowsHide: true }) };
  });
  return { workspaceId, revision, commitSha, entries };
}

function processWriterExclusion() {
  let held = false;
  return {
    acquire: async () => {
      if (held) return undefined;
      held = true;
      return { release: async () => { held = false; } };
    }
  };
}

function processWatcherFence() {
  let sequence = 0;
  return {
    fence: async (paths: ReadonlyArray<string>) => Object.fromEntries(paths.map((item) => [item, `daemon-${++sequence}`]))
  };
}
