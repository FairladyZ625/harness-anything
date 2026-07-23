import type {
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "@harness-anything/application";
import { RemoteCanonicalSnapshotSource } from "./remote-canonical-snapshot-source.ts";
import {
  deriveRemoteBrokerRuntimeHealth,
  type RemoteBrokerRuntimeHealth,
  type RemoteBrokerRuntimeLifecycle
} from "./remote-broker-runtime-health.ts";
import {
  RemoteReadDownSession,
  type RemoteReadDownSessionOptions
} from "./remote-read-down-session.ts";
import {
  asRemoteReadDownError,
  classifyRemoteReadDownFailure
} from "./remote-read-down-failure.ts";
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
    "workspaceId" | "stateRoot" | "expectedResume" | "onTerminal"
  >;
}

export { type RemoteBrokerRuntimeHealth } from "./remote-broker-runtime-health.ts";

export class RemoteBrokerRuntime {
  readonly broker: ReplicaBroker;
  private readonly options: RemoteBrokerRuntimeOptions;
  private activeSession: RemoteReadDownSession | undefined;
  private activeReplicaChangeLog: RemoteReplicaChangeLog | undefined;
  private activeSnapshotSource: RemoteCanonicalSnapshotSource | undefined;
  private unsubscribe: (() => void) | undefined;
  private pendingNotification: ReplicaChangeRecord | undefined;
  private notificationTask: Promise<void> | undefined;
  private retryTask: Promise<void> | undefined;
  private terminalTask: Promise<void> | undefined;
  private startTask: Promise<BrokerDurableState> | undefined;
  private stopTask: Promise<void> | undefined;
  private lifecycle: RemoteBrokerRuntimeLifecycle = "IDLE";
  private terminalFailure: Error | undefined;
  private initialized = false;
  private stopped = false;
  private readonly stoppedSignal: Promise<void>;
  private resolveStopped!: () => void;

  constructor(options: RemoteBrokerRuntimeOptions) {
    this.options = options;
    this.stoppedSignal = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
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
    return deriveRemoteBrokerRuntimeHealth({
      lifecycle: this.lifecycle,
      durable: this.initialized ? this.broker.snapshotState() : undefined,
      session: this.activeSession?.health(),
      hasPendingWork: Boolean(this.notificationTask || this.retryTask),
      failure: this.terminalFailure
    });
  }

