import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CliResult } from "../types.ts";

// The 'type:PATH:summary' format is the historical evidence shape used by
// `ha task progress append --evidence`. PATH and summary are separated by the
// second ':' in the value; summaries may contain ':' (they are rejoined after
// the split), but PATH must not. This file owns the parser and the rejection
// hint so the parser-file line budget in core-task.ts stays inside the CLI
// structure gate.

export type ParsedEvidence = { readonly type: string; readonly path: string; readonly summary: string };

export function parseEvidence(values: ReadonlyArray<string | undefined>):
  | { readonly ok: true; readonly value?: ReadonlyArray<ParsedEvidence> }
  | { readonly ok: false; readonly error: NonNullable<CliResult["error"]> } {
  if (values.length === 0) return { ok: true };
  const evidence: Array<ParsedEvidence> = [];
  for (const value of values) {
    if (!value) return { ok: false, error: cliError(CliErrorCode.InvalidEvidence, "Use --evidence type:PATH:summary.") };
    const [type, evidencePath, ...summaryParts] = value.split(":");
    if (!type || !evidencePath || summaryParts.length === 0) {
      return { ok: false, error: cliError(CliErrorCode.InvalidEvidence, "Use --evidence type:PATH:summary.") };
    }
    // The format has no way to encode ':' inside PATH. When the user passes a
    // URL (`url:https://...`) or a Windows-drive absolute path (`file:C:/...`),
    // the naive split above silently puts the scheme or drive letter in PATH
    // and the rest in summary — and the existing non-empty guard passes because
    // all three slots are filled, just with the wrong content. Detect that
    // signature and reject loudly with a copyable correct form, instead of
    // persisting a miscategorized evidence pointer to progress.md.
    const ambiguity = describeEvidencePathAmbiguity(value, type, evidencePath, summaryParts);
    if (ambiguity) {
      return { ok: false, error: cliError(CliErrorCode.InvalidEvidence, ambiguity) };
    }
    evidence.push({ type, path: evidencePath, summary: summaryParts.join(":") });
  }
  return { ok: true, value: evidence };
}

// Returns a hint string when the parsed PATH is almost certainly a URL scheme
// fragment or Windows drive letter (the rest of the URL/path leaked into
// summary), or undefined when the parse looks legitimate.
function describeEvidencePathAmbiguity(
  value: string,
  type: string,
  evidencePath: string,
  summaryParts: ReadonlyArray<string>
): string | undefined {
  // After the split, evidencePath is a bare identifier (no path separators)
  // matching a URL scheme (`https`, `ftp`) or a single Windows drive letter
  // (`C`, `D`). The next segment continues an absolute path/URL.
  if (!/^[a-z][a-z0-9+.-]*$/iu.test(evidencePath)) return undefined;
  const first = summaryParts[0] ?? "";
  if (!first.startsWith("/") && !first.startsWith("\\")) return undefined;
  const parsedSummary = summaryParts.join(":");
  if (evidencePath.length > 1) {
    // URL scheme case: the user meant `<type>:<full URL>[:summary]`.
    const host = first.replace(/^[/\\]+/u, "");
    return `Evidence PATH cannot contain ':' in '${value}' — the 'type:PATH:summary' format has no delimiter after PATH, so the URL scheme '${evidencePath}' became PATH and the URL leaked into summary (parsed as type='${type}', path='${evidencePath}', summary='${parsedSummary}'). For URL evidence, keep PATH free of ':' and put the full URL in summary, which allows ':' — e.g. --evidence ${type}:<short-label>:${evidencePath}://${host}.`;
  }
  // Single-letter drive case: the user meant a Windows absolute path.
  return `Evidence PATH cannot contain ':' in '${value}' — the 'type:PATH:summary' format has no delimiter after PATH, so the Windows drive letter '${evidencePath}:' became PATH and the rest leaked into summary (parsed as type='${type}', path='${evidencePath}', summary='${parsedSummary}'). Use a POSIX-style path relative to the repository root.`;
}
