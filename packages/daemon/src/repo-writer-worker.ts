import { randomUUID } from "node:crypto";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { consumeKnownError, type CanonicalEventStore } from "../../kernel/src/index.ts";
import type { RepoCellOpenInput } from "./repo-cell-open.ts";
import { openRepoWriterCell } from "./repo-cell-open.ts";
import type { RepoCellAttachProgress, RepoCellBinding, RepoCellStatus } from "./repo-cell-types.ts";
import {
  REPO_WRITER_PROTOCOL_VERSION,
  deserializeWriterError,
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
  type SerializableRepoCellBindingV1,
} from "./repo-writer-protocol.ts";
import type { RuntimeProcess } from "./runtime-spawn.ts";
import { assertWriterEpochFenceDescriptor, withWriterEpochFenceDescriptor } from "./writer-epoch.ts";

const bootstrap = workerData as RepoWriterBootstrapV1;

if (!isMainThread) void startRepoWriterWorker();

async function startRepoWriterWorker(): Promise<void> {
  if (
    bootstrap?.schema !== "harness-repo-writer-bootstrap/v1" ||
    bootstrap.protocolVersion !== REPO_WRITER_PROTOCOL_VERSION ||
    !parentPort
  )
    throw new Error("RepoWriterCell received an incompatible bootstrap message");
  const asyncCapabilities = new Map<
      string,
      { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
    >(),
    runtimeProcesses = new Map<string, RuntimeProcessListeners>(),
    activeRequests = new Map<string, AbortController>();
  let cell: Awaited<ReturnType<typeof openRepoWriterCell>> | null = null,
    writerStore: CanonicalEventStore | null = null,
    bulkWrite: ReturnType<NonNullable<CanonicalEventStore["beginBulkWrite"]>> | null = null;
  let openingStatus = statusDuringOpen({
    phase: "opening",
    applied: null,
    total: null,
    watermark: null,
  });
  postStatus({ kind: "status", status: openingStatus });
  const heartbeat = setInterval(() => postStatus({ kind: "status", status: openingStatus }), 4_000);
  heartbeat.unref?.();

  parentPort.on("message", (message: unknown) => {
    if (isCapabilityResult(message)) {
      const pending = asyncCapabilities.get(message.callId);
      if (!pending) return;
      asyncCapabilities.delete(message.callId);
      if (message.outcome === "ok") pending.resolve(message.value);
      else pending.reject(deserializeWriterError(message.error!));
      return;
    }
    if (isWriterCancel(message)) {
      activeRequests.get(message.requestId)?.abort();
      return;
    }
    if (isRuntimeProcessEvent(message)) {
      const listeners = runtimeProcesses.get(message.processId);
      if (!listeners) return;
      if (message.kind === "output") listeners.output?.(message.chunk ?? "", message.persisted);
      else if (message.kind === "error") listeners.error?.(message.chunk ?? "");
      else listeners.exit?.(message.code ?? null);
      return;
    }
    if (isWriterRequest(message)) void handleRequest(message);
    else if (isWriterControl(message)) void handleControl(message);
  });

  try {
    const config = bootstrap.config,
      input: RepoCellOpenInput & {
        readonly onOpenProgress: (progress: RepoCellAttachProgress) => void;
      } = {
        ...config,
        repoId: config.repoId as RepoCellOpenInput["repoId"],
        rootDir: config.rootDir as RepoCellOpenInput["rootDir"],
        ...(bootstrap.capabilities.now ? { now: () => syncCapability<string>("now", null) } : {}),
        ...(bootstrap.capabilities.killpoint ? { killpoint: (point) => void syncCapability("killpoint", point) } : {}),
        ...(bootstrap.capabilities.shouldStop ? { shouldStop: () => syncCapability<boolean>("shouldStop", null) } : {}),
        ...(bootstrap.capabilities.runtimeInstances
          ? { runtimeInstances: () => syncCapability("runtimeInstances", null) }
          : {}),
        ...(bootstrap.capabilities.fleetRoster ? { fleetRoster: () => syncCapability("fleetRoster", null) } : {}),
        ...(bootstrap.capabilities.prepareRuntimeLaunch
          ? {
              prepareRuntimeLaunch: (instanceId, request) =>
                asyncCapability("prepareRuntimeLaunch", { instanceId, request }) as ReturnType<
                  NonNullable<RepoCellOpenInput["prepareRuntimeLaunch"]>
                >,
            }
          : {}),
        ...(bootstrap.capabilities.prepareWorkerGitEnvironment
          ? {
              prepareWorkerGitEnvironment: (instanceId) =>
                asyncCapability("prepareWorkerGitEnvironment", { instanceId }) as ReturnType<
                  NonNullable<RepoCellOpenInput["prepareWorkerGitEnvironment"]>
                >,
            }
          : {}),
        ...(bootstrap.capabilities.runtimeLaunch ? { runtimeLaunch: remoteRuntimeLaunch } : {}),
        ...(bootstrap.capabilities.runtimeSignal
          ? {
              onRuntimeSignal: (runtimeSessionId, signal) => notify("runtimeSignal", { runtimeSessionId, signal }),
            }
          : {}),
        ...(bootstrap.capabilities.storeOpened
          ? {
              onStoreOpened: (store) => {
                writerStore = store;
                notify("storeOpened", null);
              },
            }
          : {}),
        onMaterializationHealthChange: (materialization) => {
          const status = cell === null ? { ...openingStatus, materialization } : cell.status();
          openingStatus = status;
          postStatus({ kind: "status", status });
        },
        onBootstrap: (receipt) => notify("bootstrap", receipt),
        onOpenProgress: (progress) => {
          if (cell !== null) return;
          openingStatus = statusDuringOpen(progress);
          postStatus({ kind: "status", status: openingStatus });
        },
        onRuntimeOutcome: (event) => notify("runtimeOutcome", event),
        onAttemptTerminal: (terminal) => notify("attemptTerminal", terminal),
        recordLifecycle: (record) => notify("lifecycle", record),
      };
    cell = await openRepoWriterCell(input, { close: async () => undefined } as never);
    postStatus({
      kind: "ready",
      status: cell.status(),
      ...(cell.bootstrapReceipt ? { bootstrapReceipt: cell.bootstrapReceipt } : {}),
    });
  } catch (error) {
    consumeKnownError(error);
    postStatus({ kind: "closed", error: serializeWriterError(error) });
  } finally {
    clearInterval(heartbeat);
  }

  function statusDuringOpen(attach: RepoCellAttachProgress): RepoCellStatus {
    return {
      repoId: bootstrap.config.repoId,
      rootDir: bootstrap.config.rootDir,
      mode: bootstrap.config.mode ?? "local",
      state: "warming",
      generation: null,
      queueDepth: 0,
      lastError: null,
      causeClass: null,
      recoveryMs: null,
      materialization: null,
      attach,
    };
  }

  async function handleRequest(request: RepoWriterRequestV1): Promise<void> {
    const abort = new AbortController();
    activeRequests.set(request.requestId, abort);
    if (!cell) {
      activeRequests.delete(request.requestId);
      return postReceipt(request.requestId, undefined, new Error("RepoWriterCell is unavailable"));
    }
    try {
      const binding = reviveBinding(request.binding, request.writerEpoch);
      // Fence one: reject a stale descriptor when the request leaves the IPC queue.
      assertWriterEpoch(request.writerEpoch);
      let value: unknown;
      switch (request.method) {
        case "run":
          value = await cell.run(
            (request.payload as { action: Parameters<typeof cell.run>[0] }).action,
            binding!,
            abort.signal,
          );
          break;
        case "presetRun":
          value = await cell.presetRun(
            (request.payload as { action: Parameters<typeof cell.presetRun>[0] }).action,
            binding!,
          );
          break;
        case "spawnRuntime":
          value = await cell.spawnRuntime(request.payload as never, binding!);
          break;
        case "cancelRuntime":
          value = await cell.cancelRuntime(request.payload as never, binding!);
          break;
        case "runtimeIngress":
          value = await cell.runtimeIngress(
            (request.payload as { action: Parameters<typeof cell.runtimeIngress>[0] }).action,
            binding!,
          );
          break;
        case "settlePendingMaterialization":
          value = await cell.settlePendingMaterialization(String(request.payload));
          break;
        case "catalog": {
          const payload = request.payload as { method: keyof typeof cell.catalog; args: unknown[] };
          value = await (cell.catalog[payload.method] as (...args: unknown[]) => unknown)(...payload.args);
          break;
        }
      }
      postStatus({ kind: "cut", status: cell.status() });
      postReceipt(request.requestId, value);
    } catch (error) {
      consumeKnownError(error);
      postStatus({ kind: "status", status: cell.status() });
      postReceipt(request.requestId, undefined, error);
    } finally {
      activeRequests.delete(request.requestId);
    }
  }

  async function handleControl(control: RepoWriterControlV1): Promise<void> {
    try {
      if (control.command === "crash") process.exit(86);
      if (control.command === "beginBulkWrite") {
        if (bulkWrite) throw new Error("RepoWriterCell already has an active bulk write");
        const opened = writerStore?.beginBulkWrite?.();
        if (!opened) throw new Error("RepoWriterCell store does not support bulk writes");
        bulkWrite = opened;
      }
      if (control.command === "finishBulkWrite") {
        if (!bulkWrite) throw new Error("RepoWriterCell has no active bulk write");
        const active = bulkWrite;
        try {
          await active.finish();
        } finally {
          bulkWrite = null;
        }
      }
      if (control.command === "recover") await cell?.verifyReadiness();
      if (control.command === "drain") {
        for (const request of activeRequests.values()) request.abort();
        if (bulkWrite) {
          const active = bulkWrite;
          try {
            await active.finish();
          } finally {
            bulkWrite = null;
          }
        }
        await cell?.close();
        cell = null;
        writerStore = null;
      }
      postReceipt(control.requestId, null);
      if (control.command === "drain") postStatus({ kind: "closed" });
    } catch (error) {
      consumeKnownError(error);
      postReceipt(control.requestId, undefined, error);
    }
  }

  function syncCapability<T>(capability: RepoWriterCapabilityCallV1["capability"], payload: unknown): T {
    const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2),
      bytes = new SharedArrayBuffer(1024 * 1024),
      view = new Int32Array(state),
      call: RepoWriterCapabilityCallV1 = {
        schema: "harness-repo-writer-capability-call/v1",
        callId: randomUUID(),
        capability,
        payload,
        sync: { state, bytes },
      };
    parentPort!.postMessage(call);
    while (Atomics.load(view, 0) === 0) Atomics.wait(view, 0, 0);
    const length = Atomics.load(view, 1),
      decoded = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 0, length))) as RepoWriterCapabilityResultV1;
    if (decoded.outcome === "error") throw deserializeWriterError(decoded.error!);
    return decoded.value as T;
  }

  function asyncCapability(capability: RepoWriterCapabilityCallV1["capability"], payload: unknown): Promise<unknown> {
    const callId = randomUUID();
    parentPort!.postMessage({
      schema: "harness-repo-writer-capability-call/v1",
      callId,
      capability,
      payload,
    } satisfies RepoWriterCapabilityCallV1);
    return new Promise((resolve, reject) => asyncCapabilities.set(callId, { resolve, reject }));
  }

  function notify(capability: RepoWriterCapabilityCallV1["capability"], payload: unknown): void {
    parentPort!.postMessage({
      schema: "harness-repo-writer-capability-call/v1",
      callId: randomUUID(),
      capability,
      payload,
    } satisfies RepoWriterCapabilityCallV1);
  }

  function remoteRuntimeLaunch(
    input: Parameters<NonNullable<RepoCellOpenInput["runtimeLaunch"]>>[0],
    persistence: Parameters<NonNullable<RepoCellOpenInput["runtimeLaunch"]>>[1],
  ): RuntimeProcess {
    const processId = randomUUID(),
      listeners: RuntimeProcessListeners = {};
    runtimeProcesses.set(processId, listeners);
    const launched = syncCapability<{ readonly pid: number; readonly terminateTree: boolean }>("runtimeLaunch", {
      processId,
      input,
      persistence,
    });
    return {
      pid: launched.pid,
      onOutput: (listener) => {
        listeners.output = listener;
      },
      onErrorOutput: (listener) => {
        listeners.error = listener;
      },
      onExit: (listener) => {
        listeners.exit = listener;
      },
      terminate: () => notify("runtimeTerminate", { processId }),
      ...(launched.terminateTree
        ? { terminateTree: () => asyncCapability("runtimeTerminateTree", { processId }).then(() => undefined) }
        : {}),
      release: () => runtimeProcesses.delete(processId),
    };
  }
}

