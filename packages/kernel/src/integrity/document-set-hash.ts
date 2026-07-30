import { normalizeRelativeDocumentPath } from "../layout/index.ts";
import { sha256Text, stablePayloadHash } from "./stable-hash.ts";

export interface DocumentSetEntry {
  readonly path: string;
  readonly body: string;
}

export function declaredDocumentSetSha256(
  documents: ReadonlyArray<DocumentSetEntry>,
  pathPrefixes: ReadonlyArray<string>
): string {
  const prefixes = normalizePrefixes(pathPrefixes);
  const entries = documents
    .filter((document) => prefixes.some((prefix) => document.path.startsWith(prefix)))
    .map((document) => ({ path: normalizeRelativeDocumentPath(document.path), bodySha256: sha256Text(document.body) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error("document set contains duplicate paths");
  }
  return stablePayloadHash({ schema: "declared-document-set/v1", pathPrefixes: prefixes, entries });
}

export function normalizeDeclaredDocumentSetPrefixes(pathPrefixes: ReadonlyArray<string>): ReadonlyArray<string> {
  return normalizePrefixes(pathPrefixes);
}

function normalizePrefixes(pathPrefixes: ReadonlyArray<string>): ReadonlyArray<string> {
  if (pathPrefixes.length === 0) throw new Error("document set path prefixes must not be empty");
  const prefixes = [...new Set(pathPrefixes.map((prefix) => {
    if (!prefix.endsWith("/")) throw new Error(`document set path prefix must end with /: ${prefix}`);
    return `${normalizeRelativeDocumentPath(`${prefix}probe`)}`.slice(0, -"probe".length);
  }))].sort();
  return prefixes;
}
