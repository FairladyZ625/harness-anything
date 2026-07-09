export interface FlowFrontmatterParseOptions {
  readonly tolerateInvalidArrays?: boolean;
}

export function readBlockScalar(frontmatter: string, blockName: string, key: string): string {
  return readIndentedBlock(frontmatter, blockName)
    .find((line) => line.trimStart().startsWith(`${key}:`))
    ?.replace(new RegExp(`^\\s*${key}:\\s*`, "u"), "")
    .trim() ?? "[]";
}

export function parseStringArray(value: string, options: FlowFrontmatterParseOptions = {}): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch (error) {
    if (options.tolerateInvalidArrays === true) return [];
    throw error;
  }
}

export function parseObjectList(
  frontmatter: string,
  key: string,
  options: FlowFrontmatterParseOptions = {}
): ReadonlyArray<Record<string, unknown>> {
  const items: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | null = null;
  for (const rawLine of readIndentedBlock(frontmatter, key)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("- ")) {
      if (current) items.push(current);
      const body = line.slice(2).trim();
      current = body.startsWith("{") ? parseFlowObject(body, options) : parseBlockObjectLine(body, options);
      continue;
    }
    if (!current) continue;
    for (const [entryKey, entryValue] of Object.entries(parseBlockObjectLine(line, options))) {
      current[entryKey] = entryValue;
    }
  }
  if (current) items.push(current);
  return items;
}

export function parseFlowObject(value: string, options: FlowFrontmatterParseOptions = {}): Record<string, unknown> {
  const body = value.trim().replace(/^\{\s*/u, "").replace(/\s*\}$/u, "");
  const result: Record<string, unknown> = {};
  for (const part of splitTopLevel(body)) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    result[key] = parseFlowValue(part.slice(separator + 1).trim(), options);
  }
  return result;
}

export function unquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("\"")) return trimmed;
  try {
    return String(JSON.parse(trimmed));
  } catch {
    return trimmed.replace(/^"|"$/gu, "");
  }
}

function readIndentedBlock(frontmatter: string, key: string): ReadonlyArray<string> {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*:/u.test(line)) break;
    block.push(line);
  }
  return block;
}

function parseBlockObjectLine(value: string, options: FlowFrontmatterParseOptions): Record<string, unknown> {
  const separator = value.indexOf(":");
  if (separator === -1) return {};
  const key = value.slice(0, separator).trim();
  return { [key]: parseFlowValue(value.slice(separator + 1).trim(), options) };
}

function parseFlowValue(value: string, options: FlowFrontmatterParseOptions): unknown {
  if (value.startsWith("{")) return parseFlowObject(value, options);
  if (value.startsWith("[")) return parseStringArray(value, options);
  if (value === "true") return true;
  if (value === "false") return false;
  return unquote(value);
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (char === "\"" && previous !== "\\") inString = !inString;
    if (!inString && (char === "{" || char === "[")) depth += 1;
    if (!inString && (char === "}" || char === "]")) depth -= 1;
    if (!inString && depth === 0 && char === ",") {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}
