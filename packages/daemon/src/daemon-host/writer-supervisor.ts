import {
  isRetryableSandboxFailure,
  waitForSandboxReply,
} from "@harness-anything/application/internal/commands/runtime-execution-target.ts";
import { connectRepoWriterHost } from "./repo-writer-host.ts";
import {
  daemonWriterSupportsCommitPhase,
  daemonWriterEntryName,
  type DaemonStorageConfig,
} from "@harness-anything/storage";
import { createWriterRequestQueue } from "./writer-request-queue.ts";
import { labelWorkerMemory } from "../writer-cell/daemon-diagnostics-memory.ts";
import { writerLifecyclePolicy } from "@harness-anything/kernel/internal/domain/writer-lifecycle-policy.ts";
import { fleetBaseBackupTrace, prepareStorageWorkerContext } from "@harness-anything/storage";
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { consumeKnownError } from "@harness-anything/kernel";
import type { RepoCellOpenInput } from "./repo-cell-types.ts";
import type { RepoCellAttachProgress, RepoCellBinding, RepoCellStatus } from "./repo-cell-types.ts";
import {
  REPO_WRITER_PROTOCOL_VERSION,
  deserializeWriterError,
  serializableRepoCellBinding,
  serializableKeycloakAuthorization,
  serializeWriterError,
  type RepoWriterBootstrapV1,
  type RepoWriterCanonicalStoreCall,
  type RepoWriterCanonicalStoreCapability,
  type RepoWriterCancelV1,
  type RepoWriterCapabilityCallV1,
  type RepoWriterCapabilityResultV1,
  type RepoWriterControlV1,
  type RepoWriterReceiptV1,
  type RepoWriterRequestV1,
  type RepoWriterStatusV1,
  type RepoWriterFleetBaseBackupTraceV1,
  type RuntimeProcessEventV1,
} from "./repo-writer-protocol.ts";
import { launchNative } from "./runtime-spawn-process.ts";
import { captureDaemonOperation, type DaemonOperationHandle } from "./daemon-operation.ts";
import type { RuntimeProcess } from "./runtime-spawn.ts";
import { createRuntimeInstanceDispatchState } from "./runtime-instance-selection.ts";
import { resolveRuntimeInstanceCandidates } from "./runtime-spawn-mission.ts";
import { resolveCustomChannelOutboundAdapter } from "./channel-outbox.ts";
import type { RuntimeInstanceSchedulingCall } from "./repo-writer-protocol.ts";

export interface WriterSupervisor {
  readonly request: <T>(
    method: RepoWriterRequestV1["method"],
    payload: unknown,
    binding?: RepoCellBinding,
    signal?: AbortSignal,
  ) => Promise<T>;
  readonly control: (command: Exclude<RepoWriterControlV1["command"], "hibernate">) => Promise<void>;
  readonly status: () => RepoCellStatus;
  readonly bootstrapReceipt: () => unknown;
  readonly ledgerCut: import("./repo-cell-types.ts").ReplicaCutSource["ledgerCut"];
  readonly close: () => Promise<void>;
}

/** Node-local override for the ready watchdog (dec_9DBB2EB3 CH3: machine-speed thresholds stay off the shared
 * settings); a cold rebuild on a large repository or slow disk can outlive the default without being dead. */
export const WRITER_READY_WATCHDOG_MS_ENV = "HARNESS_WRITER_READY_WATCHDOG_MS";
export const WRITER_READY_WATCHDOG_MS = 60_000;

/** Keep only the recent write working set; the host retains the repository lock and readable cut. */
export const WRITER_IDLE_TIMEOUT_MS = writerLifecyclePolicy.defaultValue.idleTimeoutMs;

/** Effective watchdog: the environment override, else the default. An invalid override fails closed. */
export function resolveWriterReadyWatchdogMs(env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = env[WRITER_READY_WATCHDOG_MS_ENV];
  if (fromEnv === undefined || fromEnv === "") return WRITER_READY_WATCHDOG_MS;
  const value = Number(fromEnv);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw Object.assign(new Error(`${WRITER_READY_WATCHDOG_MS_ENV} must be a positive integer of milliseconds.`), {
      code: "writer_ready_watchdog_invalid",
    });
  return value;
}

