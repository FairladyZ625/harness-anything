import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { consumeKnownError } from "../../kernel/src/index.ts";
import type { RepoCellOpenInput } from "./repo-cell-open.ts";
import type { RepoCellAttachProgress, RepoCellBinding, RepoCellStatus } from "./repo-cell-types.ts";
import {
  REPO_WRITER_PROTOCOL_VERSION,
  deserializeWriterError,
  serializableRepoCellBinding,
  serializeWriterError,
  type RepoWriterBootstrapV1,
  type RepoWriterCancelV1,
  type RepoWriterCapabilityCallV1,
  type RepoWriterCapabilityResultV1,
  type RepoWriterControlV1,
  type RepoWriterReceiptV1,
  type RepoWriterRequestV1,
  type RepoWriterStatusV1,
  type RuntimeProcessEventV1,
} from "./repo-writer-protocol.ts";
import { launchNative } from "./runtime-spawn-process.ts";
import type { RuntimeProcess } from "./runtime-spawn.ts";

export interface WriterSupervisor {
  readonly request: <T>(
    method: RepoWriterRequestV1["method"],
    payload: unknown,
    binding?: RepoCellBinding,
    signal?: AbortSignal,
  ) => Promise<T>;
  readonly control: (command: RepoWriterControlV1["command"]) => Promise<void>;
  readonly status: () => RepoCellStatus;
  readonly bootstrapReceipt: () => unknown;
  readonly close: () => Promise<void>;
}

