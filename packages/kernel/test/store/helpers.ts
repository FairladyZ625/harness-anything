import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { Exit } from "effect";
import { taskEntityId } from "../../src/domain/index.ts";
import type { WriteOp } from "../../src/ports/index.ts";

export function withTempStore<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-kernel-store-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

export async function withTempStoreAsync<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-kernel-store-"));
  try {
    return await fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

export async function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await new Promise<Exit.Exit<A, E>>((resolve) => {
    Effect.runCallback(effect, { onExit: resolve });
  });
  if (exit._tag === "Success") return exit.value;
  throw new Error(String(exit.cause));
}

export function docWrite(opId: string, taskId: string, documentPath: string, body: string): WriteOp {
  return {
    opId,
    entityId: taskEntityId(taskId),
    kind: "doc_write",
    payload: {
      path: documentPath,
      body
    }
  };
}

// ADR-0016 D2: delta-shaped progress_append op (journal stores only the append text).
export function progressAppendDelta(opId: string, taskId: string, text: string): WriteOp {
  return {
    opId,
    entityId: taskEntityId(taskId),
    kind: "progress_append",
    payload: {
      path: "progress.md",
      append: text
    }
  };
}

// Legacy full-snapshot progress_append op (pre-ADR-0016 payload shape).
export function progressAppendSnapshot(opId: string, taskId: string, body: string): WriteOp {
  return {
    opId,
    entityId: taskEntityId(taskId),
    kind: "progress_append",
    payload: {
      path: "progress.md",
      body
    }
  };
}
