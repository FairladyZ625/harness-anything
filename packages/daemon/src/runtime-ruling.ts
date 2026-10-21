import { consumeKnownError, readFrontmatter, readScalar } from "@harness-anything/kernel";

/** A worker's request for an owner ruling, read from the task package. */
export interface RuntimeRulingRequest {
  readonly question: string;
  readonly options: readonly string[];
  /** Task-package-relative logical path of the artifact that carries the request. */
  readonly path: string;
}

/** The artifact a dispatched worker writes when it needs a ruling instead of finishing. */
export function runtimeRulingPath(dispatchId: string): string {
  return `artifacts/rulings/${dispatchId}.md`;
}

/**
 * The one machine-readable shape of an unattended ruling request. The mission tells the worker to
 * write this file and stop; settlement reads it here rather than inferring a ruling from prose or
 * from a provider's question-tool frame (which is not structured in the exec JSON stream at all).
 * Returns null for an absent artifact and for any body that is not exactly this declaration — a
 * malformed ruling is not a ruling, so the dispatch keeps its ordinary classification.
 */
export function parseRulingRequest(body: string, path: string): RuntimeRulingRequest | null {
  const frontmatter = readFrontmatter(body);
  if (frontmatter === null || readScalar(frontmatter, "ruling") !== "awaiting") return null;
  const question = readScalar(frontmatter, "question");
  if (question === "") return null;
  return { question, options: readOptions(frontmatter), path };
}

/** The `options:` block: one `- <option>` entry per line, in the worker's order. */
function readOptions(frontmatter: string): readonly string[] {
  const lines = frontmatter.split("\n"),
    start = lines.findIndex((line) => line.trimEnd() === "options:");
  if (start < 0) return [];
  const options: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const entry = /^\s*-\s+(.*)$/u.exec(line);
    if (entry === null) break;
    const text = entry[1]!.trim();
    if (text !== "") options.push(text);
  }
  return options;
}

/** Read this dispatch's ruling artifact from the task package, if the worker wrote one. */
export function readDispatchRuling(
  readDocument: (relativePath: string) => string | null,
  packagePath: string,
  dispatchId: string,
): RuntimeRulingRequest | null {
  const relative = `${packagePath}/${runtimeRulingPath(dispatchId)}`;
  try {
    const body = readDocument(relative);
    return body === null ? null : parseRulingRequest(body, relative);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