export async function openWriterSupervisor(
  input: RepoCellOpenInput,
  options: {
    readonly createWorker?: (
      url: URL,
      workerOptions: { readonly execArgv: readonly string[]; readonly workerData: RepoWriterBootstrapV1 },
    ) => Worker;
    readonly onAttachStatus?: (status: RepoCellStatus) => void;
  } = {},
): Promise<WriterSupervisor> {
  let worker: Worker | null = null,
    closed = false,
    opened = false,
    restartAttempt = 0,
    statusObservedAt = Date.now(),
    status: RepoCellStatus = {
      repoId: input.repoId,
      rootDir: input.rootDir,
      mode: input.mode ?? "local",
      state: "warming",
      generation: null,
      queueDepth: 0,
      lastError: null,
      causeClass: null,
      recoveryMs: null,
      materialization: null,
      attach: {
        phase: "opening",
        applied: null,
        total: null,
        watermark: null,
      },
    },
    publishedBootstrapReceipt: unknown,
    ready: Promise<void>;
  const pending = new Map<
      string,
      {
        readonly resolve: (value: unknown) => void;
        readonly reject: (error: Error) => void;
        readonly cleanup: () => void;
      }
    >(),
    runtimeProcesses = new Map<string, RuntimeProcess>();

  ready = startWriterWorker();
  await ready;
  opened = true;

  return {
    request: async <T>(
      method: RepoWriterRequestV1["method"],
      payload: unknown,
      binding?: RepoCellBinding,
      signal?: AbortSignal,
    ) => {
      await ready;
      if (closed || !worker) throw new Error("RepoWriterCell is closed");
      if (signal?.aborted) throw abortError(signal);
      const requestId = randomUUID(),
        serializedBinding = binding ? serializableRepoCellBinding(binding) : undefined,
        request: RepoWriterRequestV1 = {
          schema: "harness-repo-writer-request/v1",
          protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
          requestId,
          method,
          payload,
          ...(serializedBinding ? { binding: serializedBinding } : {}),
          writerEpoch: serializedBinding?.writerEpochFence ?? null,
        };
      status = { ...status, queueDepth: (status.queueDepth ?? 0) + 1 };
      return new Promise<T>((resolve, reject) => {
        const cancel = () => {
            const active = worker;
            if (!active) return;
            active.postMessage({
              schema: "harness-repo-writer-cancel/v1",
              protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
              requestId,
            } satisfies RepoWriterCancelV1);
          },
          cleanup = () => signal?.removeEventListener("abort", cancel);
        signal?.addEventListener("abort", cancel, { once: true });
        pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, cleanup });
        try {
          worker!.postMessage(request);
          if (signal?.aborted) cancel();
        } catch (error) {
          consumeKnownError(error);
          pending.delete(requestId);
          cleanup();
          status = { ...status, queueDepth: Math.max(0, (status.queueDepth ?? 1) - 1) };
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    control: sendControl,
    status: () => statusWithCurrentRetryElapsed(status, statusObservedAt),
    bootstrapReceipt: () => publishedBootstrapReceipt,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        if (worker) {
          await sendControl("drain", true);
        }
      } finally {
        const active = worker;
        worker = null;
        if (active) await active.terminate();
        for (const operation of pending.values()) {
          operation.cleanup();
          operation.reject(new Error("RepoWriterCell closed"));
        }
        pending.clear();
        status = { ...status, state: "closed", queueDepth: 0 };
      }
    },
  };

  function startWriterWorker(): Promise<void> {
    if (closed) return Promise.reject(new Error("WriterSupervisor is closed"));
    return new Promise((resolve, reject) => {
      const workerOptions = {
        execArgv: process.execArgv.filter(
          (argument) => argument === "--experimental-strip-types" || argument === "--enable-source-maps",
        ),
        workerData: bootstrapMessage(input),
      };
      const candidate =
        options.createWorker?.(writerWorkerUrl(), workerOptions) ?? new Worker(writerWorkerUrl(), workerOptions);
      let settled = false,
        lastAttachProgress: RepoCellAttachProgress | null = null;
      let readyWatchdog: ReturnType<typeof setTimeout>;
      const readyInactive = () => {
        if (settled) return;
        settled = true;
        const error = new Error("RepoWriterCell did not publish ready after 30000ms without progress");
        if (!opened) closed = true;
        reject(error);
        failActive(error);
        void candidate.terminate();
      };
      const armReadyWatchdog = () => {
        clearTimeout(readyWatchdog);
        readyWatchdog = setTimeout(readyInactive, 30_000);
        readyWatchdog.unref?.();
      };
      armReadyWatchdog();
      worker = candidate;
      candidate.on("message", (message: unknown) => {
        if (isReceipt(message)) {
          const operation = pending.get(message.requestId);
          if (!operation) return;
          pending.delete(message.requestId);
          operation.cleanup();
          status = { ...status, queueDepth: Math.max(0, (status.queueDepth ?? 1) - 1) };
          if (message.outcome === "ok") operation.resolve(message.value);
          else operation.reject(deserializeWriterError(message.error!));
          return;
        }
        if (isStatus(message)) {
          const published = message.status;
          if (published && typeof published === "object") {
            const attaching = published.state === "warming";
            if (!settled || !attaching) {
              status = published;
              statusObservedAt = Date.now();
            }
            if (!settled && attaching) options.onAttachStatus?.(published);
            if (
              !settled &&
              attaching &&
              message.kind === "attach-progress" &&
              published.attach !== undefined &&
              attachProgressAdvanced(lastAttachProgress, published.attach)
            ) {
              lastAttachProgress = published.attach;
              armReadyWatchdog();
            }
          }
          if (message.bootstrapReceipt !== undefined) {
            publishedBootstrapReceipt = message.bootstrapReceipt;
            input.onBootstrap?.(message.bootstrapReceipt as never);
          }
          if (message.kind === "ready") {
            restartAttempt = 0;
            settled = true;
            clearTimeout(readyWatchdog);
            resolve();
          } else if (message.kind === "closed" && message.error && !settled) {
            settled = true;
            clearTimeout(readyWatchdog);
            if (!opened) closed = true;
            reject(deserializeWriterError(message.error));
            void candidate.terminate();
          }
          return;
        }
        if (isCapabilityCall(message)) void handleCapability(candidate, message);
      });
      candidate.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(readyWatchdog);
          if (!opened) closed = true;
          reject(error);
        }
        failActive(error);
      });
      candidate.once("exit", (code) => {
        clearTimeout(readyWatchdog);
        if (worker === candidate) worker = null;
        const error = new Error(`RepoWriterCell exited with code ${code}`);
        if (!settled) {
          settled = true;
          if (!opened) closed = true;
          reject(error);
        }
        failActive(error);
        if (!closed) {
          status = {
            ...status,
            state: "unavailable",
            queueDepth: 0,
            lastError: error.message,
            causeClass: "infrastructure",
          };
          const delay = Math.min(1_000, 25 * 2 ** restartAttempt++);
          ready = new Promise((restartResolve, restartReject) => {
            const timer = setTimeout(() => {
              if (closed) restartResolve();
              else startWriterWorker().then(restartResolve, restartReject);
            }, delay);
            timer.unref?.();
          });
        }
      });
    });
  }

  async function sendControl(command: RepoWriterControlV1["command"], allowClosed = false): Promise<void> {
    await ready;
    if ((!allowClosed && closed) || !worker) throw new Error("RepoWriterCell is unavailable");
    const requestId = randomUUID(),
      control: RepoWriterControlV1 = {
        schema: "harness-repo-writer-control/v1",
        protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
        requestId,
        command,
      };
    return new Promise<void>((resolve, reject) => {
      pending.set(requestId, { resolve: () => resolve(), reject, cleanup: () => undefined });
      worker!.postMessage(control);
    });
  }

  function failActive(error: Error): void {
    for (const operation of pending.values()) {
      operation.cleanup();
      operation.reject(error);
    }
    pending.clear();
  }

  async function handleCapability(active: Worker, call: RepoWriterCapabilityCallV1): Promise<void> {
    try {
      const value = await capabilityValue(call);
      respondCapability(active, call, { outcome: "ok", value });
    } catch (error) {
      consumeKnownError(error);
      respondCapability(active, call, { outcome: "error", error: serializeWriterError(error) });
    }
  }

  async function capabilityValue(call: RepoWriterCapabilityCallV1): Promise<unknown> {
    switch (call.capability) {
      case "now":
        return input.now!();
      case "killpoint":
        return input.killpoint!(call.payload as never);
      case "shouldStop":
        return input.shouldStop!();
      case "runtimeInstances":
        return input.runtimeInstances!();
      case "fleetRoster":
        return input.fleetRoster!();
      case "prepareRuntimeLaunch": {
        const payload = call.payload as {
          instanceId: string;
          request: Parameters<NonNullable<RepoCellOpenInput["prepareRuntimeLaunch"]>>[1];
        };
        return input.prepareRuntimeLaunch!(payload.instanceId, payload.request);
      }
      case "prepareWorkerGitEnvironment":
        return input.prepareWorkerGitEnvironment!((call.payload as { instanceId: string }).instanceId);
      case "runtimeLaunch": {
        const payload = call.payload as {
          processId: string;
          input: Parameters<NonNullable<RepoCellOpenInput["runtimeLaunch"]>>[0];
          persistence: Parameters<NonNullable<RepoCellOpenInput["runtimeLaunch"]>>[1];
        };
        const launched = (input.runtimeLaunch ?? launchNative)(payload.input, payload.persistence);
        runtimeProcesses.set(payload.processId, launched);
        launched.onOutput((chunk, persisted) =>
          activePost({ processId: payload.processId, kind: "output", chunk, persisted }),
        );
        launched.onErrorOutput((chunk) => activePost({ processId: payload.processId, kind: "error", chunk }));
        launched.onExit((code) => {
          activePost({ processId: payload.processId, kind: "exit", code });
          runtimeProcesses.delete(payload.processId);
        });
        return { pid: launched.pid, terminateTree: launched.terminateTree !== undefined };
      }
      case "runtimeTerminate": {
        const processId = (call.payload as { processId: string }).processId;
        runtimeProcesses.get(processId)?.terminate();
        return null;
      }
      case "runtimeTerminateTree": {
        const processId = (call.payload as { processId: string }).processId;
        await runtimeProcesses.get(processId)?.terminateTree?.();
        return null;
      }
      case "bootstrap":
        input.onBootstrap?.(call.payload as never);
        return null;
      case "runtimeOutcome":
        input.onRuntimeOutcome?.(call.payload as never);
        return null;
      case "runtimeSignal": {
        const payload = call.payload as {
          runtimeSessionId: string;
          signal: Parameters<NonNullable<RepoCellOpenInput["onRuntimeSignal"]>>[1];
        };
        input.onRuntimeSignal?.(payload.runtimeSessionId, payload.signal);
        return null;
      }
      case "attemptTerminal":
        input.onAttemptTerminal?.(call.payload as never);
        return null;
      case "lifecycle":
        input.recordLifecycle?.(call.payload as never);
        return null;
      case "storeOpened":
        input.onStoreOpened?.({
          beginBulkWrite: () => {
            const begun = sendControl("beginBulkWrite");
            return {
              finish: async () => {
                await begun;
                await sendControl("finishBulkWrite");
              },
            };
          },
        } as Parameters<NonNullable<RepoCellOpenInput["onStoreOpened"]>>[0]);
        return null;
    }
  }

  function activePost(event: Omit<RuntimeProcessEventV1, "schema">): void {
    worker?.postMessage({
      schema: "harness-repo-writer-runtime-process-event/v1",
      ...event,
    } satisfies RuntimeProcessEventV1);
  }
}

