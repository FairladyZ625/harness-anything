import { rmSync } from "node:fs";
import {
  closeSqliteEventStoresUnder,
  closeTaskProjectionsUnder,
  closeWriterEpochFenceDescriptorsUnder,
} from "@harness-anything/storage/sqlite";

/** After the fixture has stopped its writers, close in-process SQLite owners before deleting its root. */
export function removeTempRepository(rootDir: string): void {
  closeTaskProjectionsUnder(rootDir);
  closeSqliteEventStoresUnder(rootDir);
  closeWriterEpochFenceDescriptorsUnder(rootDir);
  rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
