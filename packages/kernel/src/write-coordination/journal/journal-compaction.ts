import { readDurableTextIfExists, writeFileDurably } from "./durable.ts";
import type {
  ApplyMarkerRecord,
  DeleteAuditRecord,
  LockTakeoverRecord,
  ReadableJournalRecord
} from "./types.ts";

export function compactJournalAndCanTrimWatermark(
  journalPath: string,
  coveredOpIds: ReadonlySet<string>,
  confirmedAttributionOpIds: ReadonlySet<string>
): boolean {
  try {
    return compactJournalDurably(
      journalPath,
      coveredOpIds,
      confirmedAttributionOpIds
    );
  } catch {
    // Compaction is an optimization. The watermark is authoritative for replay,
    // so a failed compaction must not turn a committed flush into a failure.
    return false;
  }
}

function compactJournalDurably(
  journalPath: string,
  coveredOpIds: ReadonlySet<string>,
  confirmedAttributionOpIds: ReadonlySet<string>
): boolean {
  const body = readDurableTextIfExists(journalPath);
  if (body === null) return true;
  if (body.trim().length === 0) return true;

  let retainedCoveredWrite = false;
  const retained = body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const parsed = JSON.parse(line) as Partial<
        ReadableJournalRecord | LockTakeoverRecord | DeleteAuditRecord | ApplyMarkerRecord
      >;
      if (parsed.schema !== "write-journal/v1"
        && parsed.schema !== "write-journal/v2"
        && parsed.schema !== "apply-marker/v1") return true;
      if (parsed.schema === "write-journal/v2"
        && typeof parsed.opId === "string"
        && !confirmedAttributionOpIds.has(parsed.opId)) {
        if (coveredOpIds.has(parsed.opId)) retainedCoveredWrite = true;
        return true;
      }
      return typeof parsed.opId !== "string" || !coveredOpIds.has(parsed.opId);
    });
  writeFileDurably(
    journalPath,
    retained.length === 0 ? "" : `${retained.join("\n")}\n`
  );
  return !retainedCoveredWrite;
}
