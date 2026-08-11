import { gitText } from "./doc-sync-applied-ledger.ts";

/**
 * The row shape this reader produces. Declaring it structurally keeps the check off the
 * deep `application/doc-sync` subpath, which is under a sunset ratchet; the shape is
 * validated where doc-sync-service assigns these rows to its registry contract. This
 * mirrors what doc-sync-consumer-surface.ts and doc-sync-cas.ts already do.
 */
interface DirtyEntry {
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly path: string;
}

export function readDocSyncDirtyEntries(authoredRoot: string): ReadonlyArray<DirtyEntry> {
  const output = gitText(authoredRoot, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all",
    "--", ".", ":(exclude).harness"
  ]) ?? "";
  const records = output.split("\0");
  const entries: DirtyEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const code = record.slice(0, 2);
    entries.push(parsePorcelainRecord(record));
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return entries;
}

function parsePorcelainRecord(record: string): DirtyEntry {
  const code = record.slice(0, 2);
  const status = code === "??" || code.includes("A")
    ? "added"
    : code.includes("D") ? "deleted" : code.includes("R") ? "renamed" : "modified";
  return { status, path: record.slice(3) };
}