function statusWithCurrentRetryElapsed(status: RepoCellStatus, observedAt: number): RepoCellStatus {
  const materialization = status.materialization;
  if (materialization?.state !== "retrying" || materialization.retryElapsedMs === undefined) return status;
  return {
    ...status,
    materialization: {
      ...materialization,
      retryElapsedMs: materialization.retryElapsedMs + Math.max(0, Date.now() - observedAt),
    },
  };
}

function bootstrapMessage(input: RepoCellOpenInput): RepoWriterBootstrapV1 {
  return {
    schema: "harness-repo-writer-bootstrap/v1",
    protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
    config: {
      repoId: input.repoId,
      rootDir: input.rootDir,
      ownerId: input.ownerId,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.authoredBranch ? { authoredBranch: input.authoredBranch } : {}),
      ...(input.runtimeDaemonRoute ? { runtimeDaemonRoute: input.runtimeDaemonRoute } : {}),
      ...(input.bootstrap ? { bootstrap: input.bootstrap } : {}),
      ...(input.defaultWriterEpochFence ? { defaultWriterEpochFence: input.defaultWriterEpochFence } : {}),
      ...(input.walMaterializationTestFault ? { walMaterializationTestFault: input.walMaterializationTestFault } : {}),
    },
    capabilities: {
      now: input.now !== undefined,
      killpoint: input.killpoint !== undefined,
      shouldStop: input.shouldStop !== undefined,
      runtimeInstances: input.runtimeInstances !== undefined,
      prepareRuntimeLaunch: input.prepareRuntimeLaunch !== undefined,
      prepareWorkerGitEnvironment: input.prepareWorkerGitEnvironment !== undefined,
      // Runtime worker hosts belong to the daemon process, not the replaceable
      // writer thread, so the daemon can reap them after a Cell restart.
      runtimeLaunch: true,
      runtimeSignal: input.onRuntimeSignal !== undefined,
      fleetRoster: input.fleetRoster !== undefined,
      storeOpened: input.onStoreOpened !== undefined,
    },
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("RepoWriterCell request was aborted"), { name: "AbortError" });
}

