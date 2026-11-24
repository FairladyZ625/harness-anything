import { rmSync } from "node:fs";
import {
  closeSqliteEventStoresUnder,
  closeTaskProjectionsUnder,
  closeWriterEpochFenceDescriptorsUnder,
} from "@harness-anything/storage/sqlite";

const WINDOWS_RM_MAX_ATTEMPTS = 50;
const WINDOWS_RM_RETRY_DELAY_MS = 150;
const RETRYABLE_WINDOWS_RM_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/** After the fixture has stopped its writers, close in-process SQLite owners before deleting its root. */
export function removeTempRepository(rootDir: string): void {
  closeWriterEpochFenceDescriptorsUnder(rootDir);
  closeTaskProjectionsUnder(rootDir);
  closeSqliteEventStoresUnder(rootDir);
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
      closeWriterEpochFenceDescriptorsUnder(rootDir);
      closeTaskProjectionsUnder(rootDir);
      closeSqliteEventStoresUnder(rootDir);
      Atomics.wait(sleepBuffer, 0, 0, WINDOWS_RM_RETRY_DELAY_MS);
    }
  }
}
