import path from "node:path";
import {
  defaultIntegrationTestWeightMs,
  integrationTestFileWeightsMs,
  nightlyTestFileWeightsMs
} from "./integration-test-shards.mjs";

const significantDriftRatio = 2;
const significantDriftOverageMs = 5000;

export function parseJunitTestFileDurations(xml, repoRoot) {
  const durations = new Map();
  for (const match of xml.matchAll(/<testcase\b[^>]*\btime="([0-9.]+)"[^>]*\bfile="([^"]+)"[^>]*\/>/gu)) {
    const absoluteFile = decodeXmlAttribute(match[2]);
    const relativeFile = path.relative(repoRoot, absoluteFile).split(path.sep).join("/");
    if (relativeFile === ".." || relativeFile.startsWith("../")) continue;
    const durationMs = Number(match[1]) * 1000;
    durations.set(relativeFile, (durations.get(relativeFile) ?? 0) + durationMs);
  }
  return durations;
}

export function findTestWeightDrift(measuredDurations, {
  integrationWeights = integrationTestFileWeightsMs,
  nightlyWeights = nightlyTestFileWeightsMs,
  defaultWeightMs = defaultIntegrationTestWeightMs,
  ratio = significantDriftRatio,
  minimumOverageMs = significantDriftOverageMs
} = {}) {
  const warnings = [];
  for (const [file, measuredMs] of measuredDurations) {
    const registered = integrationWeights[file] ?? nightlyWeights[file];
    const weightMs = registered ?? defaultWeightMs;
    if (measuredMs < weightMs * ratio || measuredMs - weightMs < minimumOverageMs) continue;
    warnings.push({
      file,
      measuredMs,
      weightMs,
      source: registered === undefined ? "default" : "registered"
    });
  }
  return warnings.sort((left, right) => right.measuredMs / right.weightMs - left.measuredMs / left.weightMs);
}

export function formatTestWeightDriftWarnings(measuredDurations, options) {
  return findTestWeightDrift(measuredDurations, options).map((warning) => {
    const message = `test weight drift: measured=${warning.measuredMs.toFixed(0)}ms weight=${warning.weightMs.toFixed(0)}ms source=${warning.source}; refresh tools/integration-test-shards.mjs`;
    return process.env.CI
      ? `::warning file=${warning.file}::${message}`
      : `WARNING ${warning.file}: ${message}`;
  });
}

function decodeXmlAttribute(value) {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
