import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import type { WriteOp } from "@harness-anything/kernel/internal/ports/index.ts";
import { closeTaskProjectionsUnder } from "../../src/projection/rebuildable-task-projection.ts";
import { closeSqliteEventStoresUnder } from "../../src/store/sqlite-ledger-connections.ts";
import { removeTempRepository } from "../../../../tools/fixtures/remove-temp-repository.ts";

export function withTempStore<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-kernel-store-"));
  try {
    return fn(rootDir);
  } finally {
    closeTaskProjectionsUnder(rootDir);
    closeSqliteEventStoresUnder(rootDir);
    removeTempRepository(rootDir);
  }
}

export async function withTempStoreAsync<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-kernel-store-"));
  try {
    return await fn(rootDir);
  } finally {
    closeTaskProjectionsUnder(rootDir);
    closeSqliteEventStoresUnder(rootDir);
    removeTempRepository(rootDir);
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
    entityId: `task/${taskId}`,
    kind: "doc_write",
    payload: {
      path: documentPath,
      body,
    },
  };
}
