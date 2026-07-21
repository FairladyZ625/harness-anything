import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, type Exit } from "effect";
import { taskEntityId, type WriteOp } from "@harness-anything/kernel";

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
