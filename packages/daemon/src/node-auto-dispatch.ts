import { consumeKnownError } from "@harness-anything/kernel";
import type { JsonObject } from "./protocol/json-rpc-types.ts";

export type NodeAutoDispatchKind = "review" | "rework";

export interface NodeAutoDispatchCandidate {
  readonly repoId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly kind: NodeAutoDispatchKind;
  readonly requiredNodeId: string;
  readonly dispatchKey: string;
  readonly payload: JsonObject;
  readonly fallbackPayload?: JsonObject;
}

export interface NodeAutoDispatchSnapshot {
  readonly schema: "node-auto-dispatch-candidates/v1";
  readonly candidates: readonly NodeAutoDispatchCandidate[];
}

export function parseNodeAutoDispatchSnapshot(value: unknown): NodeAutoDispatchSnapshot {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { readonly schema?: unknown }).schema !== "node-auto-dispatch-candidates/v1" ||
    !Array.isArray((value as { readonly candidates?: unknown }).candidates)
  )
    throw new Error("Fleet auto-dispatch snapshot is invalid.");
  const candidates = (value as { readonly candidates: unknown[] }).candidates.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("Fleet auto-dispatch candidate row is invalid.");
    const row = value as Record<string, unknown>;
    if (
      typeof row.taskId !== "string" ||
      !row.taskId ||
      typeof row.repoId !== "string" ||
      !row.repoId ||
      typeof row.executionId !== "string" ||
      !row.executionId ||
      (row.kind !== "review" && row.kind !== "rework") ||
      typeof row.requiredNodeId !== "string" ||
      !row.requiredNodeId ||
      typeof row.dispatchKey !== "string" ||
      !row.dispatchKey ||
      row.payload === null ||
      typeof row.payload !== "object" ||
      Array.isArray(row.payload) ||
      (row.fallbackPayload !== undefined &&
        (row.fallbackPayload === null || typeof row.fallbackPayload !== "object" || Array.isArray(row.fallbackPayload)))
    )
      throw new Error("Fleet auto-dispatch candidate row is invalid.");
    return row as unknown as NodeAutoDispatchCandidate;
  });
  return { schema: "node-auto-dispatch-candidates/v1", candidates };
}

export interface NodeAutoDispatchLoop {
  readonly trigger: (reason: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

export function openNodeAutoDispatchLoop(input: {
  readonly read: (signal: AbortSignal) => Promise<readonly NodeAutoDispatchCandidate[]>;
  readonly spawn: (candidate: NodeAutoDispatchCandidate, signal: AbortSignal) => Promise<void>;
}): NodeAutoDispatchLoop {
  const controllers = new Set<AbortController>();
  const accepted = new Set<string>();
  let closed = false;
  let pending: Promise<void> | null = null;
  let queued = false;
  const scan = async (): Promise<void> => {
    if (closed) return;
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const candidates = await input.read(controller.signal),
        current = new Set(candidates.map((candidate) => candidate.dispatchKey));
      for (const key of accepted) if (!current.has(key)) accepted.delete(key);
      for (const candidate of candidates) {
        if (closed) return;
        if (accepted.has(candidate.dispatchKey)) continue;
        await input.spawn(candidate, controller.signal);
        accepted.add(candidate.dispatchKey);
      }
    } catch (error) {
      if (!closed || !controller.signal.aborted) throw error;
      consumeKnownError(error);
    } finally {
      controllers.delete(controller);
    }
  };
  const trigger = async (_reason: string): Promise<void> => {
    if (closed) return;
    queued = true;
    if (pending !== null) return pending;
    pending = (async () => {
      try {
        while (queued && !closed) {
          queued = false;
          await scan();
        }
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
  return {
    trigger,
    close: async () => {
      closed = true;
      queued = false;
      for (const controller of controllers) controller.abort();
      await pending;
    },
  };
}
