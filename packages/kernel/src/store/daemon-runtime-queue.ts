import { Effect } from "effect";
import { daemonAdmissionBytes, type DaemonAdmissionBudget, type DaemonAdmissionBudgetSnapshot, type DaemonAdmissionReservation } from "../daemon/admission-budget.ts";
import type { DaemonQueueDrainTarget } from "../daemon/drain-timeout.ts";
import type { WriteError } from "../domain/index.ts";
import type { FlushReport, WriteOp } from "../ports/write-coordinator.ts";
import type { WriteAttribution } from "../schemas/actor-attribution.ts";
import type { GitCommitAuthor, OperationalActor } from "./write-journal-types.ts";
import type { makeJournaledWriteCoordinator } from "./write-journal-coordinator.ts";

export type DaemonWritePriority = "interactive" | "normal" | "background" | "maintenance";

export type InteractiveWriteAttribution =
  | { readonly attribution: WriteAttribution; readonly operationalActor?: never }
  | { readonly attribution?: never; readonly operationalActor: OperationalActor };

export type InteractiveWriteRequest = InteractiveWriteAttribution & {
  readonly commandId: string;
  readonly ops: ReadonlyArray<WriteOp>;
  readonly deadlineMs?: number;
  readonly commitAuthor?: GitCommitAuthor;
  readonly sessionId?: string;
};

export interface InteractiveWriteReceipt {
  readonly commandId: string;
  readonly opIds: ReadonlyArray<string>;
  readonly durable: true;
  readonly flush: FlushReport;
}

export interface BackgroundBatchRequest<Result = unknown> {
  readonly source: string;
  readonly priority?: Exclude<DaemonWritePriority, "interactive">;
  readonly run: () => Result | Promise<Result>;
}

export interface DaemonQueueSnapshot {
  readonly interactive: number;
  readonly normal: number;
  readonly background: number;
  readonly maintenance: number;
  readonly running: boolean;
  readonly admission: DaemonAdmissionBudgetSnapshot;
}

export type { DaemonQueueDrainTarget } from "../daemon/drain-timeout.ts";

type InteractiveQueueItem = InteractiveWriteAttribution & {
  readonly kind: "interactive";
  readonly commandId: string;
  readonly ops: ReadonlyArray<WriteOp>;
  readonly commitAuthor?: GitCommitAuthor;
  readonly sessionId?: string;
  readonly integrityDomain: "authority" | "legacy";
  readonly enqueuedAt: number;
  started: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  readonly resolve: (receipt: InteractiveWriteReceipt) => void;
  readonly reject: (error: WriteError) => void;
  readonly admission: DaemonAdmissionReservation;
};

type InteractiveCoordinatorBatch = InteractiveWriteAttribution & {
  readonly commitAuthor?: GitCommitAuthor;
  readonly sessionId?: string;
};

interface BackgroundQueueItem<Result> {
  readonly kind: "background";
  readonly source: string;
  readonly priority: Exclude<DaemonWritePriority, "interactive">;
  readonly run: () => Result | Promise<Result>;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
  readonly admission: DaemonAdmissionReservation;
}

type JournaledWriteCoordinator = ReturnType<typeof makeJournaledWriteCoordinator>;

export class DaemonWriteQueue {
  private readonly interactive: InteractiveQueueItem[] = [];
  private readonly normal: BackgroundQueueItem<unknown>[] = [];
  private readonly background: BackgroundQueueItem<unknown>[] = [];
  private readonly maintenance: BackgroundQueueItem<unknown>[] = [];
  private running = false;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  private coordinatorFor: ((batch: InteractiveCoordinatorBatch) => JournaledWriteCoordinator) | undefined;
  private readonly maxInteractiveOpsPerCommit: number;
  private readonly interactiveMicroBatchMs: number;
  private readonly admissionBudget: DaemonAdmissionBudget;
  private activeDrainTarget: DaemonQueueDrainTarget | undefined;

  constructor(
    maxInteractiveOpsPerCommit: number,
    interactiveMicroBatchMs: number,
    admissionBudget: DaemonAdmissionBudget
  ) {
    this.maxInteractiveOpsPerCommit = maxInteractiveOpsPerCommit;
    this.interactiveMicroBatchMs = interactiveMicroBatchMs;
    this.admissionBudget = admissionBudget;
  }

