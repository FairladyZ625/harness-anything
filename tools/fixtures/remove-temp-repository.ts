import { rmSync } from "node:fs";
import { closeSqliteEventStoresUnder, closeTaskProjectionsUnder } from "@harness-anything/storage/sqlite";

const WINDOWS_RM_MAX_RETRIES = 20;
const WINDOWS_RM_RETRY_DELAY_MS = 100;

/** After the fixture has stopped its writers, close in-process SQLite owners before deleting its root. */
export function removeTempRepository(rootDir: string): void {
  closeTaskProjectionsUnder(rootDir);
  closeSqliteEventStoresUnder(rootDir);
  rmSync(
    rootDir,
    process.platform === "win32"
      ? { recursive: true, force: true, maxRetries: WINDOWS_RM_MAX_RETRIES, retryDelay: WINDOWS_RM_RETRY_DELAY_MS }
      : { recursive: true, force: true },
  );
}