function writerWorkerUrl(moduleUrl: string | URL = import.meta.url): URL {
  const currentModuleUrl = new URL(moduleUrl),
    extension = path.extname(fileURLToPath(currentModuleUrl));
  return new URL(`./repo-writer-worker${extension}`, currentModuleUrl);
}

function respondCapability(
  worker: Worker,
  call: RepoWriterCapabilityCallV1,
  result: Pick<RepoWriterCapabilityResultV1, "outcome" | "value" | "error">,
): void {
  const response: RepoWriterCapabilityResultV1 = {
    schema: "harness-repo-writer-capability-result/v1",
    callId: call.callId,
    ...result,
  };
  if (call.sync) {
    const state = new Int32Array(call.sync.state),
      encoded = new TextEncoder().encode(JSON.stringify(response)),
      target = new Uint8Array(call.sync.bytes);
    if (encoded.byteLength > target.byteLength) {
      const fallback = new TextEncoder().encode(
        JSON.stringify({
          schema: response.schema,
          callId: response.callId,
          outcome: "error",
          error: serializeWriterError(new Error("synchronous writer capability response exceeded 1 MiB")),
        } satisfies RepoWriterCapabilityResultV1),
      );
      target.set(fallback);
      Atomics.store(state, 1, fallback.byteLength);
    } else {
      target.set(encoded);
      Atomics.store(state, 1, encoded.byteLength);
    }
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
  } else worker.postMessage(response);
}

function isReceipt(value: unknown): value is RepoWriterReceiptV1 {
  return isWriterSupervisorMessageRecord(value) && value.schema === "harness-repo-writer-receipt/v1";
}
function isStatus(value: unknown): value is RepoWriterStatusV1 {
  return isWriterSupervisorMessageRecord(value) && value.schema === "harness-repo-writer-status/v1";
}

function attachProgressAdvanced(previous: RepoCellAttachProgress | null, next: RepoCellAttachProgress): boolean {
  if (previous === null) return true;
  if (previous.phase !== next.phase) return attachPhaseOrder(next.phase) > attachPhaseOrder(previous.phase);
  if (next.phase === "recovering")
    return next.applied !== null && (previous.applied === null || next.applied > previous.applied);
  if (next.phase === "catching-up")
    return next.watermark !== null && (previous.watermark === null || next.watermark > previous.watermark);
  return false;
}

function attachPhaseOrder(phase: RepoCellAttachProgress["phase"]): number {
  return phase === "opening" ? 0 : phase === "recovering" ? 1 : 2;
}
function isCapabilityCall(value: unknown): value is RepoWriterCapabilityCallV1 {
  return isWriterSupervisorMessageRecord(value) && value.schema === "harness-repo-writer-capability-call/v1";
}
function isWriterSupervisorMessageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
