import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { consumeKnownError } from "../../kernel/src/index.ts";
import type { RepoCellOpenInput } from "./repo-cell-open.ts";
import type { RepoCellBinding, RepoCellStatus } from "./repo-cell-types.ts";
import {
  REPO_WRITER_PROTOCOL_VERSION,
  deserializeWriterError,
  serializeWriterError,
  type RepoWriterBootstrapV1,
  type RepoWriterCapabilityCallV1,
  type RepoWriterCapabilityResultV1,
  type RepoWriterControlV1,
  type RepoWriterReceiptV1,
  type RepoWriterRequestV1,
  type RepoWriterStatusV1,
  type RuntimeProcessEventV1,
  type SerializableRepoCellBindingV1,
} from "./repo-writer-protocol.ts";
import type { RuntimeProcess } from "./runtime-spawn.ts";

export interface WriterSupervisor {
  readonly request: <T>(
    method: RepoWriterRequestV1["method"],
    payload: unknown,
    binding?: RepoCellBinding,
  ) => Promise<T>;
  readonly control: (command: RepoWriterControlV1["command"]) => Promise<void>;
  readonly status: () => RepoCellStatus;
  readonly bootstrapReceipt: () => unknown;
  readonly close: () => Promise<void>;
}

export async function openWriterSupervisor(input: RepoCellOpenInput): Promise<WriterSupervisor> {
  let worker: Worker | null = null,
    closed = false,
    opened = false,
    restartAttempt = 0,
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
    },
    publishedBootstrapReceipt: unknown,
    ready: Promise<void>;
  const pending = new Map<
      string,
      { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
    >(),
    runtimeProcesses = new Map<string, RuntimeProcess>();

  ready = startWriterWorker();
  await ready;
  opened = true;

  return {
    request: async <T>(method: RepoWriterRequestV1["method"], payload: unknown, binding?: RepoCellBinding) => {
      await ready;
      if (closed || !worker) throw new Error("RepoWriterCell is closed");
      const requestId = randomUUID(),
        serializedBinding = binding ? serializableBinding(binding) : undefined,
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
        pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
        try {
          worker!.postMessage(request);
        } catch (error) {
          consumeKnownError(error);
          pending.delete(requestId);
          status = { ...status, queueDepth: Math.max(0, (status.queueDepth ?? 1) - 1) };
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    control: sendControl,
    status: () => status,
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
        for (const operation of pending.values()) operation.reject(new Error("RepoWriterCell closed"));
        pending.clear();
        status = { ...status, state: "closed", queueDepth: 0 };
      }
    },
  };

  function startWriterWorker(): Promise<void> {
    if (closed) return Promise.reject(new Error("WriterSupervisor is closed"));
    return new Promise((resolve, reject) => {
      const candidate = new Worker(writerWorkerUrl(), {
        execArgv: process.execArgv.filter(
          (argument) => argument === "--experimental-strip-types" || argument === "--enable-source-maps",
        ),
        workerData: bootstrapMessage(input),
      });
      let settled = false;
      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new Error("RepoWriterCell did not publish ready within 30000ms");
        if (!opened) closed = true;
        reject(error);
        failActive(error);
        void candidate.terminate();
      }, 30_000);
      readyTimer.unref?.();
      worker = candidate;
      candidate.on("message", (message: unknown) => {
        if (isReceipt(message)) {
          const operation = pending.get(message.requestId);
          if (!operation) return;
          pending.delete(message.requestId);
          status = { ...status, queueDepth: Math.max(0, (status.queueDepth ?? 1) - 1) };
          if (message.outcome === "ok") operation.resolve(message.value);
          else operation.reject(deserializeWriterError(message.error!));
          return;
        }
        if (isStatus(message)) {
          const published = message.status;
          if (published && typeof published === "object") status = published as RepoCellStatus;
          if (message.bootstrapReceipt !== undefined) {
            publishedBootstrapReceipt = message.bootstrapReceipt;
            input.onBootstrap?.(message.bootstrapReceipt as never);
          }
          if (message.kind === "ready") {
            restartAttempt = 0;
            settled = true;
            clearTimeout(readyTimer);
            resolve();
          } else if (message.kind === "closed" && message.error && !settled) {
            settled = true;
            clearTimeout(readyTimer);
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
          clearTimeout(readyTimer);
          if (!opened) closed = true;
          reject(error);
        }
        failActive(error);
      });
      candidate.once("exit", (code) => {
        clearTimeout(readyTimer);
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
      pending.set(requestId, { resolve: () => resolve(), reject });
      worker!.postMessage(control);
    });
  }

  function failActive(error: Error): void {
    for (const operation of pending.values()) operation.reject(error);
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
        const launched = input.runtimeLaunch!(payload.input, payload.persistence);
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
      ...(input.walMaterializationTestFault ? { walMaterializationTestFault: input.walMaterializationTestFault } : {}),
    },
    capabilities: {
      now: input.now !== undefined,
      killpoint: input.killpoint !== undefined,
      shouldStop: input.shouldStop !== undefined,
      runtimeInstances: input.runtimeInstances !== undefined,
      prepareRuntimeLaunch: input.prepareRuntimeLaunch !== undefined,
      prepareWorkerGitEnvironment: input.prepareWorkerGitEnvironment !== undefined,
      runtimeLaunch: input.runtimeLaunch !== undefined,
      runtimeSignal: input.onRuntimeSignal !== undefined,
      fleetRoster: input.fleetRoster !== undefined,
      storeOpened: input.onStoreOpened !== undefined,
    },
  };
}

function serializableBinding(binding: RepoCellBinding): SerializableRepoCellBindingV1 {
  const { assertWriterEpoch: _assert, withWriterEpochFence: _fence, ...serializable } = binding;
  return serializable;
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
function isCapabilityCall(value: unknown): value is RepoWriterCapabilityCallV1 {
  return isWriterSupervisorMessageRecord(value) && value.schema === "harness-repo-writer-capability-call/v1";
}
function isWriterSupervisorMessageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