  enqueueInteractive(
    request: InteractiveWriteRequest,
    coordinatorFor: (batch: InteractiveCoordinatorBatch) => JournaledWriteCoordinator
  ): Promise<InteractiveWriteReceipt> {
    if (this.closed) return Promise.reject({ _tag: "JournalUnavailable", cause: new Error("daemon write queue is closed") } satisfies WriteError);
    const integrityDomain = requestIntegrityDomain(request.ops);
    if (!integrityDomain) {
      return Promise.reject({
        _tag: "WriteRejected",
        reason: "daemon interactive request cannot mix integrity-bearing and legacy operations"
      } satisfies WriteError);
    }
    const admission = this.admissionBudget.reserve({
      plane: "json-rpc",
      operations: request.ops.length,
      bytes: daemonAdmissionBytes(request.ops)
    });
    if (!admission.ok) return Promise.reject(admission.error);
    this.coordinatorFor = coordinatorFor;
    return new Promise((resolve, reject) => {
      const item: InteractiveQueueItem = {
        kind: "interactive",
        commandId: request.commandId,
        ops: request.ops,
        ...(request.attribution ? { attribution: request.attribution } : { operationalActor: request.operationalActor }),
        ...(request.commitAuthor ? { commitAuthor: request.commitAuthor } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        integrityDomain,
        enqueuedAt: Date.now(),
        started: false,
        resolve,
        reject,
        admission: admission.reservation
      };
      if (request.deadlineMs !== undefined) {
        item.timeout = setTimeout(() => {
          if (item.started) return;
          this.removeInteractive(item);
          item.admission.release();
          reject({ _tag: "JournalUnavailable", cause: new Error(`daemon queue wait timeout after ${request.deadlineMs}ms`) } satisfies WriteError);
          this.resolveIdleIfNeeded();
        }, request.deadlineMs);
      }
      this.interactive.push(item);
      this.schedule();
    });
  }

  enqueueBackground<Result>(request: BackgroundBatchRequest<Result>): Promise<Result> {
    if (this.closed) return Promise.reject(new Error("daemon write queue is closed"));
    const admission = this.admissionBudget.reserve({
      plane: "json-rpc",
      operations: 1,
      bytes: Buffer.byteLength(request.source, "utf8")
    });
    if (!admission.ok) return Promise.reject(admission.error);
    return new Promise((resolve, reject) => {
      const item: BackgroundQueueItem<Result> = {
        kind: "background",
        source: request.source,
        priority: request.priority ?? "background",
        run: request.run,
        resolve,
        reject,
        admission: admission.reservation
      };
      this.queueFor(item.priority).push(item as BackgroundQueueItem<unknown>);
      this.schedule();
    });
  }

  close(): void {
    this.closed = true;
  }

  async idle(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  snapshot(): DaemonQueueSnapshot {
    return {
      interactive: this.interactive.length,
      normal: this.normal.length,
      background: this.background.length,
      maintenance: this.maintenance.length,
      running: this.running,
      admission: this.admissionBudget.snapshot()
    };
  }

  drainTargets(): ReadonlyArray<DaemonQueueDrainTarget> {
    return [
      ...(this.activeDrainTarget ? [this.activeDrainTarget] : []),
      ...this.interactive.map((item) => ({
        kind: "interactive" as const,
        commandId: item.commandId,
        opIds: item.ops.map((op) => op.opId)
      })),
      ...[...this.normal, ...this.background, ...this.maintenance].map((item) => ({
        kind: "background" as const,
        source: item.source
      }))
    ];
  }

  private schedule(): void {
    if (this.running) return;
    this.running = true;
    queueMicrotask(() => {
      void this.drain().finally(() => {
        this.running = false;
        this.resolveIdleIfNeeded();
        if (!this.isIdle()) this.schedule();
      });
    });
  }

  private async drain(): Promise<void> {
    while (!this.isIdle()) {
      if (this.interactive.length > 0) {
        if (!this.coordinatorFor) return;
        await this.drainInteractive(this.coordinatorFor);
        continue;
      }
      const backgroundItem = this.normal.shift() ?? this.background.shift() ?? this.maintenance.shift();
      if (!backgroundItem) return;
      await this.runBackground(backgroundItem);
    }
  }

  private async drainInteractive(
    coordinatorFor: (batch: InteractiveCoordinatorBatch) => JournaledWriteCoordinator
  ): Promise<void> {
    if (this.interactiveMicroBatchMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.interactiveMicroBatchMs));
    }
    const batch: InteractiveQueueItem[] = [];
    let opCount = 0;
    while (this.interactive.length > 0 && opCount < this.maxInteractiveOpsPerCommit) {
      const next = this.interactive[0]!;
      if (batch.length > 0 && !sameAttribution(batch[0]!, next)) break;
      const item = this.interactive.shift()!;
      item.started = true;
      if (item.timeout) clearTimeout(item.timeout);
      batch.push(item);
      opCount += item.ops.length;
    }
    const accepted: InteractiveQueueItem[] = [];
    let coordinator: JournaledWriteCoordinator;
    try {
      coordinator = coordinatorFor(attributionFor(batch[0]));
    } catch (error) {
      const writeError = toWriteError(error);
      for (const item of batch) {
        item.reject(writeError);
        item.admission.release();
      }
      return;
    }
    for (const item of batch) {
      try {
        for (const op of item.ops) {
          Effect.runSync(coordinator.enqueue(op));
        }
        accepted.push(item);
      } catch (error) {
        item.reject(toWriteError(error));
        item.admission.release();
      }
    }
    if (accepted.length === 0) return;
    this.activeDrainTarget = {
      kind: "interactive",
      commandId: accepted.map((item) => item.commandId).join(","),
      opIds: accepted.flatMap((item) => item.ops.map((op) => op.opId))
    };
    try {
      const report = Effect.runSync(coordinator.flush("explicit"));
      for (const item of accepted) {
        item.resolve({
          commandId: item.commandId,
          opIds: item.ops.map((op) => op.opId),
          durable: true,
          flush: report
        });
      }
    } catch (error) {
      const writeError = toWriteError(error);
      for (const item of accepted) item.reject(writeError);
    } finally {
      this.activeDrainTarget = undefined;
      for (const item of accepted) item.admission.release();
    }
  }

