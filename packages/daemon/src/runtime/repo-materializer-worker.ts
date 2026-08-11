import { Worker } from "node:worker_threads";
import type {
  AttributionProjectionDecisionReason,
  IncrementalProjectionDiagnostic,
  IncrementalProjectionPhase,
  IncrementalProjectionRebuildReason,
  IncrementalTaskProjectionMode,
  HarnessLayoutInput,
  LedgerMaterializerProgressStep,
  LedgerMaterializerReport,
  TrustedProjectionFingerprintDiagnostic
} from "@harness-anything/kernel";

interface WorkerMaterializerOptions {
  readonly dryRun?: boolean;
  readonly maxBranches?: number;
  readonly sessionId?: string;
  readonly heldGlobalLock?: {
    readonly path: string;
    readonly ownerToken: string;
    readonly ownerKind?: "daemon";
  };
}

interface MaterializerWorkerCallbacks {
  readonly onProgress?: (step: LedgerMaterializerProgressStep) => void;
  readonly onProjectionPhase?: (phase: IncrementalProjectionPhase) => void;
  readonly onProjectionMode?: (mode: IncrementalTaskProjectionMode, reason?: IncrementalProjectionRebuildReason) => void;
  readonly onProjectionAttributionDecision?: (reason: AttributionProjectionDecisionReason) => void;
  readonly onProjectionDiagnostic?: (
    diagnostic: TrustedProjectionFingerprintDiagnostic | IncrementalProjectionDiagnostic
  ) => void;
}

interface PendingMaterializerJob {
  readonly jobId: number;
  readonly rootInput: HarnessLayoutInput;
  readonly options: WorkerMaterializerOptions;
  readonly priority: "foreground" | "recovery";
  readonly resolve: (report: LedgerMaterializerReport) => void;
  readonly reject: (error: Error) => void;
  readonly callbacks: MaterializerWorkerCallbacks;
}

type MaterializerWorkerMessage =
  | { readonly kind: "progress"; readonly jobId: number; readonly value: LedgerMaterializerProgressStep }
  | { readonly kind: "projection-phase"; readonly jobId: number; readonly value: IncrementalProjectionPhase }
  | { readonly kind: "projection-mode"; readonly jobId: number; readonly mode: IncrementalTaskProjectionMode; readonly reason?: IncrementalProjectionRebuildReason }
  | { readonly kind: "attribution-decision"; readonly jobId: number; readonly value: AttributionProjectionDecisionReason }
  | { readonly kind: "projection-diagnostic"; readonly jobId: number; readonly value: TrustedProjectionFingerprintDiagnostic | IncrementalProjectionDiagnostic }
  | { readonly kind: "complete"; readonly jobId: number; readonly report: LedgerMaterializerReport }
  | { readonly kind: "failed"; readonly jobId: number; readonly error: { readonly name: string; readonly message: string; readonly stack?: string } };

export interface RepoMaterializerWorkerPort {
  readonly postMessage: (value: unknown) => void;
  readonly terminate: () => Promise<unknown>;
  readonly on: (
    event: "message" | "error" | "exit",
    listener: (value: unknown) => void
  ) => unknown;
}

export class RepoMaterializerWorker {
  private readonly createWorker: () => RepoMaterializerWorkerPort;
  private worker: RepoMaterializerWorkerPort | undefined;
  private readonly pending = new Map<number, PendingMaterializerJob>();
  private readonly queued: number[] = [];
  private activeJobId: number | undefined;
  private nextJobId = 1;
  private stopping = false;

  constructor(createWorker?: () => RepoMaterializerWorkerPort) {
    this.createWorker = createWorker ?? (() => {
      const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
      return new Worker(new URL(`./repo-materializer-worker-thread${extension}`, import.meta.url));
    });
  }

  run(
    rootInput: HarnessLayoutInput,
    options: WorkerMaterializerOptions,
    callbacks: MaterializerWorkerCallbacks = {},
    priority: "foreground" | "recovery" = "foreground"
  ): Promise<LedgerMaterializerReport> {
    this.stopping = false;
    const jobId = this.nextJobId++;
    return new Promise((resolve, reject) => {
      this.pending.set(jobId, { jobId, rootInput, options, priority, resolve, reject, callbacks });
      this.queued.push(jobId);
      this.dispatchNext();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    for (const pending of this.pending.values()) pending.reject(new Error("REPO_MATERIALIZER_WORKER_STOPPED"));
    this.pending.clear();
    this.queued.length = 0;
    this.activeJobId = undefined;
    await worker.terminate();
  }

  private dispatchNext(): void {
    if (this.stopping || this.activeJobId !== undefined || this.queued.length === 0) return;
    const foregroundIndex = this.queued.findIndex((jobId) =>
      this.pending.get(jobId)?.priority === "foreground"
    );
    const queueIndex = foregroundIndex >= 0 ? foregroundIndex : 0;
    const [jobId] = this.queued.splice(queueIndex, 1);
    const job = jobId === undefined ? undefined : this.pending.get(jobId);
    if (!job) {
      this.dispatchNext();
      return;
    }
    this.activeJobId = job.jobId;
    const heldGlobalLock = job.options.heldGlobalLock;
    this.ensureWorker().postMessage({
      kind: "run",
      jobId: job.jobId,
      rootInput: job.rootInput,
      options: {
        ...job.options,
        ...(heldGlobalLock ? {
          heldGlobalLock: {
            path: heldGlobalLock.path,
            ownerToken: heldGlobalLock.ownerToken,
            ...(heldGlobalLock.ownerKind ? { ownerKind: heldGlobalLock.ownerKind } : {})
          }
        } : {})
      }
    });
  }

  private ensureWorker(): RepoMaterializerWorkerPort {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.on("message", (message) => this.onMessage(message as MaterializerWorkerMessage));
    worker.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (value) => {
      const code = Number(value);
      if (this.worker === worker) this.worker = undefined;
      if (!this.stopping && code !== 0) this.fail(new Error(`REPO_MATERIALIZER_WORKER_EXITED:${code}`));
    });
    this.worker = worker;
    return worker;
  }

  private onMessage(message: MaterializerWorkerMessage): void {
    const pending = this.pending.get(message.jobId);
    if (!pending) return;
    const callbacks = pending.callbacks;
    if (message.kind === "progress") callbacks.onProgress?.(message.value);
    else if (message.kind === "projection-phase") callbacks.onProjectionPhase?.(message.value);
    else if (message.kind === "projection-mode") callbacks.onProjectionMode?.(message.mode, message.reason);
    else if (message.kind === "attribution-decision") callbacks.onProjectionAttributionDecision?.(message.value);
    else if (message.kind === "projection-diagnostic") callbacks.onProjectionDiagnostic?.(message.value);
    else if (message.kind === "complete") {
      this.pending.delete(message.jobId);
      if (this.activeJobId === message.jobId) this.activeJobId = undefined;
      pending.resolve(message.report);
      this.dispatchNext();
    } else {
      this.pending.delete(message.jobId);
      if (this.activeJobId === message.jobId) this.activeJobId = undefined;
      const error = new Error(message.error.message);
      error.name = message.error.name;
      if (message.error.stack) error.stack = message.error.stack;
      pending.reject(error);
      this.dispatchNext();
    }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.queued.length = 0;
    this.activeJobId = undefined;
  }
}
