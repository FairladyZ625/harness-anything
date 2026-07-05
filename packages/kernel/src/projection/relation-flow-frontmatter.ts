import type { EntityRelationRecord } from "../domain/index.ts";

export function parseRelationFlowRecords(body: string): ReadonlyArray<EntityRelationRecord> {
  const records: EntityRelationRecord[] = [];
  const lines = body.split(/\r?\n/u);
  let inRelations = false;
  for (const line of lines) {
    if (/^\s*relations:\s*$/u.test(line)) {
      inRelations = true;
      continue;
    }
    if (!inRelations) continue;
    if (/^\s*-\s*\{/u.test(line)) {
      const record = parseRelationFlowLine(line);
      if (record) records.push(record);
      continue;
    }
    if (line.trim().length === 0 || /^\s+#/u.test(line)) continue;
    if (/^\S/u.test(line)) inRelations = false;
  }
  return records;
}

function parseRelationFlowLine(line: string): EntityRelationRecord | null {
  const body = line.match(/^\s*-\s*\{\s*(.*)\s*\}\s*$/u)?.[1];
  if (!body || !body.includes("relation_id:")) return null;
  const fields = new Map<string, string>();
  for (const chunk of splitFlowFields(body)) {
    const separator = chunk.indexOf(":");
    if (separator <= 0) continue;
    fields.set(chunk.slice(0, separator).trim(), parseFlowValue(chunk.slice(separator + 1).trim()));
  }
  const record = {
    relation_id: fields.get("relation_id") ?? "",
    source: fields.get("source") ?? "",
    target: fields.get("target") ?? "",
    type: fields.get("type") ?? "",
    strength: fields.get("strength") ?? "",
    direction: fields.get("direction") ?? "",
    origin: fields.get("origin") ?? "",
    rationale: fields.get("rationale") ?? "",
    state: fields.get("state") ?? ""
  };
  if (!record.relation_id || !record.source || !record.target) return null;
  if (!isRelationType(record.type) || !isRelationStrength(record.strength) || !isRelationDirection(record.direction) || !isRelationOrigin(record.origin) || !isRelationState(record.state)) {
    return null;
  }
  return {
    relation_id: record.relation_id,
    source: record.source,
    target: record.target,
    type: record.type,
    strength: record.strength,
    direction: record.direction,
    origin: record.origin,
    rationale: record.rationale,
    state: record.state
  };
}

function splitFlowFields(body: string): ReadonlyArray<string> {
  const fields: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? "";
    if ((character === "\"" || character === "'") && body[index - 1] !== "\\") {
      quote = quote === character ? null : quote ?? character;
    }
    if (character === "," && !quote) {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) fields.push(current.trim());
  return fields;
}

function parseFlowValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function isRelationType(value: string): value is EntityRelationRecord["type"] {
  return ["supports", "supersedes", "refines", "narrows", "derives", "blocks", "relates", "implements", "depends-on", "produces", "evidences", "evidenced-by", "invalidated-by", "supersedes-fact"].includes(value);
}

function isRelationStrength(value: string): value is EntityRelationRecord["strength"] {
  return value === "strong" || value === "weak";
}

function isRelationDirection(value: string): value is EntityRelationRecord["direction"] {
  return value === "directed" || value === "undirected";
}

function isRelationOrigin(value: string): value is EntityRelationRecord["origin"] {
  return value === "declared" || value === "imported_snapshot" || value === "generated" || value === "inferred";
}

function isRelationState(value: string): value is EntityRelationRecord["state"] {
  return value === "active" || value === "retired" || value === "deleted";
}
