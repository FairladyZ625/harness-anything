import { adoptRuntimes } from "./runtime-spawn-adoption.ts";
import { readDispatchStreamSummary } from "./dispatch-stream.ts";
import { runtimeErrorCode, runtimeErrorMessage } from "./runtime-spawn-errors.ts";
import { applied } from "./runtime-spawn-settlement.ts";
import type { TaskWorktreeCheckout } from "./task-worktree.ts";
import type { RuntimeSpawnerInput } from "./runtime-spawn-types.ts";
import { runtimeResourceBlocks } from "./runtime-resource-admission.ts";
import { runtimeResourceFields } from "./runtime-resource-settings.ts";
import { createHash } from "node:crypto";
import type { AgentRuntimeEventV1 } from "@harness-anything/kernel";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";

type Queued = Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_queued" }>["payload"];
type Entry = { published?: JsonObject; value: Queued; binding: RuntimeBinding; revision: number; preparing: boolean };

/** Queue publications run in the fenced writer turn; waiting and workspace preparation never do. */
export function makeRuntimeResourceRequests(context: RuntimeSpawnerContext) {
  const requests = new Map<string, Entry>();
  let closed = false;
  const receipt = (value: Queued): JsonObject => ({
    outcome: "applied",
    dispatchStatus: value.terminal ?? "queued",
    dispatchId: value.dispatchId,
    runtimeSessionId: value.runtimeSessionId,
    queue: value as unknown as JsonObject,
  });
  const publish = async (entry: Entry) => {
    const result = await context.publishRuntimeEvent(
      "runtime_dispatch_queued",
      entry.value,
      `runtime-queue-${entry.value.runtimeSessionId}-${entry.revision++}`,
      entry.binding,
    );
    entry.published = { ...result.receipt, ...receipt(entry.value) };
    return entry.published;
  };
  const fail = async (entry: Entry, cause: unknown) => {
    try {
      if (!entry.value.terminal) {
        entry.value = {
          ...entry.value,
          terminal: "failed",
          detail: runtimeErrorMessage(cause),
          failureCode: runtimeErrorCode(cause),
        };
        await publish(entry);
      }
    } finally {
      requests.delete(entry.value.runtimeSessionId);
      await context.input.resourceAdmission!.release(entry.value.runtimeSessionId);
    }
  };
  const timer = setInterval(() => {
    if (!requests.size || closed) return;
    for (const entry of requests.values()) {
      if (entry.preparing || entry.value.terminal) continue;
      context.input.schedule(async () => {
        if (entry.preparing || entry.value.terminal || !requests.has(entry.value.runtimeSessionId)) return;
        const state = await context.input.resourceAdmission!.read(),
          now = context.input.now();
        entry.value = {
          ...entry.value,
          nextCheckAt: new Date(Date.parse(now) + runtimeResourceFields.sampleIntervalMs.defaultValue).toISOString(),
          overdue:
            Date.parse(now) - Date.parse(entry.value.queuedSince) >= runtimeResourceFields.overdueAfterMs.defaultValue,
          blocks: state.sample
            ? runtimeResourceBlocks(state.sample, state.limits, state.active)
            : [{ metric: "sampling", observed: null, threshold: state.limits.minCpuIdle }],
        };
        await publish(entry);
      }, entry.binding);
    }
  }, runtimeResourceFields.sampleIntervalMs.defaultValue);
  timer.unref();
  const api = {
    async spawn(
      payload: JsonObject,
      binding: RuntimeBinding,
      start: (worktree: TaskWorktreeCheckout | null) => Promise<JsonObject>,
      worktree: TaskWorktreeCheckout | null,
    ) {
      if (
        !context.input.resourceAdmission ||
        context.input.remote ||
        payload.dryRun === true ||
        typeof payload.dispatchId === "string"
      )
        return start(worktree);
      const result = await api.request(payload, binding, async () => worktree, start);
      return payload.permissionMode === "read-only"
        ? { ...result, ledgerAccess: "unavailable", reportDelivery: "stdout" }
        : result;
    },
    bindSpawn(
      start: (
        payload: JsonObject,
        binding: RuntimeBinding,
        worktree: TaskWorktreeCheckout | null,
      ) => Promise<JsonObject>,
    ) {
      return (payload: JsonObject, binding: RuntimeBinding, worktree: TaskWorktreeCheckout | null = null) =>
        api.spawn(payload, binding, (prepared) => start(payload, binding, prepared), worktree);
    },
    async request<T>(
      payload: JsonObject,
      binding: RuntimeBinding,
      prepare: () => Promise<T>,
      start: (prepared: T) => Promise<JsonObject>,
    ): Promise<JsonObject> {
      const host = context.input.resourceAdmission;
      if (!host) return start(await prepare());
      if (typeof payload.idempotencyKey !== "string" || !payload.idempotencyKey)
        throw new Error("Runtime idempotencyKey is required");
      const hash = createHash("sha256").update(`${context.input.repoId}\0${payload.idempotencyKey}`).digest("hex"),
        runtimeSessionId = `runtime_${hash.slice(24, 48)}`;
      const existing = requests.get(runtimeSessionId);
      if (existing) return existing.published!;
      const projection = context.requiredRuntimeProjection(context.input);
      const previous = (projection.readRuntimeQueue?.() ?? []).find(
        (event) => event.payload.runtimeSessionId === runtimeSessionId,
      );
      const dispatched = projection.readRuntimeDispatch(runtimeSessionId);
      const replay = previous ?? dispatched;
      if (replay) {
        const store = context.requiredRuntimeStore(context.input);
        return {
          ...applied(context, replay, store.publication(replay), runtimeSessionId, replay.payload.dispatchId),
          ...(previous ? receipt(previous.payload) : {}),
          replayed: true,
        };
      }
      const state = await host.read(),
        now = context.input.now();
      const entry: Entry = {
        value: {
          dispatchId: `dispatch_${hash.slice(0, 24)}`,
          runtimeSessionId,
          idempotencyKey: payload.idempotencyKey,
          taskId: typeof payload.taskId === "string" ? payload.taskId : null,
          executionId: typeof payload.executionId === "string" ? payload.executionId : null,
          agentId: typeof payload.agentId === "string" ? payload.agentId : null,
          nodeId: state.nodeId,
          queuedSince: now,
          nextCheckAt: new Date(Date.parse(now) + runtimeResourceFields.sampleIntervalMs.defaultValue).toISOString(),
          overdue: false,
          blocks: state.sample
            ? runtimeResourceBlocks(state.sample, state.limits, state.active)
            : [{ metric: "sampling", observed: null, threshold: state.limits.minCpuIdle }],
          terminal: null,
          detail: null,
          failureCode: null,
        },
        binding,
        revision: 0,
        preparing: false,
      };
      const result = await publish(entry);
      requests.set(runtimeSessionId, entry);
      void host
        .acquire(runtimeSessionId, now)
        .then(async (admitted) => {
          if (!admitted) return;
          if (closed || entry.value.terminal) {
            requests.delete(runtimeSessionId);
            await host.release(runtimeSessionId);
            return;
          }
          entry.preparing = true;
          const prepared = await prepare();
          if (closed) {
            requests.delete(runtimeSessionId);
            await host.release(runtimeSessionId);
            return;
          }
          context.input.schedule(async () => {
            try {
              if (entry.value.terminal || closed) {
                requests.delete(runtimeSessionId);
                await host.release(runtimeSessionId);
                return;
              }
              await start(prepared);
              requests.delete(runtimeSessionId);
            } catch (cause) {
              await fail(entry, cause);
              throw cause;
            }
          }, binding);
        })
        .catch((cause: unknown) => {
          context.input.schedule(async () => {
            await fail(entry, cause);
            throw cause;
          }, entry.binding);
        });
      return result;
    },
    async cancel(runtimeSessionId: string, binding: RuntimeBinding): Promise<JsonObject | null> {
      const entry = requests.get(runtimeSessionId),
        host = context.input.resourceAdmission;
      if (!entry || !host) return null;
      if (binding.actor.principal.personId !== entry.binding.actor.principal.personId)
        throw Object.assign(new Error("Queued runtime belongs to another owner."), {
          code: "execution_scope_mismatch",
        });
      await host.cancel(runtimeSessionId);
      entry.value = { ...entry.value, terminal: "cancelled", detail: "Cancelled before provider launch." };
      const result = await publish(entry);
      if (!entry.preparing) {
        requests.delete(runtimeSessionId);
        await host.release(runtimeSessionId);
      }
      return result;
    },
    async adopt(onProgress?: (completed: number) => void) {
      await api.interrupt();
      return adoptRuntimes(context, onProgress, { sweepTempDirectories: true });
    },
    async interrupt() {
      if (!context.input.resourceAdmission || context.input.remote) return;
      for (const event of context.requiredRuntimeProjection(context.input).readRuntimeQueue?.() ?? []) {
        if (event.payload.terminal !== null || event.source !== "local") continue;
        if (readDispatchStreamSummary(context.input.rootDir, event.payload.dispatchId)?.process) continue;
        await publish({
          value: {
            ...event.payload,
            terminal: "interrupted",
            detail: "Daemon restarted before launch; dispatch again with a new idempotency key.",
          },
          binding: { actor: event.actor, source: event.source },
          revision: event.workspaceRevision + 1,
          preparing: false,
        });
      }
    },
    close() {
      closed = true;
      clearInterval(timer);
      for (const key of requests.keys()) void context.input.resourceAdmission?.cancel(key);
    },
  };
  return api;
}

export function withRuntimeResourceLifetime(input: RuntimeSpawnerInput): RuntimeSpawnerInput {
  return {
    ...input,
    onAttemptTerminal: async (terminal) => {
      try {
        await input.onAttemptTerminal?.(terminal);
      } finally {
        await input.resourceAdmission?.release(terminal.runtimeSessionId);
      }
    },
  };
}
