// Renders invalid wire values for validation diagnostics, matching what
// util.inspect({ compact: true, breakLength: Infinity }) used to produce, but portable: this
// closure is part of the GUI renderer's module graph, where a node:util value import breaks the
// Electron dev server (the GUI vite config fails such imports at build time with the importer
// named). Keep this module free of Node builtin value imports.
const validationValueLimit = 120,
  validationStringLimit = 100,
  validationArrayLimit = 20,
  validationDepthLimit = 3;

function escapeValidationChar(ch: string, quote: string): string {
  if (ch === "\\" || ch === quote) return `\\${ch}`;
  if (ch === "\n" || ch === "\r" || ch === "\t") return { "\n": "\\n", "\r": "\\r", "\t": "\\t" }[ch]!;
  const code = ch.charCodeAt(0);
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return `\\x${code.toString(16).padStart(2, "0")}`;
  if (code >= 0xd800 && code <= 0xdfff) return `\\u${code.toString(16).padStart(4, "0")}`;
  return ch;
}

function renderValidationString(text: string): string {
  const hasSingle = text.includes("'"),
    hasDouble = text.includes('"'),
    hasControl = /[\u0000-\u001f]/u.test(text),
    backtickable = hasSingle && hasDouble && !text.includes("`") && !text.includes("${") && !hasControl,
    quote = backtickable ? "`" : hasSingle ? '"' : "'",
    kept = text.slice(0, validationStringLimit),
    rest = text.length - kept.length,
    body = [...kept].map((ch) => escapeValidationChar(ch, quote)).join("");
  return rest > 0
    ? `${quote}${body}${quote}... ${rest} more character${rest === 1 ? "" : "s"}`
    : `${quote}${body}${quote}`;
}

function renderValidationKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ? key : renderValidationString(key);
}

function validationObjectTag(value: object): string {
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  if (tag !== "Object") return tag;
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && name !== "Object" ? name : "Object";
}

function renderValidationValue(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return renderValidationString(value);
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (typeof value === "boolean" || typeof value === "undefined") return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") return value.name ? `[Function: ${value.name}]` : "[Function (anonymous)]";
  if (Array.isArray(value)) {
    if (depth < 0) return "[Array]";
    const items = value.slice(0, validationArrayLimit).map((item) => renderValidationValue(item, depth - 1)),
      rest = value.length - validationArrayLimit;
    if (rest > 0) items.push(`... ${rest} more item${rest === 1 ? "" : "s"}`);
    return items.length > 0 ? `[ ${items.join(", ")} ]` : "[]";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `[object ${validationObjectTag(value)}]`;
  if (depth < 0) return "[Object]";
  const entries = Object.entries(value).map(
    ([key, item]) => `${renderValidationKey(key)}: ${renderValidationValue(item, depth - 1)}`,
  );
  return entries.length > 0 ? `{ ${entries.join(", ")} }` : "{}";
}

export function validationValueSummary(value: unknown): string {
  const rendered = renderValidationValue(value, validationDepthLimit),
    characters = [...rendered];
  return characters.length <= validationValueLimit
    ? rendered
    : `${characters.slice(0, validationValueLimit - 1).join("")}…`;
}
