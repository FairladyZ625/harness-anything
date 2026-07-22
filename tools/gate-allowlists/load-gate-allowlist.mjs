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

  const coverageCount = validateEntryTree(gateId, parsed.entries, "entries");
  const ratchetSections = options.ratchetSections ?? [];
  const currentCount = ratchetSections.length === 0
    ? coverageCount
    : countSelectedSections(gateId, parsed.entries, ratchetSections);

  const previous = previousEntryCounts(displayPath, ratchetSections);
  const previousCount = previous?.ratchet ?? null;
  const trend = previousCount === null ? "previous=unavailable" : `previous=${previousCount} delta=${currentCount - previousCount}`;
  const growth = previousCount !== null && currentCount > previousCount ? " GROWTH_REQUIRES_GOVERNANCE_REVIEW" : "";
  console.log(`[gate-allowlist] ${gateId}: current=${currentCount} ${trend}${growth}`);
  if (ratchetSections.length > 0) {
    const previousCoverage = previous?.coverage ?? "unavailable";
    console.log(`[gate-allowlist-coverage] ${gateId}: governed=${coverageCount} previousGoverned=${previousCoverage}`);
  }

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

function countSelectedSections(gateId, entries, sections, options = {}) {
  let count = 0;
  for (const section of sections) {
    if (!(section in entries) && options.missingAsZero === true) continue;
    if (!(section in entries)) fail(gateId, `entries missing ratchet section ${section}`);
    count += validateEntryTree(gateId, entries[section], `entries.${section}`);
  }
  return count;
}

function previousEntryCounts(displayPath, ratchetSections) {
  try {
    const raw = execFileSync("git", ["show", `HEAD^:${displayPath}`], {
      cwd: toolRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const parsed = JSON.parse(raw);
    if (!isObject(parsed) || !isObject(parsed.entries)) return null;
    const coverage = validateEntryTree("previous", parsed.entries, "entries");
    const ratchet = ratchetSections.length === 0
      ? coverage
      : countSelectedSections("previous", parsed.entries, ratchetSections, { missingAsZero: true });
    return { coverage, ratchet };
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
