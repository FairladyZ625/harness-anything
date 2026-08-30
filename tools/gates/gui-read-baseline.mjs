#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { git, pathExistsAt } from "./git.mjs";
import { exitCodeFor, parseCommonArgs } from "./ontology-gate-lib.mjs";

const baselineFile = "tools/gates/gui-read-baseline.json";
const viewIds = Object.freeze(["overview", "board", "graph", "sessions", "schedules", "agentSquad", "artifacts"]);
const metricNames = Object.freeze(["requestCount", "payloadBytes", "maxE2eDurationMs", "maxHandlerDurationMs"]);

export function parseGuiReadBaseline(body, source = baselineFile) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (parsed?.schema !== "gui-read-ratchet/v1" || typeof parsed.basisRevision !== "string" || !plain(parsed.views))
    throw new Error(`${source} must use gui-read-ratchet/v1 with basisRevision and views`);
  const views = normalizeViews(parsed.views, source);
  return { basisRevision: parsed.basisRevision, measuredAt: parsed.measuredAt ?? null, views };
}

export function parseGuiReadMeasurement(body, source = "measurement") {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (parsed?.schema !== "gui-read-baseline/v1" || !plain(parsed.views))
    throw new Error(`${source} must use gui-read-baseline/v1 with views`);
  return normalizeViews(parsed.views, source);
}

export function evaluateGuiReadBaseline({ rootDir, base = null, measurementPath = null }) {
  const absoluteBaseline = path.join(rootDir, baselineFile);
  const current = parseGuiReadBaseline(readFileSync(absoluteBaseline, "utf8"), baselineFile);
  const historical =
    base && pathExistsAt(rootDir, base, baselineFile)
      ? parseGuiReadBaseline(git(rootDir, ["show", `${base}:${baselineFile}`]), `${base}:${baselineFile}`)
      : null;
  const findings = [];
  if (historical) compareLimits(current.views, historical.views, "shrink-only baseline", findings);
  if (measurementPath) {
    const observed = parseGuiReadMeasurement(readFileSync(measurementPath, "utf8"), measurementPath);
    compareLimits(observed, current.views, "measurement", findings);
  }
  return { current, historical, findings };
}

function compareLimits(actual, limits, label, findings) {
  for (const viewId of viewIds) {
    for (const metric of metricNames) {
      if (actual[viewId][metric] > limits[viewId][metric])
        findings.push(`${viewId}.${metric}: ${label} rose from ${limits[viewId][metric]} to ${actual[viewId][metric]}`);
    }
  }
}

function normalizeViews(value, source) {
  const keys = Object.keys(value).sort();
  const expected = [...viewIds].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected))
    throw new Error(`${source} views must be exactly ${viewIds.join(", ")}`);
  return Object.fromEntries(
    viewIds.map((viewId) => {
      const row = value[viewId];
      if (!plain(row)) throw new Error(`${source} ${viewId} must be an object`);
      for (const metric of metricNames) {
        const number = row[metric];
        if (!Number.isFinite(number) || number < 0 || (metric === "requestCount" && !Number.isInteger(number)))
          throw new Error(`${source} ${viewId}.${metric} must be a non-negative number`);
      }
      return [viewId, Object.fromEntries(metricNames.map((metric) => [metric, row[metric]]))];
    }),
  );
}

function plain(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv) {
  const common = [];
  let measurementPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--measurement") {
      measurementPath = argv[index + 1];
      if (!measurementPath) throw new Error("--measurement requires a path");
      index += 1;
    } else common.push(argv[index]);
  }
  return { ...parseCommonArgs(common, { allowBase: true }), measurementPath };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { rootDir, base, mode, measurementPath } = parseArgs(argv);
    const result = evaluateGuiReadBaseline({
      rootDir,
      base,
      measurementPath: measurementPath ? path.resolve(rootDir, measurementPath) : null,
    });
    console.log(`GUI read baseline ratchet: ${mode}`);
    for (const [viewId, row] of Object.entries(result.current.views))
      console.log(
        `${viewId}: requests=${row.requestCount} payload=${row.payloadBytes}B ` +
          `e2e<=${row.maxE2eDurationMs}ms handler<=${row.maxHandlerDurationMs}ms`,
      );
    for (const finding of result.findings) console.error(`- ${finding}`);
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(`GUI read baseline ratchet: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
