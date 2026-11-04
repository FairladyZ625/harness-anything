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

export interface SearchPosition {
  readonly term: string;
  readonly column: number;
  readonly offset: number;
}

// A single reusable tokenizer, containing only the current input. Document corpora are
// never built at read time. fts5vocab preserves Unicode61's exact folding and positions.
let tokenizer: DatabaseSync | undefined;
export function unicode61Positions(columns: readonly string[]): readonly SearchPosition[] {
  if (!tokenizer) {
    tokenizer = new DatabaseSync(":memory:");
    tokenizer.exec(`CREATE VIRTUAL TABLE input USING fts5(a,b,c,d,e,tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE tokens USING fts5vocab(input,instance)`);
  }
  const db = tokenizer;
  try {
    db.prepare("INSERT INTO input(rowid,a,b,c,d,e) VALUES(1,?,?,?,?,?)").run(
      columns[0] ?? "",
      columns[1] ?? "",
      columns[2] ?? "",
      columns[3] ?? "",
      columns[4] ?? "",
    );
    return db
      .prepare("SELECT term,col,offset FROM tokens ORDER BY col,offset")
      .all()
      .map((row) => ({
        term: String(row.term),
        column: "abcde".indexOf(String(row.col)),
        offset: Number(row.offset),
      }));
  } finally {
    db.exec("DELETE FROM input WHERE rowid=1");
  }
}

/** A literal phrase stays in one column and retains every position, including repetitions. */
export function phraseMatches(
  terms: readonly string[],
  rows: readonly { readonly id: string; readonly term: string; readonly column: number; readonly offset: number }[],
): readonly string[] {
  if (terms.length === 0) return [];
  const documents = new Map<string, Map<number, Map<string, Set<number>>>>();
  for (const row of rows) {
    let columns = documents.get(row.id);
    if (!columns) documents.set(row.id, (columns = new Map()));
    let words = columns.get(row.column);
    if (!words) columns.set(row.column, (words = new Map()));
    let positions = words.get(row.term);
    if (!positions) words.set(row.term, (positions = new Set()));
    positions.add(row.offset);
  }
  const matches: string[] = [];
  for (const [id, columns] of documents) {
    if (
      [...columns.values()].some((words) =>
        [...(words.get(terms[0]!) ?? [])].some((start) =>
          terms.every((term, index) => words.get(term)?.has(start + index)),
        ),
      )
    )
      matches.push(id);
  }
  return matches;
}
