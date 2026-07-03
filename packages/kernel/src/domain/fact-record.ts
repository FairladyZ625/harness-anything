export const factConfidenceLevels = ["low", "medium", "high"] as const;
export const factMemoryClasses = ["semantic", "episodic", "procedural"] as const;
export const factMemoryTags = [
  "episode",
  "procedural",
  "tool_memory",
  "pattern",
  "task_skill",
  "abstract_rule",
  "other"
] as const;

export type FactConfidence = typeof factConfidenceLevels[number];
export type FactMemoryClass = typeof factMemoryClasses[number];
export type FactMemoryTag = typeof factMemoryTags[number];
type FactProvenanceRuntime = "human" | "claude-code" | "codex" | "zcode" | "antigravity";

export interface FactRecord {
  readonly fact_id: string;
  readonly statement: string;
  readonly source: string;
  readonly observedAt: string;
  readonly confidence: FactConfidence;
  readonly memoryClass: FactMemoryClass;
  readonly memoryTags: ReadonlyArray<FactMemoryTag>;
  readonly provenance: ReadonlyArray<{
    readonly runtime: FactProvenanceRuntime;
    readonly sessionId: string;
    readonly boundAt: string;
  }>;
}

const factIdPattern = /^F-[0-9A-HJKMNP-TV-Z]{8}$/u;

export function isFactId(value: string): boolean {
  return factIdPattern.test(value);
}

export function formatFactFlowRecord(record: FactRecord): string {
  return `- {fact_id: ${record.fact_id}, statement: ${quoteFactFlowString(record.statement)}, source: ${quoteFactFlowString(record.source)}, observedAt: ${quoteFactFlowString(record.observedAt)}, confidence: ${record.confidence}, memoryClass: ${record.memoryClass}, memoryTags: [${record.memoryTags.join(", ")}], provenance: [${record.provenance.map(formatFactProvenanceEntry).join(", ")}]}`;
}

export function parseFactFlowRecords(body: string): ReadonlyArray<FactRecord> {
  return body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- {") && line.endsWith("}"))
    .map((line) => parseFactFlowRecord(line))
    .filter((record): record is FactRecord => record !== null);
}

function parseFactFlowRecord(line: string): FactRecord | null {
  const body = line.replace(/^-\s*\{\s*/u, "").replace(/\s*\}$/u, "");
  const values: Record<string, string> = {};
  for (const part of splitFactTopLevel(body)) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    values[key] = parseFlowScalar(part.slice(separator + 1).trim());
  }
  if (!values.fact_id || !values.statement || !values.source || !values.observedAt || !values.confidence || !values.provenance) return null;
  if (!isFactId(values.fact_id)) return null;
  if (!isConfidence(values.confidence)) return null;
  const memoryClass = values.memoryClass ?? "episodic";
  if (!isMemoryClass(memoryClass)) return null;
  const memoryTags = values.memoryTags === undefined ? [] : parseFactMemoryTags(values.memoryTags);
  if (memoryTags === null) return null;
  const provenance = parseFactProvenanceArray(values.provenance);
  if (provenance.length === 0) return null;
  return {
    fact_id: values.fact_id,
    statement: values.statement,
    source: values.source,
    observedAt: values.observedAt,
    confidence: values.confidence,
    memoryClass,
    memoryTags,
    provenance
  };
}

function formatFactProvenanceEntry(entry: FactRecord["provenance"][number]): string {
  return `{runtime: ${quoteFactFlowString(entry.runtime)}, sessionId: ${quoteFactFlowString(entry.sessionId)}, boundAt: ${quoteFactFlowString(entry.boundAt)}}`;
}

function parseFactProvenanceArray(value: string): FactRecord["provenance"] {
  if (!value.startsWith("[") || !value.endsWith("]")) return [];
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return splitFactTopLevel(inner).map(parseFactProvenanceEntry).filter((entry): entry is FactRecord["provenance"][number] => entry !== null);
}

function parseFactProvenanceEntry(value: string): FactRecord["provenance"][number] | null {
  if (!value.startsWith("{") || !value.endsWith("}")) return null;
  const body = value.slice(1, -1).trim();
  const values: Record<string, string> = {};
  for (const part of splitFactTopLevel(body)) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    values[key] = parseFlowScalar(part.slice(separator + 1).trim());
  }
  if (!values.runtime || !isFactProvenanceRuntime(values.runtime) || !values.sessionId || !values.boundAt) return null;
  return {
    runtime: values.runtime,
    sessionId: values.sessionId,
    boundAt: values.boundAt
  };
}

function isFactProvenanceRuntime(value: string): value is FactProvenanceRuntime {
  return value === "human" || value === "claude-code" || value === "codex" || value === "zcode" || value === "antigravity";
}

function isConfidence(value: string): value is FactConfidence {
  return (factConfidenceLevels as ReadonlyArray<string>).includes(value);
}

export function isFactMemoryClass(value: string): value is FactMemoryClass {
  return isMemoryClass(value);
}

export function isFactMemoryTag(value: string): value is FactMemoryTag {
  return isMemoryTag(value);
}

function isMemoryClass(value: string): value is FactMemoryClass {
  return (factMemoryClasses as ReadonlyArray<string>).includes(value);
}

function isMemoryTag(value: string): value is FactMemoryTag {
  return (factMemoryTags as ReadonlyArray<string>).includes(value);
}

function parseFactMemoryTags(value: string): ReadonlyArray<FactMemoryTag> | null {
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  const tags = splitFactTopLevel(inner).map(parseFlowScalar);
  if (tags.some((tag) => !isMemoryTag(tag))) return null;
  return tags as ReadonlyArray<FactMemoryTag>;
}

function splitFactTopLevel(value: string): string[] {
  const parts: string[] = [];
  let inString = false;
  let squareDepth = 0;
  let braceDepth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (char === "\"" && previous !== "\\") inString = !inString;
    if (!inString && char === "[") squareDepth += 1;
    if (!inString && char === "]") squareDepth -= 1;
    if (!inString && char === "{") braceDepth += 1;
    if (!inString && char === "}") braceDepth -= 1;
    if (!inString && squareDepth === 0 && braceDepth === 0 && char === ",") {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function parseFlowScalar(value: string): string {
  if (!value.startsWith("\"")) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}

function quoteFactFlowString(value: string): string {
  return JSON.stringify(value.replace(/\s+/gu, " ").trim());
}
