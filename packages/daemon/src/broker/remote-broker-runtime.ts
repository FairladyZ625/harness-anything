import type { ReplicaChangeRecord } from "@harness-anything/application";
import { RemoteCanonicalSnapshotSource } from "./remote-canonical-snapshot-source.ts";
import {
  RemoteReadDownSession,
  type RemoteReadDownSessionOptions
} from "./remote-read-down-session.ts";
import { RemoteReplicaChangeLog } from "./remote-replica-change-log.ts";
import { ReplicaBroker } from "./replica-broker.ts";
import type { BrokerDurableState, BrokerOptions } from "./types.ts";

export interface RemoteBrokerRuntimeOptions
  extends Omit<BrokerOptions, "replicaChangeLog" | "snapshotSource"> {
  readonly session: Omit<RemoteReadDownSessionOptions, "workspaceId" | "stateRoot">;
}

export class RemoteBrokerRuntime {
  readonly session: RemoteReadDownSession;
  readonly replicaChangeLog: RemoteReplicaChangeLog;
  readonly snapshotSource: RemoteCanonicalSnapshotSource;
  readonly broker: ReplicaBroker;
  private readonly onDiagnostic: ((text: string) => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private synchronizationTail: Promise<void> = Promise.resolve();
  private startTask: Promise<BrokerDurableState> | undefined;
  private stopTask: Promise<void> | undefined;
  private stopped = false;

  constructor(options: RemoteBrokerRuntimeOptions) {
    const { session, ...brokerOptions } = options;
    this.onDiagnostic = session.onDiagnostic;
    this.session = new RemoteReadDownSession({
      ...session,
      workspaceId: options.workspaceId,
      stateRoot: options.stateRoot
    });
    this.replicaChangeLog = new RemoteReplicaChangeLog(this.session);
    this.snapshotSource = new RemoteCanonicalSnapshotSource(this.session);
    this.broker = new ReplicaBroker({
      ...brokerOptions,
      replicaChangeLog: this.replicaChangeLog,
      snapshotSource: this.snapshotSource
    });
  }

  start(): Promise<BrokerDurableState> {
    if (this.stopped) return Promise.reject(new Error("remote broker runtime is stopped"));
    if (!this.startTask) this.startTask = this.startRuntime();
    return this.startTask;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const closeTask = this.session.close();
    this.stopTask = Promise.allSettled([
      closeTask,
      this.startTask ?? Promise.resolve(),
      this.synchronizationTail
    ]).then((results) => {
      const closeResult = results[0]!;
      if (closeResult.status === "rejected") throw closeResult.reason;
    });
    return this.stopTask;
  }

  close(): Promise<void> {
    return this.stop();
  }

  private async startRuntime(): Promise<BrokerDurableState> {
    await this.broker.initialize();
    if (this.stopped) throw new Error("remote broker runtime is stopped");
    this.unsubscribe = this.replicaChangeLog.subscribe(
      this.session.workspaceId,
      (change) => this.handleNotification(change)
    );
    return this.queueSynchronization();
  }

  private handleNotification(change: ReplicaChangeRecord): void {
    void this.queueSynchronization(change).catch((error) => {
      if (!this.stopped) {
        this.onDiagnostic?.(`remote broker notification synchronization failed: ${remoteBrokerError(error).message}`);
      }
    });
  }

  private queueSynchronization(change?: ReplicaChangeRecord): Promise<BrokerDurableState> {
    const synchronization = this.synchronizationTail.then(() => {
      if (this.stopped) throw new Error("remote broker runtime is stopped");
      return change ? this.broker.onNotification(change) : this.broker.synchronize();
    });
    this.synchronizationTail = synchronization.then(
      () => undefined,
      () => undefined
    );
    return synchronization;
  }
}

function remoteBrokerError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
