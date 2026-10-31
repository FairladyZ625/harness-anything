/** @daemon-transport-authority The daemon's writer-epoch lifecycle: leases, fences, and binding decoration. */
import path from "node:path";
import { readDaemonRegistry } from "@harness-anything/kernel";
import { localSystemBinding, withDaemonWriterEpochFence } from "./daemon-host-binding.ts";
import {
  openPersistentWriterEpoch,
  readLedgerWriterEpoch,
  type PersistentWriterEpoch,
  type WriterEpochFenceDescriptor,
  type WriterEpochLease,
} from "@harness-anything/storage";

export interface DaemonWriterEpochs {
  readonly writerEpochLease: (repoId: string, rootDir?: string) => WriterEpochLease;
  readonly writerEpochFence: (repoId: string, rootDir?: string) => WriterEpochFenceDescriptor;
  readonly writerEpochHighWatermark: (repoId: string) => number;
  readonly retireWriterEpoch: (repoId: string) => void;
  readonly closeDaemonWriterEpoch: () => void;
  readonly daemonWriterBinding: (
    repoId: string,
    base: ReturnType<typeof localSystemBinding>,
  ) => ReturnType<typeof localSystemBinding>;
}

export function openDaemonWriterEpochs(input: {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly now: () => string;
}): DaemonWriterEpochs {
  const stateRoot = path.join(input.userRoot, "fleet");
  let daemonWriterEpoch: PersistentWriterEpoch | null = null;
  const daemonWriterLeases = new Map<string, WriterEpochLease>(),
    epoch = (): PersistentWriterEpoch =>
      (daemonWriterEpoch ??= openPersistentWriterEpoch({
        stateRoot,
        holderId: `local-daemon:${input.daemonId}:${process.pid}`,
        now: input.now,
      })),
    writerEpochLease = (repoId: string, rootDir?: string): WriterEpochLease => {
      epoch();
      const existing = daemonWriterLeases.get(repoId);
      if (existing) return existing;
      const repo = readDaemonRegistry({ userRoot: input.userRoot }).repos.find((entry) => entry.repoId === repoId);
      // The lease database allocates epochs above the accepting ledger's enforced fence floor. Init
      // takes its lease before the registry row exists, so the caller passes the root it will write.
      // An edge's local ledger is a center-owned mirror; it cannot establish that edge's epoch floor.
      const observedLedgerEpoch =
        repo?.mode === "remote-edge" ? 0 : readLedgerWriterEpoch(repoId, repo?.canonicalRoot ?? rootDir);
      const lease = epoch().acquire(repoId, observedLedgerEpoch);
      daemonWriterLeases.set(repoId, lease);
      return lease;
    },
    writerEpochFence = (repoId: string, rootDir?: string): WriterEpochFenceDescriptor => {
      const lease = writerEpochLease(repoId, rootDir);
      return {
        schema: "harness-writer-epoch-fence/v1" as const,
        stateRoot,
        repoId,
        epoch: lease.epoch,
        holderId: lease.holderId,
      };
    },
    writerEpochHighWatermark = (repoId: string): number => epoch().highWatermark(repoId),
    retireWriterEpoch = (repoId: string): void => {
      epoch().retireCurrent(repoId);
      daemonWriterLeases.delete(repoId);
    },
    closeDaemonWriterEpoch = (): void => {
      daemonWriterEpoch?.close();
      daemonWriterEpoch = null;
      daemonWriterLeases.clear();
    },
    daemonWriterBinding = (
      repoId: string,
      base: ReturnType<typeof localSystemBinding>,
    ): ReturnType<typeof localSystemBinding> => {
      if (base.writerEpochFence) return base;
      return withDaemonWriterEpochFence(base, writerEpochFence(repoId));
    };
  return {
    writerEpochLease,
    writerEpochFence,
    writerEpochHighWatermark,
    retireWriterEpoch,
    closeDaemonWriterEpoch,
    daemonWriterBinding,
  };
}
