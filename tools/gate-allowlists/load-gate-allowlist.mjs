import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const schema = "harness-anything/gate-allowlist/v1";
const toolRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultAllowlistRoot = path.join(toolRoot, "tools/gate-allowlists");

export function loadGateAllowlist(gateId, options = {}) {
  const allowlistRoot = process.env.HARNESS_GATE_ALLOWLIST_DIR ?? defaultAllowlistRoot;
  const allowlistPath = path.join(allowlistRoot, `${gateId}.json`);
  const displayPath = path.relative(toolRoot, allowlistPath).split(path.sep).join("/") || allowlistPath;
  let raw;
  try {
    raw = readFileSync(allowlistPath, "utf8");
  } catch (error) {
    fail(gateId, `unable to read ${displayPath}: ${error.message}`);
  }

  if (raw.trim() === "") fail(gateId, `${displayPath} is empty`);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(gateId, `${displayPath} is not valid JSON: ${error.message}`);
  }

  if (!isObject(parsed)) fail(gateId, `${displayPath} must contain a JSON object`);
  if (parsed.schema !== schema) fail(gateId, `${displayPath} schema must be ${schema}`);
  if (parsed.gateId !== gateId) fail(gateId, `${displayPath} gateId must be ${gateId}`);
  if (!isObject(parsed.entries)) fail(gateId, `${displayPath} must define entries`);

  for (const section of options.requiredSections ?? []) {
    if (!(section in parsed.entries)) fail(gateId, `${displayPath} missing entries.${section}`);
  }

  const currentCount = validateEntryTree(gateId, parsed.entries, "entries");
  if (currentCount === 0) fail(gateId, `${displayPath} must contain at least one governed entry`);

  const previousCount = previousEntryCount(displayPath);
  const trend = previousCount === null ? "previous=unavailable" : `previous=${previousCount} delta=${currentCount - previousCount}`;
  const growth = previousCount !== null && currentCount > previousCount ? " GROWTH_REQUIRES_GOVERNANCE_REVIEW" : "";
  console.log(`[gate-allowlist] ${gateId}: current=${currentCount} ${trend}${growth}`);

  return parsed.entries;
}

export function entryValues(entries) {
  return entries.map((entry) => entry.value);
}

export function entryJoinedValues(entries) {
  return entries.map((entry) => {
    if (typeof entry.value === "string") return entry.value;
    if (Array.isArray(entry.parts) && entry.parts.every((part) => typeof part === "string")) {
      return entry.parts.join("");
    }
    throw new Error("Gate allowlist entry must include value or string parts");
  });
}

export function entryPairs(entries, keyField = "key", valueField = "value") {
  return entries.map((entry) => [entry[keyField], entry[valueField]]);
}

export function patternEntries(entries) {
  return entries.map((entry) => ({
    label: entry.label,
    pattern: new RegExp(entry.pattern, entry.flags ?? "u"),
    includePathPattern: typeof entry.includePathPattern === "string" ? new RegExp(entry.includePathPattern, "u") : null
  }));
}

function validateEntryTree(gateId, value, label) {
  if (Array.isArray(value)) {
    if (value.length === 0) fail(gateId, `${label} must not be an empty list`);
    for (const [index, entry] of value.entries()) validateEntry(gateId, entry, `${label}[${index}]`);
    return value.length;
  }

  if (!isObject(value)) fail(gateId, `${label} must be an object or entry list`);

  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    count += validateEntryTree(gateId, child, `${label}.${key}`);
  }
  return count;
}

function validateEntry(gateId, entry, label) {
  if (!isObject(entry)) fail(gateId, `${label} must be an object`);
  if (typeof entry.ref !== "string" || entry.ref.trim() === "") {
    fail(gateId, `${label} must include a non-empty ref`);
  }
  if (!/^(?:ADR-\d{4}|dec_[A-Za-z0-9_]+|task_[A-Z0-9]+)/u.test(entry.ref)) {
    fail(gateId, `${label}.ref must cite an ADR, decision, or task id`);
  }
  if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
    fail(gateId, `${label} must include a non-empty reason`);
  }
}

function previousEntryCount(displayPath) {
  try {
    const raw = execFileSync("git", ["show", `HEAD^:${displayPath}`], {
      cwd: toolRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const parsed = JSON.parse(raw);
    if (!isObject(parsed) || !isObject(parsed.entries)) return null;
    return validateEntryTree("previous", parsed.entries, "entries");
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(gateId, message) {
  throw new Error(`Gate allowlist load failed for ${gateId}: ${message}`);
}
