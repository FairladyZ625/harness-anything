import { existsSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import {
  closeSqliteEventStoresUnder,
  closeTaskProjectionsUnder,
  closeWriterEpochFenceDescriptorsUnder,
} from "@harness-anything/storage/sqlite";

const WINDOWS_RM_MAX_ATTEMPTS = 50;
const WINDOWS_RM_RETRY_DELAY_MS = 150;
const RETRYABLE_WINDOWS_RM_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function closeHandlesUnder(rootDir: string): void {
  const candidates = new Set<string>([rootDir, path.resolve(rootDir)]);
  if (existsSync(rootDir)) candidates.add(realpathSync.native(rootDir));
  for (const candidate of candidates) {
    closeWriterEpochFenceDescriptorsUnder(candidate);
    closeTaskProjectionsUnder(candidate);
    closeSqliteEventStoresUnder(candidate);
  }
}

/** After the fixture has stopped its writers, close in-process SQLite owners before deleting its root. */
export function removeTempRepository(rootDir: string): void {
  closeHandlesUnder(rootDir);
  if (process.platform !== "win32") {
    rmSync(rootDir, { recursive: true, force: true });
    return;
  }
  for (let attempt = 1; attempt <= WINDOWS_RM_MAX_ATTEMPTS; attempt += 1) {
    try {
      rmSync(rootDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { readonly code?: unknown }).code)
          : "";
      if (!RETRYABLE_WINDOWS_RM_CODES.has(code) || attempt === WINDOWS_RM_MAX_ATTEMPTS) throw error;
      closeHandlesUnder(rootDir);
      Atomics.wait(sleepBuffer, 0, 0, WINDOWS_RM_RETRY_DELAY_MS);
    }
  }
}
