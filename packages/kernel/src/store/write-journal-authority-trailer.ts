import {
  authorityBatchTrailerName,
  buildAuthorityBatchIntegrity
} from "../integrity/authority-batch-integrity.ts";
import type { ReadableJournalRecord } from "./write-journal-types.ts";

export function authorityBatchCommitTrailer(records: ReadonlyArray<ReadableJournalRecord>): string | undefined {
  const authorityRecords = records.filter((record) => record.authorityIntegrity);
  if (authorityRecords.length === 0) return undefined;
  if (authorityRecords.length !== records.length) {
    throw new Error("authority publication cannot mix integrity-bearing and legacy operations");
  }
  const integrity = buildAuthorityBatchIntegrity(authorityRecords.map((record) => ({
    opId: record.opId,
    semanticMutationSetDigest: record.authorityIntegrity!.semanticMutationSetDigest
  })));
  return `${authorityBatchTrailerName}: ${integrity.trailerValue}`;
}

export function semanticCommitMessage(
  records: ReadonlyArray<ReadableJournalRecord>,
  summaries: ReadonlyArray<string>
): string | undefined {
  if (records.length === 0) return undefined;
  if (summaries.length !== records.length) throw new Error("commit summary count mismatch");
  const subject = summaries.length === 1
    ? `${summaries[0]} [${records[0]?.opId}]`
    : `harness write: ${summaries.slice(0, 3).join("; ")}${summaries.length > 3 ? `; +${summaries.length - 3} more` : ""} [${records.map((record) => record.opId).join(",")}]`;
  const trailer = authorityBatchCommitTrailer(records);
  return trailer ? `${subject}\n\n${trailer}` : subject;
}
