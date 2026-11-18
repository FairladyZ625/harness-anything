#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { classifyProtectedChanges, deriveProtectedSurfaceRules } from "./check-pr-governance.mjs";

export const LARGE_PRODUCTION_DELTA_LINES = 500;
const MAX_ORACLE_CHANGE_REASONS = 25;
const TEST_OR_FIXTURE_SEGMENT = /(?:^|\/)(?:test|tests|__tests__|__snapshots__|fixtures?|e2e)(?:\/|$)/iu;
const TEST_OR_FIXTURE_FILE = /\.(?:(?:integration\.)?(?:spec|test)|vitest|fixtures?)\.[^/]+$|\.snap$/iu;

export function assessRepositoryRisk(input, root = process.cwd()) {
  if (!input || input.schema !== "task-risk-tier-input/v1" || !Array.isArray(input.delivery?.files))
    throw new Error("Expected task-risk-tier-input/v1 with a delivery file list.");
  const files = input.delivery.files,
    paths = files.map(({ path: filePath }) => filePath),
    oracleChanges = files.filter((file) => isExistingTestOrFixtureChange(file)),
    oracleReasons = formatOracleChangeReasons(oracleChanges),
    protectedChanges = classifyProtectedChanges(
      paths,
      deriveProtectedSurfaceRules(JSON.parse(readFileSync(path.join(root, "tools/gate-manifest.json"), "utf8"))),
    );
  if (protectedChanges.length)
    return result("high", [
      ...protectedChanges.map(({ file, surfaces }) => `protected surface ${surfaces.join(", ")}: ${file}`),
      ...oracleReasons,
    ]);
  const sensitive = paths.filter((filePath) =>
    /(?:^|\/)(?:migrations?|schema|store|persistence|auth|permissions?|credentials?|secrets?|schedules?|concurrency|leases?|claims?|writers?)(?:\/|\.|$)|^\.github\/|^tools\/gates\/|^tools\/gate-manifest\.json$/iu.test(
      filePath,
    ),
  );
  if (sensitive.length)
    return result("high", [
      ...sensitive.map((filePath) => `sensitive repository surface: ${filePath}`),
      ...oracleReasons,
    ]);
  const production = files.filter(({ path: filePath }) => isProductionPath(filePath)),
    changedLines = production.reduce(
      (total, file) => total + file.additions + file.deletions + (file.binary ? 1 : 0),
      0,
    );
  if (changedLines > LARGE_PRODUCTION_DELTA_LINES)
    return result("high", [
      `production diff is ${String(changedLines)} changed lines; high threshold is ${String(LARGE_PRODUCTION_DELTA_LINES)}`,
      ...oracleReasons,
    ]);
  if (production.length === 0) {
    if (oracleChanges.length > 0) return result("medium", oracleReasons);
    return result("low", ["delivery contains no production source paths"]);
  }
  if (production.length === 1 && changedLines <= 40) {
    const localized = `localized production diff is ${String(changedLines)} changed lines in one file`;
    if (oracleChanges.length > 0) return result("medium", [localized, ...oracleReasons]);
    return result("low", [localized]);
  }
  return result("medium", [
    `delivery changes ${String(production.length)} production files and ${String(changedLines)} production lines`,
    ...oracleReasons,
  ]);
}

function isProductionPath(filePath) {
  if (/\.(?:md|mdx|txt|json|ya?ml)$/iu.test(filePath) || /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/u.test(filePath))
    return false;
  return /^packages\/[^/]+\/src\//u.test(filePath) || /^tools\/(?!.*\.test\.)[^/]+\.mjs$/u.test(filePath);
}

function isTestOrFixturePath(filePath) {
  return TEST_OR_FIXTURE_SEGMENT.test(filePath) || TEST_OR_FIXTURE_FILE.test(filePath);
}

function isExistingTestOrFixtureChange(file) {
  if (!isTestOrFixturePath(file.path)) return false;
  if (Number(file.deletions ?? 0) > 0) return true;
  return file.status !== "added" && file.status !== "copied";
}

function formatOracleChangeReasons(oracleChanges) {
  if (oracleChanges.length === 0) return [];
  const reasons = oracleChanges.slice(0, MAX_ORACLE_CHANGE_REASONS).map((file) => {
    const status = file.status ?? "modified",
      delta = file.binary ? "binary" : `+${String(file.additions ?? 0)}/-${String(file.deletions ?? 0)}`;
    return `existing test or fixture ${status} (${delta}): ${file.path}`;
  });
  const remaining = oracleChanges.length - reasons.length;
  if (remaining > 0)
    reasons.push(
      `... and ${String(remaining)} more existing test or fixture change(s); total ${String(oracleChanges.length)}`,
    );
  return reasons;
}

function result(minimumTier, reasons) {
  return { schema: "task-risk-tier-result/v1", minimumTier, reasons };
}

async function main() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  process.stdout.write(`${JSON.stringify(assessRepositoryRisk(input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