  private async runBackground(item: BackgroundQueueItem<unknown>): Promise<void> {
    this.activeDrainTarget = { kind: "background", source: item.source };
    try {
      item.resolve(await item.run());
    } catch (error) {
      item.reject(error);
    } finally {
      this.activeDrainTarget = undefined;
      item.admission.release();
    }
  }

  private queueFor(priority: Exclude<DaemonWritePriority, "interactive">): BackgroundQueueItem<unknown>[] {
    if (priority === "normal") return this.normal;
    if (priority === "maintenance") return this.maintenance;
    return this.background;
  }

  private removeInteractive(item: InteractiveQueueItem): void {
    const index = this.interactive.indexOf(item);
    if (index >= 0) this.interactive.splice(index, 1);
  }

  private isIdle(): boolean {
    return this.interactive.length === 0
      && this.normal.length === 0
      && this.background.length === 0
      && this.maintenance.length === 0
      && !this.running;
  }

  private resolveIdleIfNeeded(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const resolve of waiters) resolve();
  }
}

function attributionFor(item: InteractiveQueueItem | undefined): InteractiveCoordinatorBatch {
  if (!item) throw new Error("interactive write batch requires attribution");
  return {
    ...(item.attribution ? { attribution: item.attribution } : { operationalActor: item.operationalActor }),
    ...(item?.commitAuthor ? { commitAuthor: item.commitAuthor } : {}),
    ...(item?.sessionId ? { sessionId: item.sessionId } : {})
  };
}

function sameAttribution(left: InteractiveQueueItem, right: InteractiveQueueItem): boolean {
  return attributionKey(left) === attributionKey(right)
    && authorKey(left.commitAuthor) === authorKey(right.commitAuthor)
    && sessionKey(left.sessionId) === sessionKey(right.sessionId)
    && left.integrityDomain === right.integrityDomain;
}

function requestIntegrityDomain(ops: ReadonlyArray<WriteOp>): "authority" | "legacy" | undefined {
  const authorityCount = ops.filter((op) => op.authorityIntegrity !== undefined).length;
  if (authorityCount === 0) return "legacy";
  return authorityCount === ops.length ? "authority" : undefined;
}

function attributionKey(input: InteractiveWriteAttribution): string {
  if (input.operationalActor) {
    return `operational\0${input.operationalActor.kind}\0${input.operationalActor.id}`;
  }
  const attribution = input.attribution;
  const source = attribution.principalSource;
  const principalSourceKey = source.kind === "daemon-authenticated"
    ? `${source.kind}\0${source.providerId}\0${source.credentialFingerprint}`
    : source.kind === "local-configured"
      ? `${source.kind}\0${source.authority}\0${source.authoritySha256}`
      : `${source.kind}\0${source.evidenceRef}`;
  return [
    attribution.actor.principal.personId,
    attribution.actor.executor?.id ?? "",
    principalSourceKey,
    attribution.executorSource
  ].join("\0");
}

function authorKey(author: GitCommitAuthor | undefined): string {
  return author ? `${author.name}\0${author.email}` : "";
}

function sessionKey(sessionId: string | undefined): string {
  return sessionId?.trim() ?? "";
}

function toWriteError(error: unknown): WriteError {
  if (isWriteError(error)) return error;
  return { _tag: "JournalUnavailable", cause: error };
}

function isWriteError(error: unknown): error is WriteError {
  return typeof error === "object"
    && error !== null
    && "_tag" in error
    && (
      error._tag === "WriteRejected"
      || error._tag === "WriteConflict"
      || error._tag === "GlobalWriteConflict"
      || error._tag === "JournalUnavailable"
    );
}
