import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export default async function* reportTestObservations(source) {
  const destination = process.env.HARNESS_CI_NODE_TEST_RESULTS ?? process.env.HARNESS_CI_OBSERVATION_RAW;
  if (!destination) {
    for await (const _event of source) yield "";
    return;
  }
  const observations = [],
    failures = new Map();
  const tierManifest = readTierManifest();
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const data = event.data,
      file = typeof data?.file === "string" ? repoRelative(data.file) : null,
      name = typeof data?.name === "string" ? data.name : null;
    if (!file || !name || isFileEnvelope(data)) continue;
    const key = `${file}\u0000${name}`,
      priorFailures = failures.get(key) ?? 0,
      status = event.type === "test:pass" ? "passed" : isSkipped(data) ? "skipped" : "failed";
    observations.push({
      file,
      name,
      tier: tierOf(file, tierManifest),
      shard: optionalPositiveInteger(process.env.HARNESS_TEST_SHARD),
      durationMs: durationMs(data),
      status,
      retry: status === "passed" ? priorFailures : priorFailures,
    });
    if (status === "failed") failures.set(key, priorFailures + 1);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  const previous = existsSync(destination) ? JSON.parse(readFileSync(destination, "utf8")) : [];
  writeFileSync(destination, `${JSON.stringify([...previous, ...observations])}\n`);
}

function readTierManifest() {
  try {
    const value = JSON.parse(process.env.HARNESS_TEST_TIER_MANIFEST ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function tierOf(file, manifest) {
  for (const tier of ["fast", "contract", "integration"])
    if (Array.isArray(manifest[tier]) && manifest[tier].includes(file)) return tier;
  return process.env.HARNESS_TEST_TIER === "gui" ? "gui" : "unknown";
}

function optionalPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function repoRelative(file) {
  const normalized = file.replaceAll("\\", "/"),
    marker = "/packages/";
  const packageIndex = normalized.lastIndexOf(marker);
  if (packageIndex >= 0) return normalized.slice(packageIndex + 1);
  const toolMarker = "/tools/",
    toolIndex = normalized.lastIndexOf(toolMarker);
  return toolIndex >= 0 ? normalized.slice(toolIndex + 1) : normalized;
}

function durationMs(data) {
  const value = data?.details?.duration_ms ?? data?.details?.durationMs ?? data?.duration_ms;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isSkipped(data) {
  return data?.details?.skip !== undefined || data?.details?.todo !== undefined;
}

function isFileEnvelope(data) {
  return data?.nesting === 0 && data?.line === 1 && data?.column === 1;
}
