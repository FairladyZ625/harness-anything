import type {
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "@harness-anything/application";
import { AuthorityTransportDisconnectedError } from "../transport/persistent-ssh-authority-client.ts";
import { RemoteCanonicalSnapshotSource } from "./remote-canonical-snapshot-source.ts";
import {
  RemoteReadDownSession,
  RemoteReplicaResyncRequiredError,
  type RemoteReadDownSessionOptions
} from "./remote-read-down-session.ts";
import { RemoteReplicaChangeLog } from "./remote-replica-change-log.ts";
import { ReplicaBroker } from "./replica-broker.ts";
import type {
  BrokerDurableState,
  BrokerOptions,
  CanonicalSnapshotSource
} from "./types.ts";

export interface RemoteBrokerRuntimeOptions
  extends Omit<BrokerOptions, "replicaChangeLog" | "snapshotSource" | "replicaGapPolicy"> {
  readonly session: Omit<
    RemoteReadDownSessionOptions,
    "workspaceId" | "stateRoot" | "expectedResume"
  >;
}

export type RemoteBrokerRuntimeHealth =
  | { readonly status: "IDLE" | "STARTING" | "RUNNING" | "STOPPED" }
  | { readonly status: "TERMINAL"; readonly failure: Error };

export class RemoteBrokerRuntime {
  readonly broker: ReplicaBroker;
  private readonly options: RemoteBrokerRuntimeOptions;
  private activeSession: RemoteReadDownSession | undefined;
  private activeReplicaChangeLog: RemoteReplicaChangeLog | undefined;
  private activeSnapshotSource: RemoteCanonicalSnapshotSource | undefined;
  private unsubscribe: (() => void) | undefined;
  private pendingNotification: ReplicaChangeRecord | undefined;
  private notificationTask: Promise<void> | undefined;
  private startTask: Promise<BrokerDurableState> | undefined;
  private stopTask: Promise<void> | undefined;
  private phase: "IDLE" | "STARTING" | "RUNNING" | "TERMINAL" | "STOPPED" = "IDLE";
  private terminalFailure: Error | undefined;
  private stopped = false;

  constructor(options: RemoteBrokerRuntimeOptions) {
    this.options = options;
    const { session: _session, ...brokerOptions } = options;
    const replicaChangeLog: ReplicaChangeLog = {
      append: (record) => this.replicaChangeLog.append(record),
      latest: (workspaceId) => this.replicaChangeLog.latest(workspaceId),
      getByOperation: (workspaceId, opId) => this.replicaChangeLog.getByOperation(workspaceId, opId),
      changesAfter: (workspaceId, revision) => this.replicaChangeLog.changesAfter(workspaceId, revision),
      subscribe: (workspaceId, listener) => this.replicaChangeLog.subscribe(workspaceId, listener)
    };
    const snapshotSource: CanonicalSnapshotSource = {
      snapshotAt: (change) => this.snapshotSource.snapshotAt(change)
    };
    this.broker = new ReplicaBroker({
      ...brokerOptions,
      replicaChangeLog,
      snapshotSource,
      replicaGapPolicy: "TERMINAL"
    });
  }

  get session(): RemoteReadDownSession {
    if (!this.activeSession) throw new Error("remote broker runtime is not started");
    return this.activeSession;
  }

  get replicaChangeLog(): RemoteReplicaChangeLog {
    if (!this.activeReplicaChangeLog) throw new Error("remote broker runtime is not started");
    return this.activeReplicaChangeLog;
  }

  get snapshotSource(): RemoteCanonicalSnapshotSource {
    if (!this.activeSnapshotSource) throw new Error("remote broker runtime is not started");
    return this.activeSnapshotSource;
  }

  health(): RemoteBrokerRuntimeHealth {
    if (this.terminalFailure) return { status: "TERMINAL", failure: this.terminalFailure };
    if (this.phase === "TERMINAL") {
      throw new Error("remote broker runtime terminal state is missing its failure");
    }
    return { status: this.phase };
  }

  start(): Promise<BrokerDurableState> {
    if (this.stopped) return Promise.reject(new Error("remote broker runtime is stopped"));
    if (this.terminalFailure) return Promise.reject(this.terminalFailure);
    if (this.phase === "RUNNING") return Promise.resolve(this.broker.snapshotState());
    if (this.startTask) return this.startTask;
    this.phase = "STARTING";
    const task = this.startRuntime();
    this.startTask = task;
    void task.then(
      () => {
        if (this.startTask === task) this.startTask = undefined;
        if (!this.stopped && !this.terminalFailure) this.phase = "RUNNING";
      },
      () => {
        if (this.startTask === task) this.startTask = undefined;
      }
    );
    return task;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    if (!this.terminalFailure) this.phase = "STOPPED";
    this.unsubscribeNow();
    this.pendingNotification = undefined;
    const closeTask = this.activeSession?.close() ?? Promise.resolve();
    this.stopTask = Promise.allSettled([
      closeTask,
      this.startTask ?? Promise.resolve(),
      this.notificationTask ?? Promise.resolve()
    ]).then((results) => {
      if (this.terminalFailure) throw this.terminalFailure;
      const closeResult = results[0]!;
      if (closeResult.status === "rejected") throw closeResult.reason;
    });
    return this.stopTask;
  }

  close(): Promise<void> {
    return this.stop();
  }

  private async startRuntime(): Promise<BrokerDurableState> {
    const durable = await this.broker.initialize();
    if (this.stopped) throw new Error("remote broker runtime is stopped");
    this.bindRemoteComponents(durable);
    this.unsubscribe = this.replicaChangeLog.subscribe(
      this.session.workspaceId,
      (change) => this.handleNotification(change)
    );
    try {
      return await this.broker.synchronize();
    } catch (error) {
      const failure = remoteBrokerError(error);
      await this.rollbackStart();
      if (!this.stopped && !isRetryableRuntimeError(failure)) {
        this.terminalFailure = failure;
        this.phase = "TERMINAL";
      } else if (!this.stopped) {
        this.phase = "IDLE";
      }
      throw failure;
    }
  }

  private bindRemoteComponents(durable: BrokerDurableState): void {
    const session = new RemoteReadDownSession({
      ...this.options.session,
      workspaceId: this.options.workspaceId,
      stateRoot: this.options.stateRoot,
      expectedResume: {
        epoch: durable.epoch,
        deliveredRevision: durable.receivedCursor
      }
    });
    this.activeSession = session;
    this.activeReplicaChangeLog = new RemoteReplicaChangeLog(session);
    this.activeSnapshotSource = new RemoteCanonicalSnapshotSource(session);
  }

  private async rollbackStart(): Promise<void> {
    this.unsubscribeNow();
    this.pendingNotification = undefined;
    const session = this.activeSession;
    if (session) await session.close();
    if (this.notificationTask) await Promise.allSettled([this.notificationTask]);
    this.activeSession = undefined;
    this.activeReplicaChangeLog = undefined;
    this.activeSnapshotSource = undefined;
  }

  private handleNotification(change: ReplicaChangeRecord): void {
    if (this.stopped || this.terminalFailure) return;
    this.pendingNotification = change;
    if (this.notificationTask) return;
    const task = this.pumpNotifications();
    this.notificationTask = task;
    void task.then(
      () => {
        if (this.notificationTask === task) this.notificationTask = undefined;
        if (this.pendingNotification && !this.stopped && !this.terminalFailure) {
          this.handleNotification(this.pendingNotification);
        }
      },
      () => {
        if (this.notificationTask === task) this.notificationTask = undefined;
      }
    );
  }

  private async pumpNotifications(): Promise<void> {
    while (this.pendingNotification && !this.stopped && !this.terminalFailure) {
      const change = this.pendingNotification;
      this.pendingNotification = undefined;
      try {
        await this.broker.onNotification(change);
      } catch (error) {
        const failure = remoteBrokerError(error);
        if (this.stopped || this.phase === "STARTING") return;
        if (isRetryableRuntimeError(failure)) {
          this.options.session.onDiagnostic?.(
            `remote broker notification synchronization deferred: ${failure.message}`
          );
          return;
        }
        await this.enterTerminal(failure);
        return;
      }
    }
  }

  private async enterTerminal(failure: Error): Promise<void> {
    if (this.terminalFailure) return;
    this.terminalFailure = failure;
    this.phase = "TERMINAL";
    this.unsubscribeNow();
    this.pendingNotification = undefined;
    this.options.session.onDiagnostic?.(
      `remote broker notification synchronization failed terminally: ${failure.message}`
    );
    await this.activeSession?.close();
  }

  private unsubscribeNow(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

function isRetryableRuntimeError(error: Error): boolean {
  return error instanceof RemoteReplicaResyncRequiredError
    || error instanceof AuthorityTransportDisconnectedError;
}

function remoteBrokerError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
