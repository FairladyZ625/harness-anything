import type { DatabaseSync } from "node:sqlite";
import { normalizeHistoricalPresetSnapshot } from "@harness-anything/kernel/internal/domain/historical-event-normalization.ts";
import { canonicalJson, queryRow, runSql } from "./rebuildable-task-projection-sql.ts";

/**
 * A digest names one snapshot. A row an older build stored before today's historical normalization
 * is compared in normalized form and rewritten; any other difference is a conflict (returns false).
 */
export function upsertPresetSnapshot(db: DatabaseSync, digest: string, revision: number, valueJson: string): boolean {
  const stored = queryRow<{ readonly value_json: string }>(
    db,
    "SELECT value_json FROM preset_snapshot WHERE digest = ?",
    digest,
  )?.value_json;
  if (stored === undefined)
    runSql(
      db,
      "INSERT INTO preset_snapshot(digest, workspace_revision, value_json) VALUES (?, ?, ?)",
      digest,
      revision,
      valueJson,
    );
  else if (stored !== valueJson) {
    if (canonicalJson(normalizeHistoricalPresetSnapshot(JSON.parse(stored))) !== valueJson) return false;
    runSql(db, "UPDATE preset_snapshot SET value_json = ? WHERE digest = ?", valueJson, digest);
  }
  return true;
}
