import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  createCompoundReceiptServiceV2,
  type AckCommittedFrameV1,
  type AuthorityGenerationFence,
  type AuthorityOperationReceipt,
  type CompoundOperationReceiptV2,
  type GetWaiterFrameV1,
  type ReplicaChangeLog,
  type ReceiptIdentityV2,
  type ResultPreparedFrameV1,
  type WaiterOpenedFrameV1,
  type WaiterStateFrameV1
} from "@harness-anything/application";
import {
  createBrokerCompoundReceiptCoordinatorV2,
  RemoteBrokerRuntime,
  ReplicaBroker,
  type RemoteReadDownSessionOptions
} from "@harness-anything/daemon";
import { createDurableCompoundReceiptStoreV2 } from "./durable-compound-receipt-store.ts";

/**
 * The daemon-owned compound path.  Keeping this owner beside the daemon
 * lifecycle is deliberate: receipt state survives clients and is never a CLI
 * process-local cache.
 */
export interface ProductionCompoundReceiptComposition {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly openWaiter: (input: { readonly requestId: string; readonly opId: string }) => Promise<WaiterOpenedFrameV1>;
  readonly recordAuthority: (identity: ReceiptIdentityV2, receipt: AuthorityOperationReceipt) => Promise<ResultPreparedFrameV1 | CompoundOperationReceiptV2>;
  readonly acknowledge: (input: Omit<Parameters<ProductionCompoundReceiptComposition["recover"]>[0], "requestId"> & {
    readonly preparedSequence: number;
    readonly preparedReceiptDigest: string;
  }) => Promise<AckCommittedFrameV1>;
  readonly recover: (input: Omit<GetWaiterFrameV1, "type" | "kind">) => Promise<WaiterStateFrameV1>;
}

export function createProductionCompoundReceiptGenerationFence(
  generationFence: AuthorityGenerationFence,
  axes: {
    readonly machineId: string;
    readonly daemonGeneration: number;
    readonly runtimeRegistrationId?: string;
    readonly connectionId?: string;
  }
) {
  return {
    assertCurrent: ({ workspaceId, opId }: { readonly workspaceId: string; readonly opId: string }) =>
      generationFence.assertHeld("before-terminal-journal", { workspaceId, opId }),
    runExclusive: <Result>(
      { workspaceId, opId }: { readonly workspaceId: string; readonly opId: string },
      operation: () => Promise<Result>
    ) => generationFence.runExclusive("before-terminal-journal", { workspaceId, opId }, operation),
    axes
  };
}

export function createProductionCompoundReceiptComposition(input: {
  readonly workspaceId: string;
  readonly viewId: string;
  readonly canonicalRoot: string;
  readonly stateDirectory: string;
  readonly replicaChangeLog?: ReplicaChangeLog;
  readonly remoteReadDown?: Omit<RemoteReadDownSessionOptions, "workspaceId" | "stateRoot">;
  readonly generationFence?: {
    readonly runExclusive: <Result>(
      input: { readonly workspaceId: string; readonly opId: string },
      operation: () => Promise<Result>
    ) => Promise<Result>;
    readonly assertCurrent: (input: { readonly workspaceId: string; readonly opId: string }) => Promise<void>;
    readonly axes: {
      readonly machineId: string;
      readonly daemonGeneration: number;
      readonly runtimeRegistrationId?: string;
      readonly connectionId?: string;
    };
  };
}): ProductionCompoundReceiptComposition {
  mkdirSync(input.stateDirectory, { recursive: true, mode: 0o700 });
  const receipts = createCompoundReceiptServiceV2({
    store: createDurableCompoundReceiptStoreV2({
      directory: path.join(input.stateDirectory, "receipts"),
      ...(input.generationFence ? { generationFence: input.generationFence } : {})
    })
  });
  const brokerStateRoot = path.join(input.stateDirectory, "broker");
  const remoteRuntime = input.remoteReadDown
    ? new RemoteBrokerRuntime({
        workspaceId: input.workspaceId,
        viewId: input.viewId,
        viewRoot: input.canonicalRoot,
        stateRoot: brokerStateRoot,
        session: input.remoteReadDown,
        writerExclusion: processWriterExclusion(),
        watcherFence: processWatcherFence()
      })
    : undefined;
  if (!remoteRuntime && !input.replicaChangeLog) {
    throw new Error("local compound receipt composition requires a replica change log");
  }
  const broker = remoteRuntime?.broker ?? new ReplicaBroker({
      workspaceId: input.workspaceId,
      viewId: input.viewId,
      viewRoot: input.canonicalRoot,
      stateRoot: brokerStateRoot,
      replicaChangeLog: input.replicaChangeLog!,
      snapshotSource: { snapshotAt: (change) => gitSnapshot(input.canonicalRoot, change.workspaceId, change.revision, change.commitSha) },
      writerExclusion: processWriterExclusion(),
      watcherFence: processWatcherFence()
    });
  const coordinator = createBrokerCompoundReceiptCoordinatorV2({
    receipts,
    broker
  });
  return {
    start: async () => {
      if (remoteRuntime) await remoteRuntime.start();
    },
    stop: async () => {
      await remoteRuntime?.stop();
    },
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
    }
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
