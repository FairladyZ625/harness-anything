import { randomUUID } from "node:crypto";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { consumeKnownError } from "../../kernel/src/index.ts";
import type { RepoCellOpenInput } from "./repo-cell-open.ts";
import { openRepoWriterCell } from "./repo-cell-open.ts";
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
  type SerializableRepoCellBindingV1,
} from "./repo-writer-protocol.ts";
import type { RuntimeProcess } from "./runtime-spawn.ts";
import {
  assertWriterEpochFenceDescriptor,
  closeWriterEpochFenceDescriptors,
  withWriterEpochFenceDescriptor,
} from "./writer-epoch.ts";

const bootstrap = workerData as RepoWriterBootstrapV1;

if (!isMainThread) void startRepoWriterWorker();

async function startRepoWriterWorker(): Promise<void> {
  // One buffer pair serves the worker's whole life: syncCapability blocks the thread in Atomics.wait
  // until the supervisor answers, so rounds never overlap and the supervisor overwrites the shared
  // bytes in place. The state cell is re-armed before each post so the next round waits for a fresh
  // answer instead of reading the previous round's completion. Declared before the open so the hoisted
  // syncCapability can be called from open-time capabilities (killpoint, fleetRoster) without a TDZ.
  let syncState: SharedArrayBuffer | null = null,
    syncBytes: SharedArrayBuffer | null = null;
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
  let cell: Awaited<ReturnType<typeof openRepoWriterCell>> | null = null;
  let openingStatus = statusDuringOpen({
    phase: "opening",
    applied: null,
    total: null,
    watermark: null,
  });
  postStatus({ kind: "attach-progress", status: openingStatus });

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
        onMaterializationHealthChange: (materialization) => {
          const status = cell === null ? { ...openingStatus, materialization } : cell.status();
          openingStatus = status;
          postStatus({ kind: "status", status });
        },
        onBootstrap: (receipt) => notify("bootstrap", receipt),
        onOpenProgress: (progress) => {
          if (cell !== null) return;
          openingStatus = statusDuringOpen(progress);
          postStatus({ kind: "attach-progress", status: openingStatus });
        },
        onRuntimeOutcome: (event) => notify("runtimeOutcome", event),
        onAttemptTerminal: (terminal) =>
          notify("attemptTerminal", {
            ...terminal,
            binding: serializableRepoCellBinding(terminal.binding as RepoCellBinding),
          }),
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
      // Reject a stale descriptor before any effect: runtime cancel terminates a process and a
      // resumed spawn launches one before their first ledger append reaches the append fence.
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
      if (control.command === "recover") await cell?.verifyReadiness();
      if (control.command === "drain") {
        for (const request of activeRequests.values()) request.abort();
        await cell?.close();
        cell = null;
        closeWriterEpochFenceDescriptors();
      }
      postReceipt(control.requestId, null);
      if (control.command === "drain") postStatus({ kind: "closed" });
    } catch (error) {
      consumeKnownError(error);
      postReceipt(control.requestId, undefined, error);
    }
  }

  function syncCapability<T>(capability: RepoWriterCapabilityCallV1["capability"], payload: unknown): T {
    syncState ??= new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    syncBytes ??= new SharedArrayBuffer(1024 * 1024);
    const view = new Int32Array(syncState),
      call: RepoWriterCapabilityCallV1 = {
        schema: "harness-repo-writer-capability-call/v1",
        callId: randomUUID(),
        capability,
        payload,
        sync: { state: syncState, bytes: syncBytes },
      };
    Atomics.store(view, 0, 0);
    Atomics.store(view, 1, 0);
    parentPort!.postMessage(call);
    while (Atomics.load(view, 0) === 0) Atomics.wait(view, 0, 0);
    const length = Atomics.load(view, 1),
      decoded = JSON.parse(
        new TextDecoder().decode(new Uint8Array(syncBytes, 0, length)),
      ) as RepoWriterCapabilityResultV1;
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
  // Structured clone hands the worker two distinct objects for the same fence, so equality is decided
  // field by field; a stringify comparison would reserialize both descriptors on every request.
  if (!sameWriterEpochFence(descriptor ?? null, binding.writerEpochFence ?? null))
    throw new Error("writer epoch descriptor changed in transit");
  return {
    ...binding,
    ...(descriptor
      ? { withWriterEpochFence: <T>(operation: () => T) => withWriterEpochFenceDescriptor(descriptor, operation) }
      : {}),
  };
}

function assertWriterEpoch(descriptor: SerializableRepoCellBindingV1["writerEpochFence"] | null): void {
  if (descriptor) assertWriterEpochFenceDescriptor(descriptor);
}

function sameWriterEpochFence(
  left: NonNullable<SerializableRepoCellBindingV1["writerEpochFence"]> | null,
  right: NonNullable<SerializableRepoCellBindingV1["writerEpochFence"]> | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.schema === right.schema &&
      left.stateRoot === right.stateRoot &&
      left.repoId === right.repoId &&
      left.epoch === right.epoch &&
      left.holderId === right.holderId)
  );
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