type RuntimeProcessListeners = {
  output?: (chunk: string, persisted?: boolean) => void;
  error?: (chunk: string) => void;
  exit?: (code: number | null) => void;
};

function reviveBinding(
  binding: SerializableRepoCellBindingV1 | undefined,
  descriptor: SerializableRepoCellBindingV1["writerEpochFence"] | null,
): RepoCellBinding | undefined {
  if (!binding) return undefined;
  if (descriptor !== (binding.writerEpochFence ?? null)) {
    if (JSON.stringify(descriptor) !== JSON.stringify(binding.writerEpochFence ?? null))
      throw new Error("writer epoch descriptor changed in transit");
  }
  return {
    ...binding,
    ...(descriptor
      ? {
          assertWriterEpoch: () => assertWriterEpoch(descriptor),
          withWriterEpochFence: <T>(operation: () => T) => withWriterEpochFenceDescriptor(descriptor, operation),
        }
      : {}),
  };
}

function assertWriterEpoch(descriptor: SerializableRepoCellBindingV1["writerEpochFence"] | null): void {
  if (descriptor) assertWriterEpochFenceDescriptor(descriptor);
}

function postReceipt(requestId: string, value?: unknown, error?: unknown): void {
  parentPort!.postMessage({
    schema: "harness-repo-writer-receipt/v1",
    protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
    requestId,
    outcome: error === undefined ? "ok" : "error",
    ...(error === undefined ? { value } : { error: serializeWriterError(error) }),
  } satisfies RepoWriterReceiptV1);
}

function postStatus(status: Omit<RepoWriterStatusV1, "schema" | "protocolVersion">): void {
  parentPort!.postMessage({
    schema: "harness-repo-writer-status/v1",
    protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
    ...status,
  } satisfies RepoWriterStatusV1);
}

function isWriterRequest(value: unknown): value is RepoWriterRequestV1 {
  return isWriterWorkerMessageRecord(value) && value.schema === "harness-repo-writer-request/v1";
}
function isWriterCancel(value: unknown): value is RepoWriterCancelV1 {
  return isWriterWorkerMessageRecord(value) && value.schema === "harness-repo-writer-cancel/v1";
}
function isWriterControl(value: unknown): value is RepoWriterControlV1 {
  return isWriterWorkerMessageRecord(value) && value.schema === "harness-repo-writer-control/v1";
}
function isCapabilityResult(value: unknown): value is RepoWriterCapabilityResultV1 {
  return isWriterWorkerMessageRecord(value) && value.schema === "harness-repo-writer-capability-result/v1";
}
function isRuntimeProcessEvent(value: unknown): value is RuntimeProcessEventV1 {
  return isWriterWorkerMessageRecord(value) && value.schema === "harness-repo-writer-runtime-process-event/v1";
}
function isWriterWorkerMessageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
