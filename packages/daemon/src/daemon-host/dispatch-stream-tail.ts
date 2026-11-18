import { readSync } from "node:fs";

/**
 * Bounded backward scan over the tail of a JSON-lines file. Kept out of `dispatch-stream.ts` (the
 * writer plus the stream's record vocabulary) because the byte-boundary handling below is a
 * self-contained concern with its own failure mode, not stream schema knowledge.
 */

// A usage frame is a few hundred bytes and a runtime_metrics record is under 1 KiB; a JSONL line
// larger than this is a provider transcript payload, never the latest record a tail reader wants.
// Buffering one just to fail JSON would bound nothing, so an oversized line yields no candidate.
const maxScannedLineBytes = 512 * 1024;
const scanStepBytes = 4 * 1024;

/**
 * Latest line within `probeBytes` of EOF for which `accept` returns non-null. `accept` receives a
 * whole line and may reject on vocabulary (kind marker) or field shape.
 *
 * Each backward step starts its window at a line start, backing up over the record that straddles
 * the nominal chunk edge. Splitting at that edge instead would take the straddling record's tail
 * for a record of its own, skip it (its head is in the previous window), and report the older
 * record before it as latest — stale data, and null when no older record exists.
 */
export function readLatestLineInTail<T>(
  descriptor: number,
  size: number,
  probeBytes: number,
  accept: (line: string) => T | null,
): T | null {
  const floor = Math.max(0, size - probeBytes),
    chunkBytes = 64 * 1024;
  for (let end = size; end > floor; ) {
    const start = Math.max(floor, lineStartAtOrBefore(descriptor, Math.max(floor, end - chunkBytes))),
      bytes = Buffer.alloc(end - start),
      read = readSync(descriptor, bytes, 0, bytes.length, start);
    if (read === 0) break;
    const lines = bytes.toString("utf8", 0, read).split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (line === "" || line.length > maxScannedLineBytes) continue;
      const value = accept(line);
      if (value !== null) return value;
    }
    end = start;
  }
  return null;
}

/** First line start at or before `boundary`, walking back in `scanStepBytes` steps. A line longer
 * than the scan cap is not a record a tail reader wants, so it reports the boundary: the resulting
 * partial line fails to parse downstream and is skipped like any other non-record. */
function lineStartAtOrBefore(descriptor: number, boundary: number): number {
  for (let end = boundary; end > 0 && boundary - end <= maxScannedLineBytes; ) {
    const start = Math.max(0, end - scanStepBytes),
      bytes = Buffer.alloc(end - start),
      read = readSync(descriptor, bytes, 0, bytes.length, start);
    if (read === 0) break;
    const newline = bytes.subarray(0, read).lastIndexOf(10);
    if (newline !== -1) return start + newline + 1;
    end = start;
  }
  return boundary;
}