export async function openWriterSupervisor(
  input: RepoCellOpenInput,
  options: {
    readonly canonicalStore?: RepoWriterCanonicalStoreCapability;
    readonly connectHost?: typeof connectRepoWriterHost;
    readonly createWorker?: (
      url: URL,
      workerOptions: {
        readonly execArgv: readonly string[];
        readonly name?: string;
        readonly resourceLimits?: import("node:worker_threads").ResourceLimits;
        readonly workerData: RepoWriterBootstrapV1;
        readonly transferList?: readonly import("node:worker_threads").MessagePort[];
      },
    ) => Worker;
    readonly rollbackGraceMs?: number;
    readonly syncRepDrainGraceMs?: number;
    readonly requestTimeoutMs?: number;
    readonly onWarning?: (warning: { event: string; repoId: string; opId: string; code?: string }) => void;
    readonly onAttachStatus?: (status: RepoCellStatus) => void;
    readonly onPublishedStatus?: (status: RepoCellStatus) => void;
    readonly onMetricsStatus?: (status: RepoCellStatus) => void;
  } = {},
): Promise<WriterSupervisor> {
  const instanceScheduling = input.runtimeInstanceDispatchState ?? createRuntimeInstanceDispatchState();
  let stagedWriteSlot = false,
    writerGeneration = 0,
    users = 0,
    retiring = false,
    idleTimer: ReturnType<typeof setTimeout> | undefined;
  const expectedExits = new WeakSet<Worker>();
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
    publishedLedgerCut: ReturnType<WriterSupervisor["ledgerCut"]> = null,
    ready: Promise<void>;
  const pending = new Map<
      string,
      {
        readonly resolve: (value: unknown) => void;
        readonly reject: (error: Error) => void;
        readonly cleanup: () => void;
        readonly retainSessionToken: boolean;
        readonly storeAbort?: AbortController;
        readonly operation: DaemonOperationHandle | null;
        readonly phase: string;
      }
    >(),
    runtimeProcesses = new Map<string, RuntimeProcess>(),
    sessionTokens = new Map<string, { readonly resolve: () => Promise<string>; references: number }>(),
    fleetBackupTraces = new Map<
      string,
      { readonly publish: (message: RepoWriterFleetBaseBackupTraceV1) => void; span?: { repoId: string | null } }
    >();

  const publishMetricsStatus = (): void => {
    if (!options.onMetricsStatus) return;
    options.onMetricsStatus({
      ...status,
      queueDepth: Math.max(status.queueDepth ?? 0, writes.depth()),
    });
  };

  const writes = createWriterRequestQueue({
    repoId: input.repoId,
    abortInFlightOnClose: options.canonicalStore !== undefined || daemonWriterSupportsCommitPhase(input.storage),
    rollbackGraceMs: options.rollbackGraceMs,
    syncRepDrainGraceMs: options.syncRepDrainGraceMs,
    requestTimeoutMs: options.requestTimeoutMs,
    warn: options.onWarning,
    ...(options.onMetricsStatus ? { onDepthChange: publishMetricsStatus } : {}),
    terminateAborted: async (error) => {
      const active = worker;
      worker = null;
      if (active) expectedExits.add(active);
      ready = (async () => {
        if (active) await active.terminate();
        if (!closed) await startWriterWorker();
      })();
      failActive(error);
      await ready;
    },
  });

  ready = startWriterWorker();
  await ready;
  opened = true;
  armIdle();

  const supervisor = {
    request: async <T>(
      method: RepoWriterRequestV1["method"],
      payload: unknown,
      binding: RepoCellBinding | undefined,
      signal: AbortSignal | undefined,
      requestId: string,
      markDispatched: () => void,
    ): Promise<T> => {
      const publishFleetBackupTrace =
        method === "fleetBackup"
          ? AsyncResource.bind((message: RepoWriterFleetBaseBackupTraceV1) => {
              const trace = fleetBackupTraces.get(message.requestId);
              if (!trace) return;
              if (message.phase === "start") {
                if (trace.span) return;
                trace.span = { repoId: message.repoId };
                fleetBaseBackupTrace.start.publish(trace.span);
              } else if (message.phase === "asyncStart") {
                if (!trace.span) return;
                trace.span.repoId = message.repoId;
                fleetBaseBackupTrace.asyncStart.publish(trace.span);
              } else {
                if (!trace.span) return;
                fleetBaseBackupTrace.end.publish(trace.span);
                fleetBackupTraces.delete(message.requestId);
              }
            }, "harness-repo-writer-fleet-backup")
          : undefined;
      await acquireWriter();
      if (closed || !worker) throw new Error("RepoWriterCell is closed");
      if (signal?.aborted) throw abortError(signal);
      const storeAbort = method === "canonicalStore" ? new AbortController() : undefined,
        operation = captureDaemonOperation();
      const serializedBinding = binding ? serializableRepoCellBinding(binding) : undefined,
        request: RepoWriterRequestV1 = {
          schema: "harness-repo-writer-request/v1",
          protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
          requestId,
          method,
          payload,
          ...(serializedBinding ? { binding: serializedBinding } : {}),
          writerEpoch: serializedBinding?.writerEpochFence ?? null,
          ...(writes.active()?.requestId === requestId
            ? { writeRequest: { state: writes.active()!.state, id: writes.active()!.id } }
            : {}),
        };
      status = { ...status, queueDepth: (status.queueDepth ?? 0) + 1 };
      publishMetricsStatus();
      return await new Promise<T>((resolve, reject) => {
        const cancel = () => {
            storeAbort?.abort(signal?.reason);
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
        const currentAccessToken = binding?.keycloakAuthorization?.session?.currentAccessToken;
        if (currentAccessToken) sessionTokens.set(requestId, { resolve: currentAccessToken, references: 1 });
        if (publishFleetBackupTrace) fleetBackupTraces.set(requestId, { publish: publishFleetBackupTrace });
        pending.set(requestId, {
          resolve: resolve as (value: unknown) => void,
          reject,
          cleanup,
          storeAbort,
          operation,
          phase: phaseForWriterMethod(method),
          // Preset admission returns before produce; keep its session until the terminal witness.
          retainSessionToken:
            method === "presetRun" && (payload as { action: { kind: string } }).action.kind === "preset-run-start",
        });
        try {
          markDispatched();
          worker!.postMessage(request);
          if (signal?.aborted) cancel();
        } catch (error) {
          consumeKnownError(error);
          pending.delete(requestId);
          sessionTokens.delete(requestId);
          closeFleetBackupTrace(requestId);
          cleanup();
          status = { ...status, queueDepth: Math.max(0, (status.queueDepth ?? 1) - 1) };
          publishMetricsStatus();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    control: async (command: Exclude<RepoWriterControlV1["command"], "hibernate">) => {
      users++;
      clearTimeout(idleTimer);
      try {
        await acquireWriter();
        await sendControl(command);
      } finally {
        users--;
        armIdle();
      }
    },
    status: () => ({
      ...statusWithCurrentRetryElapsed(status, statusObservedAt),
      queueDepth: Math.max(status.queueDepth ?? 0, writes.depth()),
    }),
    bootstrapReceipt: () => publishedBootstrapReceipt,
    ledgerCut: () => publishedLedgerCut,
    close: async () => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      const drained = await writes.close();
      if (!drained && writes.active()) {
        // Keep SyncRep's connection alive after bounded close; retire only after its real receipt.
        worker?.unref();
        void writes.active()!.done.promise.then(finishClose);
        status = { ...status, state: "closed" };
        return;
      }
      await finishClose();
    },
  };

  return {
    ...supervisor,
    request: async <T>(
      method: RepoWriterRequestV1["method"],
      payload: unknown,
      binding?: RepoCellBinding,
      signal?: AbortSignal,
    ) => {
      users++;
      clearTimeout(idleTimer);
      try {
        const opId = (payload as { opId?: string } | null)?.opId ?? `op_${randomUUID()}`;
        return await writes.request<T>(
          randomUUID(),
          opId,
          signal,
          stagedWriteSlot && method !== "canonicalStore",
          AsyncResource.bind(
            (admitted) =>
              supervisor.request<T>(
                method,
                payload,
                binding,
                admitted.abort.signal,
                admitted.requestId,
                admitted.markDispatched,
              ),
            "harness-repo-writer-request",
          ),
        );
      } finally {
        users--;
        armIdle();
      }
    },
  };

  async function finishClose(): Promise<void> {
    try {
      await ready;
      if (worker) {
        expectedExits.add(worker);
        await sendControl("drain", true);
      }
    } finally {
      const active = worker;
      worker = null;
      closeFleetBackupTrace();
      if (active) await active.terminate();
      failActive(new Error("RepoWriterCell closed"));
      status = { ...status, state: "closed", queueDepth: 0 };
      publishMetricsStatus();
    }
  }

  function startWriterWorker(): Promise<void> {
    if (closed) return Promise.reject(new Error("WriterSupervisor is closed"));
    const resuming = opened && status.state === "attached";
    return new Promise((resolve, reject) => {
      writerGeneration = Math.max(writerGeneration + 1, Date.now() * 1_000 + (process.pid % 1_000));
      const watchdogMs = resolveWriterReadyWatchdogMs(),
        readyWatchdogState = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),
        readyProgress = new BigInt64Array(readyWatchdogState),
        watchdogNs = BigInt(watchdogMs) * 1_000_000n,
        context = prepareStorageWorkerContext(input.storage, input.repoId),
        workerOptions = {
          name: "repo-writer",
          resourceLimits: { maxYoungGenerationSizeMb: writerLifecyclePolicy.defaultValue.maxYoungGenerationSizeMb },
          execArgv: process.execArgv.filter(
            (argument) => argument === "--experimental-strip-types" || argument === "--enable-source-maps",
          ),
          workerData: {
            ...bootstrapMessage(
              opened
                ? {
                    ...input,
                    bootstrap: undefined,
                    authoredBranch:
                      input.authoredBranch ??
                      (publishedBootstrapReceipt as { readonly authoredBranch?: string } | undefined)?.authoredBranch,
                  }
                : input,
              options.canonicalStore !== undefined,
              writerGeneration,
              readyWatchdogState,
            ),
            storageContext: context.context,
          },
          transferList: context.transferList,
        };
      let candidate: Worker;
      try {
        candidate = labelWorkerMemory(
          options.createWorker?.(writerWorkerUrl(import.meta.url, input.storage), workerOptions) ??
            new Worker(writerWorkerUrl(import.meta.url, input.storage), workerOptions),
          "repo-writer",
        );
      } catch (error) {
        context.close();
        throw error;
      }
      if (candidate instanceof Worker)
        (options.connectHost ?? connectRepoWriterHost)(candidate, workerOptions.workerData);
      candidate.once("exit", context.close);
      let settled = false,
        lastAttachProgress: RepoCellAttachProgress | null = null;
      let readyWatchdog: ReturnType<typeof setTimeout>,
        lastReadyMessage = process.hrtime.bigint();
      const readyInactive = () => {
        if (settled) return;
        const currentReadyProgress = Atomics.load(readyProgress, 0);
        if (currentReadyProgress > lastReadyMessage) {
          const remaining = watchdogNs - (process.hrtime.bigint() - currentReadyProgress);
          if (remaining > 0n) {
            scheduleReadyWatchdog(Number((remaining + 999_999n) / 1_000_000n));
            return;
          }
        }
        settled = true;
        const error = new Error(`RepoWriterCell did not publish ready after ${watchdogMs}ms without progress`);
        if (!opened) closed = true;
        reject(error);
        failActive(error);
        void candidate.terminate();
      };
      const scheduleReadyWatchdog = (delayMs: number) => {
        clearTimeout(readyWatchdog);
        readyWatchdog = setTimeout(readyInactive, delayMs);
        readyWatchdog.unref?.();
      };
      const armReadyWatchdog = () => {
        lastReadyMessage = process.hrtime.bigint();
        scheduleReadyWatchdog(watchdogMs);
      };
      armReadyWatchdog();
      worker = candidate;
      candidate.on("message", (message: unknown) => {
        if (worker !== candidate) return;
        if (isReceipt(message)) {
          const operation = pending.get(message.requestId);
          if (!operation) return;
          pending.delete(message.requestId);
          if (message.outcome !== "ok") closeFleetBackupTrace(message.requestId);
          if (
            !operation.retainSessionToken ||
            message.outcome !== "ok" ||
            (message.value as { outcome?: string } | undefined)?.outcome !== "started"
          )
            releaseSessionToken(message.requestId);
          operation.cleanup();
          if (message.runtimeWriteTurns !== undefined) {
            let preparedAtMs = message.startedAtMs;
            for (const turn of message.runtimeWriteTurns) {
              const end = turn.finishedAtMs ?? message.finishedAtMs ?? turn.queuedAtMs;
              if (preparedAtMs !== undefined)
                operation.operation?.phaseSpan("write-prepare", preparedAtMs, turn.queuedAtMs);
              operation.operation?.phaseSpan("write-queue", turn.queuedAtMs, turn.startedAtMs ?? end);
              if (turn.startedAtMs !== undefined)
                operation.operation?.phaseSpan("write-execution", turn.startedAtMs, end);
              preparedAtMs = end;
            }
          } else if (typeof message.startedAtMs === "number" && typeof message.finishedAtMs === "number")
            operation.operation?.phaseSpan(
              operation.phase,
              message.executionStartedAtMs ?? message.startedAtMs,
              message.finishedAtMs,
            );
          if (message.queueHead !== undefined) operation.operation?.noteQueueHead(message.queueHead);
          status = { ...status, queueDepth: Math.max(0, (status.queueDepth ?? 1) - 1) };
          publishMetricsStatus();
          if (message.outcome === "ok") operation.resolve(message.value);
          else operation.reject(deserializeWriterError(message.error!));
          armIdle();
          return;
        }
        if (isStatus(message)) {
          if (message.ledgerCut !== undefined) publishedLedgerCut = message.ledgerCut;
          const published = message.status;
          if (published && typeof published === "object") {
            const attaching = published.state === "warming";
            if ((!settled || !attaching) && !(resuming && attaching)) {
              status = published;
              statusObservedAt = Date.now();
            }
            options.onPublishedStatus?.(status);
            publishMetricsStatus();
            if (!settled && attaching && !resuming) options.onAttachStatus?.(published);
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
            if (
              !settled &&
              attaching &&
              message.kind === "status" &&
              published.attach !== undefined &&
              attachProgressAllowsWatchdog(lastAttachProgress, published.attach)
            )
              armReadyWatchdog();
          }
          if (message.bootstrapReceipt !== undefined) {
            publishedBootstrapReceipt = message.bootstrapReceipt;
            input.onBootstrap?.(message.bootstrapReceipt as never);
          }
          if (message.kind === "ready") {
            stagedWriteSlot = message.stagedWriteSlot === true;
            restartAttempt = 0;
            settled = true;
            clearTimeout(readyWatchdog);
            resolve();
            if (opened) armIdle();
          } else if (message.kind === "closed" && message.error && !settled) {
            settled = true;
            clearTimeout(readyWatchdog);
            if (!opened) closed = true;
            const failure = deserializeWriterError(message.error);
            void candidate.terminate().finally(() => reject(failure));
          }
          return;
        }
        if (isCapabilityCall(message)) {
          if (message.capability === "fleetBaseBackupTrace") {
            const trace = message.payload as RepoWriterFleetBaseBackupTraceV1;
            fleetBackupTraces.get(trace.requestId)?.publish(trace);
          } else void handleCapability(candidate, message);
        }
      });
      candidate.once("error", (error) => {
        if (worker !== candidate) return;
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
        closeFleetBackupTrace();
        if (expectedExits.has(candidate)) {
          writes.workerExited(error);
          return;
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
          publishMetricsStatus();
          const delay = Math.min(1_000, 25 * 2 ** restartAttempt++);
          ready = new Promise((restartResolve, restartReject) => {
            const timer = setTimeout(() => {
              if (closed) restartResolve();
              else startWriterWorker().then(restartResolve, restartReject);
            }, delay);
            timer.unref?.();
          });
        }
        writes.workerExited(error);
      });
    });
  }

  async function sendControl(command: RepoWriterControlV1["command"], allowClosed = false): Promise<unknown> {
    if ((!allowClosed && closed) || !worker) throw new Error("RepoWriterCell is unavailable");
    const requestId = randomUUID(),
      control: RepoWriterControlV1 = {
        schema: "harness-repo-writer-control/v1",
        protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
        requestId,
        command,
      };
    return new Promise<unknown>((resolve, reject) => {
      const watchdog = setTimeout(() => {
        pending.delete(requestId);
        const error = Object.assign(
          new Error(`Writer control ${command} did not acknowledge within ${WRITER_READY_WATCHDOG_MS}ms`),
          { code: "writer_control_timeout" },
        );
        status = { ...status, state: "unavailable", lastError: error.message, causeClass: "infrastructure" };
        reject(error);
      }, WRITER_READY_WATCHDOG_MS);
      watchdog.unref?.();
      pending.set(requestId, {
        resolve,
        reject,
        cleanup: () => clearTimeout(watchdog),
        retainSessionToken: false,
        operation: null,
        phase: "write-execution",
      });
      worker!.postMessage(control);
    });
  }

  async function acquireWriter(): Promise<void> {
    // Admission reserves a user before yielding. Retirement publishes this barrier before
    // posting hibernate, so a successor cannot open until drain AND terminate have finished.
    await ready;
    if (closed) throw new Error("RepoWriterCell is closed");
    if (!worker) ready = startWriterWorker();
    await ready;
  }

  function armIdle(): void {
    clearTimeout(idleTimer);
    if (closed || retiring || status.state !== "attached" || users !== 0 || pending.size !== 0 || !worker) return;
    idleTimer = setTimeout(() => {
      if (closed || users !== 0 || pending.size !== 0 || !worker) return;
      const active = worker;
      retiring = true;
      ready = (async () => {
        const hibernated = await sendControl("hibernate");
        if (hibernated === true) {
          expectedExits.add(active);
          await active.terminate();
          if (worker === active) worker = null;
        }
      })()
        .catch((error: unknown) => {
          // A failed close may have already released cell resources; never retry it as an idle veto.
          status = {
            ...status,
            state: "unavailable",
            lastError: error instanceof Error ? error.message : String(error),
            causeClass: "infrastructure",
          };
          throw error;
        })
        .finally(() => {
          retiring = false;
          armIdle();
        });
      // Observe background rejection; admission still receives the original rejected barrier.
      void Promise.allSettled([ready]);
    }, WRITER_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  }

  function failActive(error: Error): void {
    closeFleetBackupTrace();
    for (const operation of pending.values()) {
      operation.storeAbort?.abort(error);
      operation.cleanup();
      operation.reject(error);
    }
    pending.clear();
    sessionTokens.clear();
  }

  function closeFleetBackupTrace(requestId?: string): void {
    if (requestId !== undefined) {
      const trace = fleetBackupTraces.get(requestId);
      if (trace?.span) trace.publish({ requestId, phase: "end", repoId: trace.span.repoId });
      fleetBackupTraces.delete(requestId);
      return;
    }
    for (const [id, trace] of fleetBackupTraces) {
      if (trace.span) trace.publish({ requestId: id, phase: "end", repoId: trace.span.repoId });
      fleetBackupTraces.delete(id);
    }
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
      case "writeQueued":
        writes.queued((call.payload as { requestId: string }).requestId);
        return;
      case "acquireWriteSlot": {
        return writes
          .acquire((call.payload as { requestId?: string }).requestId)
          .then((slot) => ({ state: slot.state, id: slot.id }));
      }
      case "releaseWriteSlot":
        writes.release((call.payload as { slotId: number }).slotId);
        return;
      case "writeOperation": {
        const { requestId, slotId, opId } = call.payload as { requestId?: string; slotId?: number; opId: string };
        const slot = writes.active();
        if (slot && (slotId === undefined ? slot.requestId === requestId : slot.id === slotId)) slot.opId = opId;
        return;
      }
      case "canonicalStore": {
        if (!options.canonicalStore || call.sync)
          throw new Error("Writer canonical store capability requires an async host");
        const { requestId, request } = call.payload as RepoWriterCanonicalStoreCall;
        const operation = pending.get(requestId);
        if (!operation?.storeAbort) throw new Error("Writer canonical store request is no longer active");
        operation.storeAbort.signal.throwIfAborted();
        return options.canonicalStore(request, operation.storeAbort.signal);
      }
      case "now":
        return input.now!();
      case "channelOutbound": {
        const req = call.payload as {
          readonly op: "has" | "deliver";
          readonly message: import("@harness-anything/kernel/internal/domain/channel-adapter.ts").ChannelOutboxMessage;
          readonly now: string;
        };
        const adapter = resolveCustomChannelOutboundAdapter(input.repoId, req.message);
        if (req.op === "has") return Boolean(adapter);
        if (!adapter) return { status: "failed", reasonCode: "unregistered_channel_adapter" };
        return adapter.deliver(req.message, { now: req.now } as never);
      }
      case "killpoint":
        return input.killpoint!(call.payload as never);
      case "shouldStop":
        return input.shouldStop!();
      case "runtimeInstances":
        return input.runtimeInstances!();
      case "runtimeInstanceScheduling": {
        const request = call.payload as RuntimeInstanceSchedulingCall;
        switch (request.operation) {
          case "snapshot":
            return {
              recency: [...instanceScheduling.lastDispatchedAt],
              loads: [...instanceScheduling.readActiveLoads()],
            };
          case "record":
            return instanceScheduling.recordDispatch(request.instanceId);
          case "activate":
            return instanceScheduling.activate(request.runtimeSessionId, request.instanceId);
          case "deactivate":
            return instanceScheduling.deactivate(request.runtimeSessionId);
          case "select": {
            const candidates = resolveRuntimeInstanceCandidates({
              ...request.input,
              dispatchState: instanceScheduling,
            });
            if (!request.input.dryRun && candidates[0]) instanceScheduling.recordDispatch(candidates[0]);
            return candidates;
          }
        }
        throw Object.assign(new Error("Unknown runtime instance scheduling operation."), { code: "invalid_command" });
      }
      case "currentAccessToken": {
        const requestId = call.payload as string | null,
          resolver =
            requestId === null
              ? input.bootstrap?.keycloakAuthorization?.session?.currentAccessToken
              : sessionTokens.get(requestId)?.resolve;
        if (!resolver) throw new Error("Writer session token resolver is unavailable");
        return resolver();
      }
      case "retainCurrentAccessToken": {
        const session = sessionTokens.get(call.payload as string);
        if (!session) throw new Error("Writer session token resolver is unavailable");
        session.references += 1;
        return;
      }
      case "releaseCurrentAccessToken":
        releaseSessionToken(call.payload as string);
        return;
      case "keycloakSession": {
        const { provider: _provider, ...session } = await input.keycloakSession!(call.payload as string);
        return session;
      }
      case "keycloakCenter": {
        const { provider: _provider, ...credential } = await input.keycloakCenter!(
          call.payload === null ? undefined : (call.payload as string),
        );
        return credential;
      }
      case "cloudRuntimeRequest": {
        const [hostId, method, params] = call.payload as Parameters<
          NonNullable<RepoCellOpenInput["cloudRuntime"]>["request"]
        >;
        const signal = AbortSignal.timeout(Math.max(1, params.deadline - Date.now()));
        try {
          return await waitForSandboxReply(input.cloudRuntime!.request(hostId, method, params, signal), signal);
        } catch (error) {
          throw new CloudSandboxTransportFailure(signal.aborted || isRetryableSandboxFailure(error));
        }
      }
      case "prepareRuntimeLaunch": {
        const payload = call.payload as {
          instanceId: string;
          request: Parameters<NonNullable<RepoCellOpenInput["prepareRuntimeLaunch"]>>[1];
        };
        return input.prepareRuntimeLaunch!(payload.instanceId, payload.request);
      }
      case "reclaimRuntimeTempDirectory": {
        const payload = call.payload as { instanceId: string; runtimeSessionId: string };
        const error = input.reclaimRuntimeTempDirectory!(payload.instanceId, payload.runtimeSessionId);
        return error ? serializeWriterError(error) : null;
      }
      case "listRuntimeTempSessionIds":
        return input.listRuntimeTempSessionIds!();
      case "reclaimSettledRuntimeTempDirectories":
        return input.reclaimSettledRuntimeTempDirectories!(call.payload as readonly string[]).map((failure) => ({
          ...failure,
          error: serializeWriterError(failure.error),
        }));
      case "prepareDaemonGitEnvironment": {
        // The host supplies the cell namespace; a worker cannot select another repository's binding.
        const payload = call.payload as { instanceId: string; provider?: "github" | "gitlab" };
        return input.prepareDaemonGitEnvironment!(payload.instanceId, payload.provider ?? "github", input.repoId);
      }
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
        launched.onExit((code, lossReason) => {
          activePost({ processId: payload.processId, kind: "exit", code, ...(lossReason ? { lossReason } : {}) });
          // Provider exit precedes process-tree settlement. Retain its stop capability until
          // runtimeTerminateTree consumes it, including normal exits and cancellation.
          if (!launched.terminateTree) runtimeProcesses.delete(payload.processId);
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
        return Promise.resolve(runtimeProcesses.get(processId)?.terminateTree?.()).then(() => {
          runtimeProcesses.delete(processId);
          return null;
        });
      }
      case "runtimeLiveDescendantPids": {
        const processId = (call.payload as { processId: string }).processId;
        return Promise.resolve(runtimeProcesses.get(processId)?.liveDescendantPids?.()).then(
          (value) => value ?? { available: false },
        );
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
    }
  }

  function releaseSessionToken(requestId: string): void {
    const session = sessionTokens.get(requestId);
    if (session && --session.references === 0) sessionTokens.delete(requestId);
  }

  function activePost(event: Omit<RuntimeProcessEventV1, "schema">): void {
    worker?.postMessage({
      schema: "harness-repo-writer-runtime-process-event/v1",
      ...event,
    } satisfies RuntimeProcessEventV1);
  }
}

function phaseForWriterMethod(method: RepoWriterRequestV1["method"]): string {
  return method === "catalog" || method === "hasBuiltinExecutor" ? "projection-read" : "write-execution";
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

function bootstrapMessage(
  input: RepoCellOpenInput,
  canonicalStore: boolean,
  writerGeneration: number,
  readyWatchdogState: SharedArrayBuffer,
): RepoWriterBootstrapV1 {
  const userRoot = input.userRoot ?? input.runtimeDaemonRoute?.userRoot;
  return {
    schema: "harness-repo-writer-bootstrap/v1",
    protocolVersion: REPO_WRITER_PROTOCOL_VERSION,
    readyWatchdogState,
    config: {
      ...(input.storage ? { storage: input.storage } : {}),
      repoId: input.repoId,
      rootDir: input.rootDir,
      ...(userRoot ? { userRoot } : {}),
      ownerId: input.ownerId,
      writerGeneration,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.authoredBranch ? { authoredBranch: input.authoredBranch } : {}),
      ...(input.runtimeDaemonRoute ? { runtimeDaemonRoute: input.runtimeDaemonRoute } : {}),
      ...(input.cloudRuntime ? { cloudRuntimeTargets: input.cloudRuntime.instanceTargets } : {}),
      ...(input.runtimeInstanceCapacities ? { runtimeInstanceCapacities: input.runtimeInstanceCapacities } : {}),
      ...(input.bootstrap
        ? {
            bootstrap: {
              ...input.bootstrap,
              keycloakAuthorization: input.bootstrap.keycloakAuthorization
                ? serializableKeycloakAuthorization(input.bootstrap.keycloakAuthorization)
                : undefined,
            },
          }
        : {}),
      ...(input.defaultWriterEpochFence ? { defaultWriterEpochFence: input.defaultWriterEpochFence } : {}),
    },
    capabilities: {
      runtimeInstanceScheduling: true,
      channelOutbound: true,
      canonicalStore,
      now: input.now !== undefined,
      killpoint: input.killpoint !== undefined,
      shouldStop: input.shouldStop !== undefined,
      runtimeInstances: input.runtimeInstances !== undefined,
      keycloakCenter: input.keycloakCenter !== undefined,
      keycloakSession: input.keycloakSession !== undefined,
      prepareRuntimeLaunch: input.prepareRuntimeLaunch !== undefined,
      reclaimRuntimeTempDirectory: input.reclaimRuntimeTempDirectory !== undefined,
      listRuntimeTempSessionIds: input.listRuntimeTempSessionIds !== undefined,
      reclaimSettledRuntimeTempDirectories: input.reclaimSettledRuntimeTempDirectories !== undefined,
      prepareDaemonGitEnvironment: input.prepareDaemonGitEnvironment !== undefined,
      // Runtime worker hosts belong to the daemon process, not the replaceable
      // writer thread, so the daemon can reap them after a Cell restart.
      runtimeLaunch: true,
      runtimeSignal: input.onRuntimeSignal !== undefined,
    },
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("RepoWriterCell request was aborted"), { name: "AbortError" });
}

function writerWorkerUrl(moduleUrl: string | URL = import.meta.url, storage?: DaemonStorageConfig): URL {
  const currentModuleUrl = new URL(moduleUrl),
    extension = path.extname(fileURLToPath(currentModuleUrl));
  return new URL(`../writer-cell/${daemonWriterEntryName(storage)}${extension}`, currentModuleUrl);
}

class CloudSandboxTransportFailure extends Error {
  readonly data: { readonly retryable: boolean };
  constructor(retryable: boolean) {
    super("Cloud sandbox transport request failed.");
    this.data = { retryable };
  }
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
  if (next.phase === "recovering" || next.phase === "restoring-runtimes")
    return next.applied !== null && (previous.applied === null || next.applied > previous.applied);
  if (next.phase === "catching-up")
    return next.watermark !== null && (previous.watermark === null || next.watermark > previous.watermark);
  return false;
}

function attachProgressAllowsWatchdog(previous: RepoCellAttachProgress | null, next: RepoCellAttachProgress): boolean {
  if (previous === null) return false;
  if (attachPhaseOrder(next.phase) < attachPhaseOrder(previous.phase)) return false;
  if (next.phase !== previous.phase || next.phase === "opening") return true;
  const nextApplied = next.phase === "catching-up" ? next.watermark : next.applied,
    previousApplied = previous.phase === "catching-up" ? previous.watermark : previous.applied;
  if (nextApplied === null || previousApplied === null) return nextApplied === previousApplied;
  return nextApplied >= previousApplied;
}

function attachPhaseOrder(phase: RepoCellAttachProgress["phase"]): number {
  return phase === "opening" ? 0 : phase === "recovering" ? 1 : phase === "catching-up" ? 2 : 3;
}
function isCapabilityCall(value: unknown): value is RepoWriterCapabilityCallV1 {
  return isWriterSupervisorMessageRecord(value) && value.schema === "harness-repo-writer-capability-call/v1";
}
function isWriterSupervisorMessageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
