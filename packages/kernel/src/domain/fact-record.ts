export const factConfidenceLevels = ["low", "medium", "high"] as const;

export type FactConfidence = typeof factConfidenceLevels[number];

export interface FactRecord {
  readonly fact_id: string;
  readonly statement: string;
  readonly source: string;
  readonly observedAt: string;
  readonly confidence: FactConfidence;
  readonly provenance: ReadonlyArray<{
    readonly runtime: string;
    readonly sessionId: string;
    readonly boundAt: string;
  }>;
}

const factIdPattern = /^F-[0-9A-HJKMNP-TV-Z]{8}$/u;

export function isFactId(value: string): boolean {
  return factIdPattern.test(value);
}

export function formatFactFlowRecord(record: FactRecord): string {
  return `- {fact_id: ${record.fact_id}, statement: ${quoteFactFlowString(record.statement)}, source: ${quoteFactFlowString(record.source)}, observedAt: ${quoteFactFlowString(record.observedAt)}, confidence: ${record.confidence}, provenance: [${record.provenance.map(formatFactProvenanceEntry).join(", ")}]}`;
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
  const provenance = parseFactProvenanceArray(values.provenance);
  if (provenance.length === 0) return null;
  return {
    fact_id: values.fact_id,
    statement: values.statement,
    source: values.source,
    observedAt: values.observedAt,
    confidence: values.confidence,
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
  if (!values.runtime || !values.sessionId || !values.boundAt) return null;
  return {
    runtime: values.runtime,
    sessionId: values.sessionId,
    boundAt: values.boundAt
  };
}

function isConfidence(value: string): value is FactConfidence {
  return (factConfidenceLevels as ReadonlyArray<string>).includes(value);
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
