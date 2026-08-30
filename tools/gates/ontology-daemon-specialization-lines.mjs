#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { git, pathExistsAt } from "./git.mjs";
import { exitCodeFor, parseCommonArgs } from "./ontology-gate-lib.mjs";

const defaultBaselinePath = "tools/gates/ontology-daemon-specialization-lines.json";

export function countLines(body) {
  if (body.length === 0) return 0;
  const lines = body.split(/\r?\n/u);
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

export function parseSpecializationBaseline(body, source = defaultBaselinePath) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (parsed?.schema !== "ontology-daemon-specialization-lines/v1" || !plainObject(parsed.files)) {
    throw new Error(`${source} must contain { schema: "ontology-daemon-specialization-lines/v1", files: { ... } }`);
  }
  for (const [file, limit] of Object.entries(parsed.files)) {
    if (!file.startsWith("packages/daemon/src/") || !file.endsWith(".ts")) {
      throw new Error(`${source} has invalid daemon production path ${file}`);
    }
    if (!Number.isInteger(limit) || limit < 0)
      throw new Error(`${source} limit for ${file} must be a non-negative integer`);
  }
  return parsed.files;
}

export function evaluateSpecializationLines({
  rootDir,
  base = null,
  baselinePath = path.join(rootDir, defaultBaselinePath),
}) {
  const relativeBaseline = path.relative(rootDir, baselinePath).split(path.sep).join("/");
  const limits = parseSpecializationBaseline(readFileSync(baselinePath, "utf8"), relativeBaseline);
  const historical =
    base && pathExistsAt(rootDir, base, relativeBaseline)
      ? parseSpecializationBaseline(
          git(rootDir, ["show", `${base}:${relativeBaseline}`]),
          `${base}:${relativeBaseline}`,
        )
      : null;
  const rows = [];
  const findings = [];
  for (const [file, limit] of Object.entries(limits)) {
    const absolute = path.join(rootDir, file);
    const current = existsSync(absolute) ? countLines(readFileSync(absolute, "utf8")) : 0;
    const difference = current - limit;
    rows.push({ file, current, baseline: limit, difference });
    if (difference > 0) findings.push(`${file}: current ${current} exceeds baseline ${limit} by ${difference} lines`);
    const oldLimit = historical?.[file];
    if (oldLimit !== undefined && limit > oldLimit) {
      findings.push(`${file}: shrink-only baseline rose from ${oldLimit} to ${limit}`);
    }
  }
  if (historical) {
    for (const file of Object.keys(historical)) {
      if (!Object.hasOwn(limits, file))
        findings.push(`${file}: shrink-only baseline entry was removed instead of lowered to zero`);
    }
  }
  return { rows, findings };
}

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { rootDir, mode, base } = parseCommonArgs(argv, { allowBase: true });
    const result = evaluateSpecializationLines({ rootDir, base });
    console.log(`G0-5 ontology-daemon-specialization-lines: ${mode}`);
    for (const row of result.rows) {
      const delta = row.difference > 0 ? `+${row.difference}` : String(row.difference);
      console.log(`${row.file}: current=${row.current} baseline=${row.baseline} delta=${delta}`);
    }
    if (result.findings.length) for (const finding of result.findings) console.error(`- ${finding}`);
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(
      `G0-5 ontology-daemon-specialization-lines: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
