import { DatabaseSync } from "node:sqlite";
import { ftsQuery } from "../projection/fts-query.ts";

/**
 * Evaluate the existing unicode61 literal-phrase contract, including its Unicode 6.1
 * folding and column boundaries, instead of approximating it with a different tokenizer.
 * Candidates already passed PG scope/RLS at the caller's repeatable-read cut. This scratch
 * FTS index has no file, authority, or lifetime beyond this call; pagination follows matching.
 */
export function filterLiteralTextRows<T>(
  rows: readonly T[],
  query: string,
  columns: (row: T) => readonly string[],
): readonly T[] {
  if (!query.trim() || rows.length === 0) return rows;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE search USING fts5(a,b,c,d,e, tokenize='unicode61 remove_diacritics 2')");
    const insert = db.prepare("INSERT INTO search(rowid,a,b,c,d,e) VALUES (?,?,?,?,?,?)");
    rows.forEach((row, index) => {
      const fields = columns(row);
      insert.run(index + 1, fields[0] ?? "", fields[1] ?? "", fields[2] ?? "", fields[3] ?? "", fields[4] ?? "");
    });
    const matches = new Set(
      db
        .prepare("SELECT rowid FROM search WHERE search MATCH ?")
        .all(ftsQuery(query))
        .map((row) => Number(row.rowid)),
    );
    return rows.filter((_row, index) => matches.has(index + 1));
  } finally {
    db.close();
  }
}
