#!/usr/bin/env node
// Shrink-only ratchet over the per-command CLI timing ratios, plus an optional check of a fresh
// measurement against the committed limits.
//
// Every limit here is a ratio against the compiled CLI's own `--help` no-op measured in the same
// round, never a millisecond. An absolute wall-clock bound would only assert how fast the runner
// is: the same paired denominator reads 14.472x on the loaded Linux enforcement runner and
// 20.843x on Windows (packages/cli/test/daemon-multi-repo-lifecycle-cli-latency.test.ts). A ratio
// fails when a command grows relative to ordinary CLI startup, which is the property worth
// defending, and it is why this lane can exist at all without putting wall clock on the merge path.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MEASURED_COMMANDS, NOOP_ID } from "../measure-cli-command-timing.mjs";
import { git, pathExistsAt } from "./git.mjs";
import { exitCodeFor, parseCommonArgs } from "./ontology-gate-lib.mjs";

const baselineFile = "tools/gates/cli-command-timing.json";
const commandIds = Object.freeze(
  MEASURED_COMMANDS.map((command) => command.id)
    .filter((id) => id !== NOOP_ID)
    .sort(),
);

export function parseCliCommandTimingBaseline(body, source = baselineFile) {
  const parsed = parseJson(body, source);
  if (
    parsed?.schema !== "cli-command-timing-ratchet/v1" ||
    typeof parsed.basisRevision !== "string" ||
    parsed.baseline !== NOOP_ID ||
    !plain(parsed.limits)
  )
    throw new Error(
      `${source} must use cli-command-timing-ratchet/v1 with basisRevision, baseline ${NOOP_ID}, and limits`,
    );
  return {
    basisRevision: parsed.basisRevision,
    measuredAt: parsed.measuredAt ?? null,
    limits: normalizeLimits(parsed.limits, source),
  };
}

// The measurement carries far more than the ratchet enforces -- phases, handler split, raw
// milliseconds. Only the paired ratio is read here, so a host-speed difference in the report can
// never become a verdict.
export function parseCliCommandTimingMeasurement(body, source = "measurement") {
  const parsed = parseJson(body, source);
  if (parsed?.schema !== "cli-command-timing/v1" || !plain(parsed.commands))
    throw new Error(`${source} must use cli-command-timing/v1 with commands`);
  return Object.fromEntries(
    commandIds.map((id) => {
      const ratio = parsed.commands[id]?.ratio;
      if (!plain(ratio) || !Number.isFinite(ratio.p50) || ratio.p50 <= 0)
        throw new Error(`${source} ${id}.ratio.p50 must be a positive number`);
      return [id, { totalRatio: ratio.p50 }];
    }),
  );
}

export function evaluateCliCommandTiming({ rootDir, base = null, measurementPath = null }) {
  const current = parseCliCommandTimingBaseline(readFileSync(path.join(rootDir, baselineFile), "utf8"), baselineFile),
    historical =
      base && pathExistsAt(rootDir, base, baselineFile)
        ? parseCliCommandTimingBaseline(git(rootDir, ["show", `${base}:${baselineFile}`]), `${base}:${baselineFile}`)
        : null,
    findings = [];
  if (historical) compareLimits(current.limits, historical.limits, "shrink-only baseline", findings);
  if (measurementPath)
    compareLimits(
      parseCliCommandTimingMeasurement(readFileSync(measurementPath, "utf8"), measurementPath),
      current.limits,
      "measurement",
      findings,
    );
  return { current, historical, findings };
}

function compareLimits(actual, limits, label, findings) {
  for (const id of commandIds) {
    if (actual[id].totalRatio > limits[id].totalRatio)
      findings.push(
        `${id}.totalRatio: ${label} rose from ${limits[id].totalRatio}x to ${actual[id].totalRatio}x ` +
          `of a ${NOOP_ID}`,
      );
  }
}

function normalizeLimits(value, source) {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...commandIds]))
    throw new Error(`${source} limits must be exactly ${commandIds.join(", ")}`);
  return Object.fromEntries(
    commandIds.map((id) => {
      const row = value[id];
      if (!plain(row) || !Number.isFinite(row.maxTotalRatio) || row.maxTotalRatio <= 0)
        throw new Error(`${source} ${id}.maxTotalRatio must be a positive number`);
      return [id, { totalRatio: row.maxTotalRatio }];
    }),
  );
}

function parseJson(body, source) {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
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
    const { rootDir, base, mode, measurementPath } = parseArgs(argv),
      result = evaluateCliCommandTiming({
        rootDir,
        base,
        measurementPath: measurementPath ? path.resolve(rootDir, measurementPath) : null,
      });
    console.log(`CLI command timing ratchet: ${mode} (basis ${result.current.basisRevision})`);
    for (const id of commandIds) console.log(`${id}: totalRatio<=${result.current.limits[id].totalRatio}x`);
    for (const finding of result.findings) console.error(`- ${finding}`);
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(`CLI command timing ratchet: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
