import { cloudSandboxPolicy } from "@harness-anything/kernel/internal/domain/runtime-execution-target.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  isRetryableSandboxFailure,
  sandboxStopMatches,
  waitForSandboxReply,
  type CloudRuntimeRegistration,
  type CloudSandboxAttempt,
  type CloudSandboxFrame,
  type CloudSandboxLaunch,
  type CloudSandboxSteer,
  type CloudSandboxStopped,
} from "@harness-anything/application/internal/commands/runtime-execution-target.ts";
import type { CloudRuntimeExecutionTarget } from "@harness-anything/kernel/internal/domain/runtime-execution-target.ts";
import {
  appendRuntimeWorkerRecord,
  parseRecord,
  scrubProviderValue,
  type DispatchStreamRecord,
} from "./dispatch-stream.ts";
import type { CloudRuntimeProcess, RuntimeSteerOutcome } from "./runtime-spawn-types.ts";

const budget = cloudSandboxPolicy.defaultValue;

export function openCloudRuntime(input: {
  readonly rootDir: string;
  readonly target: CloudRuntimeExecutionTarget;
  readonly attempt: CloudSandboxAttempt;
  readonly registration: CloudRuntimeRegistration | undefined;
  readonly now: () => string;
  readonly launch?: CloudSandboxLaunch;
  readonly stopping?: boolean;
  readonly records?: readonly DispatchStreamRecord[];
}): CloudRuntimeProcess {
  const lifetime = new AbortController(),
    { attempt, rootDir, now } = input,
    { dispatchId } = attempt,
    pending = new Map<string, CloudSandboxSteer>();
  let cursor = 0,
    proof: CloudSandboxStopped | undefined,
    live: boolean | undefined;
  let onOutput: Parameters<CloudRuntimeProcess["onOutput"]>[0] | undefined,
    onError: Parameters<CloudRuntimeProcess["onErrorOutput"]>[0] | undefined,
    onSteer: ((outcome: RuntimeSteerOutcome) => void) | undefined,
    onLiveness: Parameters<CloudRuntimeProcess["cloud"]["onLiveness"]>[0] | undefined;
  let stopping = input.stopping === true;
  for (const record of input.records ?? []) {
    if (typeof record.sandboxSequence === "number") cursor = Math.max(cursor, record.sandboxSequence);
    if (
      record.kind === "sandbox_stopped" &&
      record.stopProof &&
      sandboxStopMatches(attempt, record.stopProof as CloudSandboxStopped)
    )
      proof = record.stopProof as CloudSandboxStopped;
    if (record.kind === "steer_requested") {
      const steer = steerFromRecord(record);
      if (steer) pending.set(steer.opId, steer);
    }
    if ((record.kind === "steer_resumed" || record.kind === "steer_dropped") && typeof record.opId === "string")
      pending.delete(record.opId);
  }
  const persist = (record: DispatchStreamRecord) =>
    appendRuntimeWorkerRecord(rootDir, dispatchId, { ...record, occurredAt: now() });

  const applyProof = (receipt: CloudSandboxStopped) => {
    if (!sandboxStopMatches(attempt, receipt)) throw new Error("Cloud sandbox stop receipt names a different attempt.");
    if (lifetime.signal.aborted) return;
    if (!proof) persist({ kind: "sandbox_stopped", stopProof: receipt });
    proof ??= receipt;
  };

  const invoke: CloudRuntimeRegistration["request"] = async (hostId, method, params, signal) => {
    if (!input.registration) throw new Error("Cloud sandbox host registration is unavailable.");
    const deadline = params.deadline;
    for (let index = 0; ; index += 1) {
      const callDeadline = Math.min(deadline, Date.now() + budget.transportTimeoutMs);
      const callSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, callDeadline - Date.now()))]);
      const result = await waitForSandboxReply(
        input.registration.request(hostId, method, { ...params, deadline: callDeadline }, callSignal),
        callSignal,
      ).then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
      if (result.ok) return result.value;
      const canRetry = callSignal.aborted || isRetryableSandboxFailure(result.error);
      if (!canRetry || signal.aborted || index + 1 >= budget.retryLimit || Date.now() >= deadline) throw result.error;
      await delay(Math.min(deadline - Date.now(), budget.retryBaseMs * 2 ** index * (0.5 + Math.random())), undefined, {
        signal,
      });
    }
  };

  const key = (op: string) => ({
    attempt,
    idempotencyKey: JSON.stringify([attempt.repoId, dispatchId, attempt.attempt, op]),
    deadline: Date.now() + budget.operationBudgetMs,
  });

  const observeLiveness = async (value: boolean) => {
    if (live === value || stopping || lifetime.signal.aborted) return;
    await onLiveness?.(value);
    live = value;
  };

  const sendSteerOutcome = (request: CloudSandboxSteer, status: "applied" | "rejected", sequence?: number) => {
    persist({
      kind: status === "applied" ? "steer_resumed" : "steer_dropped",
      opId: request.opId,
      version: request.version,
      ...(request.controlRequestId ? { controlRequestId: request.controlRequestId } : {}),
      ...(request.requestOpId ? { requestOpId: request.requestOpId } : {}),
      ...(sequence === undefined ? {} : { sandboxSequence: sequence }),
    });
    pending.delete(request.opId);
    if (request.controlRequestId && request.requestOpId)
      onSteer?.({
        status,
        controlRequestId: request.controlRequestId,
        requestOpId: request.requestOpId,
        steerVersion: request.version,
        ...(status === "rejected" ? { reasonCode: "steer_dropped" } : {}),
      });
  };

  async function accept(frame: CloudSandboxFrame) {
    if (frame.sequence !== cursor + 1) throw new Error("Cloud sandbox event sequence is not contiguous.");
    switch (frame.kind) {
      case "stdout": {
        if (
          typeof frame.line !== "string" ||
          Buffer.byteLength(frame.line) > budget.frameLimitBytes ||
          /[\r\n]/u.test(frame.line)
        )
          throw new Error("Cloud sandbox stdout frame is invalid.");
        const event = parseRecord(frame.line);
        const safeEvent = event === null ? undefined : scrubProviderValue(event);
        persist({
          sandboxSequence: frame.sequence,
          ...(safeEvent === undefined
            ? { kind: "provider_output_invalid", output: scrubProviderValue(frame.line) }
            : { kind: "provider_event", event: safeEvent }),
        });
        cursor = frame.sequence;
        if (!stopping)
          await onOutput?.(
            safeEvent === undefined ? `${String(scrubProviderValue(frame.line))}\n` : `${JSON.stringify(safeEvent)}\n`,
            true,
          );
        return;
      }
      case "stderr": {
        if (typeof frame.chunk !== "string" || Buffer.byteLength(frame.chunk) > budget.frameLimitBytes)
          throw new Error("Cloud sandbox stderr frame is invalid.");
        const chunk = String(scrubProviderValue(frame.chunk));
        persist({ kind: "provider_stderr", chunk, sandboxSequence: frame.sequence });
        cursor = frame.sequence;
        if (!stopping) await onError?.(chunk);
        return;
      }
      case "steer": {
        if (frame.result !== "applied" && frame.result !== "rejected")
          throw new Error("Cloud sandbox steer result is invalid.");
        const request = pending.get(frame.opId);
        if (!request) throw new Error("Cloud sandbox steer result has no matching request.");
        sendSteerOutcome(request, frame.result, frame.sequence);
        cursor = frame.sequence;
        return;
      }
      default:
        throw new Error("Unknown cloud sandbox frame.");
    }
  }

  async function observe(exit: Parameters<CloudRuntimeProcess["onExit"]>[0]) {
    const signal = lifetime.signal,
      hostId = input.target.hostId;
    let lastSentVersion = 0,
      readFailures = 0;
    if (input.launch && !proof) {
      const accepted = await invoke(hostId, "sandbox.start", { ...key("start"), launch: input.launch }, signal).then(
        (started) => started?.accepted === true,
        () => false,
      );
      if (!accepted) await observeLiveness(false);
    }
    while (!signal.aborted && !proof) {
      await (async () => {
        if (!stopping) {
          for (const request of pending.values()) {
            if (request.version <= lastSentVersion) continue;
            lastSentVersion = request.version;
            const accepted = await invoke(
              hostId,
              "sandbox.steer",
              { ...key(request.opId), steer: request },
              signal,
            ).then(
              (steered) => steered?.accepted === true,
              () => false,
            );
            if (!accepted && !signal.aborted)
              console.error("[runtime-cloud] steer result unavailable", dispatchId, request.opId);
            // A lost reply cannot settle the steer. Its correlated stream frame remains authoritative.
            break;
          }
        }
        const page = await invoke(
          hostId,
          "sandbox.read",
          { ...key(`read:${cursor}`), after: cursor, limit: budget.pageSize },
          signal,
        );
        if (signal.aborted || proof) return;
        if (!Array.isArray(page?.frames) || page.frames.length > budget.pageSize || typeof page.live !== "boolean")
          throw new Error("Cloud sandbox event page exceeds the requested limit.");
        if (!page.stopped) await observeLiveness(page.live === true);
        for (const frame of page.frames) {
          if (signal.aborted || proof) break;
          await accept(frame);
        }
        if (page.stopped) applyProof(page.stopped);
        readFailures = 0;
        if (!proof && (page.frames.length < budget.pageSize || stopping))
          await delay(budget.pollMs, undefined, { signal, ref: false });
      })().catch(async () => {
        if (!signal.aborted) {
          await observeLiveness(false);
          const nextExponent = Math.min(readFailures + 1, budget.pollFailureExponentLimit);
          readFailures = nextExponent;
          await delay(budget.pollMs * 2 ** readFailures * (0.5 + Math.random()), undefined, { signal, ref: false });
        }
      });
    }
    if (proof && !signal.aborted) exit(proof.exitCode);
  }

  return {
    onOutput: (listener) => {
      onOutput = listener;
    },
    onErrorOutput: (listener) => {
      onError = listener;
    },
    onSteerOutcome: (listener) => {
      onSteer = listener;
    },
    onExit: (listener) => {
      void observe(listener).catch(() => {
        if (!lifetime.signal.aborted) console.error("[runtime-cloud] stream observation unavailable", dispatchId);
      });
    },
    release: () => lifetime.abort(),
    cloud: {
      onLiveness: (listener) => {
        onLiveness = listener;
      },
      hasStopProof: () => proof !== undefined,
      stop: async () => {
        if (proof) return true;
        stopping = true;
        try {
          const receipt = await invoke(input.target.hostId, "sandbox.cancel", key("cancel"), lifetime.signal);
          if (receipt?.stopProof !== "proven_stopped") return false;
          applyProof(receipt);
          return proof !== undefined;
        } catch {
          console.error("[runtime-cloud] stop proof unavailable", dispatchId);
          return false;
        }
      },
      steer: (request) => {
        if (pending.size >= budget.pendingSteerLimit) sendSteerOutcome(request, "rejected");
        else pending.set(request.opId, request);
      },
    },
  };
}

function steerFromRecord(record: DispatchStreamRecord): CloudSandboxSteer | undefined {
  if (typeof record.opId !== "string" || typeof record.version !== "number" || typeof record.prompt !== "string")
    return;
  return {
    opId: record.opId,
    version: record.version,
    prompt: record.prompt,
    ...(typeof record.controlRequestId === "string" ? { controlRequestId: record.controlRequestId } : {}),
    ...(typeof record.requestOpId === "string" ? { requestOpId: record.requestOpId } : {}),
  };
}
