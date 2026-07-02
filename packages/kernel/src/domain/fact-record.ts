export const factConfidenceLevels = ["low", "medium", "high"] as const;

export type FactConfidence = typeof factConfidenceLevels[number];

export interface FactRecord {
  readonly fact_id: string;
  readonly statement: string;
  readonly source: string;
  readonly observedAt: string;
  readonly confidence: FactConfidence;
}

const factIdPattern = /^F-[0-9A-HJKMNP-TV-Z]{8}$/u;

export function isFactId(value: string): boolean {
  return factIdPattern.test(value);
}

export function formatFactFlowRecord(record: FactRecord): string {
  return `- {fact_id: ${record.fact_id}, statement: ${quoteFactFlowString(record.statement)}, source: ${quoteFactFlowString(record.source)}, observedAt: ${quoteFactFlowString(record.observedAt)}, confidence: ${record.confidence}}`;
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
  for (const part of splitTopLevel(body)) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    values[key] = parseFlowScalar(part.slice(separator + 1).trim());
  }
  if (!values.fact_id || !values.statement || !values.source || !values.observedAt || !values.confidence) return null;
  if (!isFactId(values.fact_id)) return null;
  if (!isConfidence(values.confidence)) return null;
  return {
    fact_id: values.fact_id,
    statement: values.statement,
    source: values.source,
    observedAt: values.observedAt,
    confidence: values.confidence
  };
}

function isConfidence(value: string): value is FactConfidence {
  return (factConfidenceLevels as ReadonlyArray<string>).includes(value);
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let inString = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (char === "\"" && previous !== "\\") inString = !inString;
    if (!inString && char === ",") {
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
