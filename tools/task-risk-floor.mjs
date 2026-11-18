#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { classifyProtectedChanges, deriveProtectedSurfaceRules } from "./check-pr-governance.mjs";

export const LARGE_PRODUCTION_DELTA_LINES = 500;
const MAX_ORACLE_PATHS = 5;
const MAX_ORACLE_PATH_LENGTH = 240;
const DOC_FILE = /\.mdx?$/iu;
const TEST_SEGMENT = /(?:^|\/)(?:test|tests|__tests__|e2e)\//iu;
const FIXTURE_SEGMENT = /(?:^|\/)(?:__snapshots__|fixtures?)\//iu;
const TEST_OR_FIXTURE_FILE = /\.(?:(?:integration\.)?(?:spec|test)|vitest|fixtures?)\.[^/]+$|\.snap$/iu;

export function assessRepositoryRisk(input, root = process.cwd()) {
  if (!input || input.schema !== "task-risk-tier-input/v1" || !Array.isArray(input.delivery?.files))
    throw new Error("Expected task-risk-tier-input/v1 with a delivery file list.");
  const files = input.delivery.files,
    paths = files.map(({ path: filePath }) => filePath),
    classified = files.map((file) => ({ file, role: deliveryPathRole(file.path) })),
    oracleChanges = classified
      .filter(
        ({ file, role }) =>
          (file.status === "renamed" && file.oldPath && deliveryPathRole(file.oldPath) === "test") ||
          (role === "test" && (file.deletions > 0 || (file.status !== "added" && file.status !== "copied"))),
      )
      .map(({ file }) => file),
    oracleReason = formatOracleChangeReason(oracleChanges),
    protectedChanges = classifyProtectedChanges(
      paths,
      deriveProtectedSurfaceRules(JSON.parse(readFileSync(path.join(root, "tools/gate-manifest.json"), "utf8"))),
    );
  if (protectedChanges.length)
    return result(
      "high",
      protectedChanges.map(({ file, surfaces }) => `protected surface ${surfaces.join(", ")}: ${file}`),
      oracleReason,
    );
  const sensitive = paths.filter((filePath) =>
    /(?:^|\/)(?:migrations?|schema|store|persistence|auth|permissions?|credentials?|secrets?|schedules?|concurrency|leases?|claims?|writers?)(?:\/|\.|$)|^\.github\/|^tools\/gates\/|^tools\/gate-manifest\.json$/iu.test(
      filePath,
    ),
  );
  if (sensitive.length)
    return result(
      "high",
      sensitive.map((filePath) => `sensitive repository surface: ${filePath}`),
      oracleReason,
    );
  const production = classified.filter(({ role }) => role === "production"),
    changedLines = production.reduce(
      (total, { file }) => total + file.additions + file.deletions + (file.binary ? 1 : 0),
      0,
    );
  if (changedLines > LARGE_PRODUCTION_DELTA_LINES)
    return result(
      "high",
      [
        `production diff is ${String(changedLines)} changed lines; high threshold is ${String(LARGE_PRODUCTION_DELTA_LINES)}`,
      ],
      oracleReason,
    );
  if (production.length === 0) {
    if (oracleReason) return result("medium", [], oracleReason);
    return result("low", ["delivery contains no production source paths"]);
  }
  if (production.length === 1 && changedLines <= 40) {
    const localized = `localized production diff is ${String(changedLines)} changed lines in one file`;
    return result(oracleReason ? "medium" : "low", [localized], oracleReason);
  }
  return result(
    "medium",
    [`delivery changes ${String(production.length)} production files and ${String(changedLines)} production lines`],
    oracleReason,
  );
}

function deliveryPathRole(filePath) {
  if (
    FIXTURE_SEGMENT.test(filePath) ||
    TEST_OR_FIXTURE_FILE.test(filePath) ||
    (!DOC_FILE.test(filePath) && TEST_SEGMENT.test(filePath))
  )
    return "test";
  if (/\.(?:md|mdx|txt|json|ya?ml)$/iu.test(filePath)) return "other";
  if (/^packages\/[^/]+\/src\//u.test(filePath) || /^tools\/[^/]+\.mjs$/u.test(filePath)) return "production";
  return "other";
}

function formatOracleChangeReason(oracleChanges) {
  if (!oracleChanges.length) return undefined;
  const examples = oracleChanges.slice(0, MAX_ORACLE_PATHS).map((file) => {
    const status = file.status ?? "modified",
      delta = file.binary ? "binary" : `+${String(file.additions ?? 0)}/-${String(file.deletions ?? 0)}`,
      target = summarizePath(file.path),
      location = status === "renamed" && file.oldPath ? `${summarizePath(file.oldPath)} -> ${target}` : target;
    return `${status} (${delta}): ${location}`;
  });
  const remaining = oracleChanges.length - examples.length;
  if (remaining > 0) examples.push(`… ${String(remaining)} more`);
  // The risk-script reason protocol reserves this prefix for a separate reviewer summary slot.
  return `[review-summary] existing test or fixture changes (total ${String(oracleChanges.length)}): ${examples.join(" | ")}`;
}

function summarizePath(filePath) {
  const half = MAX_ORACLE_PATH_LENGTH / 2;
  return filePath.length <= MAX_ORACLE_PATH_LENGTH ? filePath : `${filePath.slice(0, half)}…${filePath.slice(-half)}`;
}

function result(minimumTier, reasons, reviewSummary) {
  return {
    schema: "task-risk-tier-result/v1",
    minimumTier,
    reasons: reviewSummary ? [...reasons, reviewSummary] : reasons,
  };
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
