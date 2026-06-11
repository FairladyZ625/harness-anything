import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

export function docWrite(opId: string, taskId: string, documentPath: string, body: string): WriteOp {
  return {
    opId,
    taskId,
    kind: "doc_write",
    payload: {
      path: documentPath,
      body
    }
  };
}
