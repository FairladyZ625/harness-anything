import { createHash } from "node:crypto";
import { compareArchitectureText } from "./architecture-portable-path.mjs";

export function architectureSourceDigest(extractors) {
  const aggregate = (Array.isArray(extractors) ? extractors : [])
    .map((entry) => ({ extractorId: entry.id, inputDigest: entry.inputDigest }))
    .sort((left, right) => compareArchitectureText(left.extractorId, right.extractorId));
  return digestJson(aggregate);
}

export function digestText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestJson(value) {
  return digestText(JSON.stringify(canonicalValue(value)));
}

export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort(compareArchitectureText).map((key) => [key, canonicalValue(value[key])]));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