  start(): Promise<BrokerDurableState> {
    if (this.stopped) return Promise.reject(new Error("remote broker runtime is stopped"));
    const health = this.health();
    if (health.status === "TERMINAL") return Promise.reject(health.failure);
    if (this.lifecycle === "ACTIVE") return Promise.resolve(this.broker.snapshotState());
    if (this.startTask) return this.startTask;
    this.lifecycle = "STARTING";
    const task = this.startRuntime();
    this.startTask = task;
    void task.then(
      () => {
        if (this.startTask === task) this.startTask = undefined;
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
    this.lifecycle = "STOPPED";
    this.resolveStopped();
    this.unsubscribeNow();
    this.pendingNotification = undefined;
    const closeTask = this.activeSession?.close() ?? Promise.resolve();
    this.stopTask = Promise.allSettled([
      closeTask,
      this.startTask ?? Promise.resolve(),
      this.notificationTask ?? Promise.resolve(),
      this.retryTask ?? Promise.resolve(),
      this.terminalTask ?? Promise.resolve()
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
    try {
      const durable = await this.broker.initialize();
      this.initialized = true;
      if (this.stopped) throw new Error("remote broker runtime is stopped");
      this.bindRemoteComponents(durable);
      this.unsubscribe = this.replicaChangeLog.subscribe(
        this.session.workspaceId,
        (change) => this.handleNotification(change)
      );
      const state = await this.broker.synchronize();
      this.lifecycle = "ACTIVE";
      if (this.pendingNotification) this.handleNotification(this.pendingNotification);
      return state;
    } catch (error) {
      const failure = this.terminalFailure ?? asRemoteReadDownError(error);
      await this.rollbackStart();
      if (!this.stopped && classifyRemoteReadDownFailure(failure) !== "TERMINAL") {
        this.lifecycle = "IDLE";
      } else if (!this.stopped) {
        this.latchTerminal(failure);
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
      },
      onTerminal: (failure) => this.latchTerminal(failure)
    });
    this.activeSession = session;
    this.activeReplicaChangeLog = new RemoteReplicaChangeLog(session);
    this.activeSnapshotSource = new RemoteCanonicalSnapshotSource(session);
  }

  private async rollbackStart(): Promise<void> {
    this.unsubscribeNow();
    this.pendingNotification = undefined;
    const session = this.activeSession;
    const pending = [
      ...(session ? [session.close()] : []),
      ...(this.notificationTask ? [this.notificationTask] : []),
      ...(this.retryTask ? [this.retryTask] : [])
    ];
    await Promise.allSettled(pending);
    this.activeSession = undefined;
    this.activeReplicaChangeLog = undefined;
    this.activeSnapshotSource = undefined;
  }

  private handleNotification(change: ReplicaChangeRecord): void {
    if (this.stopped || this.terminalFailure) return;
    this.pendingNotification = change;
    if (this.lifecycle !== "ACTIVE" || this.notificationTask) return;
    const task = this.pumpNotifications();
    this.notificationTask = task;
    void task.then(
      () => this.finishNotificationTask(task),
      (error) => {
        this.finishNotificationTask(task);
        if (!this.stopped) this.latchTerminal(asRemoteReadDownError(error));
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
        if (this.stopped) return;
        const failure = asRemoteReadDownError(error);
        if (classifyRemoteReadDownFailure(failure) !== "TERMINAL") {
          this.scheduleRetry();
          return;
        }
        this.latchTerminal(failure);
        return;
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTask || this.stopped || this.terminalFailure) return;
    const task = this.retrySynchronization();
    this.retryTask = task;
    void task.then(
      () => {
        if (this.retryTask === task) this.retryTask = undefined;
      },
      (error) => {
        if (this.retryTask === task) this.retryTask = undefined;
        if (!this.stopped) this.latchTerminal(asRemoteReadDownError(error));
      }
    );
  }

  private async retrySynchronization(): Promise<void> {
    const backoff = {
      initialMs: this.options.session.backoff?.initialMs ?? 100,
      maximumMs: this.options.session.backoff?.maximumMs ?? 5_000,
      multiplier: this.options.session.backoff?.multiplier ?? 2
    };
    let delay = backoff.initialMs;
    while (!this.stopped && !this.terminalFailure && this.lifecycle === "ACTIVE") {
      await this.retryWait(delay);
      if (this.stopped) return;
      try {
        await this.session.refresh();
        const state = await this.broker.synchronize();
        if (state.mode === "READY") return;
      } catch (error) {
        const failure = asRemoteReadDownError(error);
        if (classifyRemoteReadDownFailure(failure) === "TERMINAL") {
          this.latchTerminal(failure);
          return;
        }
        this.options.session.onDiagnostic?.(
          `remote broker synchronization retry deferred: ${failure.message}`
        );
      }
      delay = Math.min(
        backoff.maximumMs,
        Math.max(delay + 1, Math.ceil(delay * backoff.multiplier))
      );
    }
  }

  private async retryWait(milliseconds: number): Promise<void> {
    const sleep = this.options.session.sleep
      ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
    await Promise.race([sleep(milliseconds), this.stoppedSignal]);
  }

  private latchTerminal(failure: Error): void {
    if (this.terminalFailure) return;
    this.terminalFailure = failure;
    this.unsubscribeNow();
    this.pendingNotification = undefined;
    this.options.session.onDiagnostic?.(
      `remote broker synchronization failed terminally: ${failure.message}`
    );
    const task = this.activeSession?.close() ?? Promise.resolve();
    this.terminalTask = task.catch((error) => {
      this.options.session.onDiagnostic?.(
        `remote broker terminal close failed: ${asRemoteReadDownError(error).message}`
      );
    });
  }

  private unsubscribeNow(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private finishNotificationTask(task: Promise<void>): void {
    if (this.notificationTask === task) this.notificationTask = undefined;
    if (this.pendingNotification && !this.stopped && !this.terminalFailure) {
      this.handleNotification(this.pendingNotification);
    }
  }
}
