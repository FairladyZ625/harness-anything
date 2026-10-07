import { readFileSync } from "node:fs";
import path from "node:path";
import { writeFileDurably } from "../durable-file.ts";

interface ReplicaHealth {
  readonly rebuildCount: number;
  readonly syncFailure: { readonly code: string; readonly message: string } | null;
  readonly modelFailure: { readonly code: string; readonly message: string } | null;
}
const empty: ReplicaHealth = { rebuildCount: 0, syncFailure: null, modelFailure: null };
const file = (viewDir: string) => path.join(viewDir, "replica-health.json");

/** Missing observations are unknown; malformed observations are errors, never a healthy zero. */
export function readReplicaHealth(viewDir: string): ReplicaHealth {
  try {
    const value = JSON.parse(readFileSync(file(viewDir), "utf8")) as ReplicaHealth;
    const failure = (v: ReplicaHealth["syncFailure"]) =>
      v === null || (typeof v === "object" && typeof v.code === "string" && typeof v.message === "string");
    if (
      !Number.isSafeInteger(value.rebuildCount) ||
      value.rebuildCount < 0 ||
      !failure(value.syncFailure) ||
      !failure(value.modelFailure)
    )
      throw new Error("Replica health observations are malformed");
    return value;
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
}

export function replicaFailure(error: unknown, code: string) {
  const observed = error as { readonly code?: unknown } | null;
  return {
    code: typeof observed?.code === "string" ? observed.code : code,
    message: error instanceof Error ? error.message : String(error),
  };
}
