import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { writeFileDurably } from "@harness-anything/storage";

interface ReplicaHealth {
  readonly rebuildCount: number;
  readonly lastHeartbeatAt: string | null;
  readonly syncFailure: { readonly code: string; readonly message: string } | null;
  readonly modelFailure: { readonly code: string; readonly message: string } | null;
}
const empty: ReplicaHealth = { rebuildCount: 0, lastHeartbeatAt: null, syncFailure: null, modelFailure: null };
const file = (viewDir: string) => path.join(viewDir, "replica-health.json");
const healthEvents = new EventEmitter();
healthEvents.setMaxListeners(0);

/** Subscribes to in-process replica health transitions for one edge view directory. */
export function subscribeReplicaHealthChange(viewDir: string, listener: () => void): () => void {
  const key = path.resolve(viewDir);
  healthEvents.on(key, listener);
  return () => {
    healthEvents.off(key, listener);
  };
}

export function notifyReplicaHealthChange(viewDir: string): void {
  healthEvents.emit(path.resolve(viewDir));
}

/** Missing observations are unknown; malformed observations are errors, never a healthy zero. */
export function readReplicaHealth(viewDir: string): ReplicaHealth {
  try {
    const value = JSON.parse(readFileSync(file(viewDir), "utf8")) as ReplicaHealth;
    const failure = (v: ReplicaHealth["syncFailure"]) =>
      v === null || (typeof v === "object" && typeof v.code === "string" && typeof v.message === "string");
    const lastHeartbeatAt = value.lastHeartbeatAt === undefined ? null : value.lastHeartbeatAt;
    if (
      !Number.isSafeInteger(value.rebuildCount) ||
      value.rebuildCount < 0 ||
      (lastHeartbeatAt !== null && typeof lastHeartbeatAt !== "string") ||
      !failure(value.syncFailure) ||
      !failure(value.modelFailure)
    )
      throw new Error("Replica health observations are malformed");
    return { ...value, lastHeartbeatAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
}

export function recordReplicaHealth(viewDir: string, change: Partial<ReplicaHealth>): void {
  const before = readReplicaHealth(viewDir),
    after = { ...before, ...change };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  writeFileDurably(file(viewDir), JSON.stringify(after));
  notifyReplicaHealthChange(viewDir);
}

export function replicaFailure(error: unknown, code: string) {
  const observed = error as { readonly code?: unknown } | null;
  return {
    code: typeof observed?.code === "string" ? observed.code : code,
    message: error instanceof Error ? error.message : String(error),
  };
}
