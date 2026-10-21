#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { classifyProtectedChanges, deriveProtectedSurfaceRules } from "./check-pr-governance.mjs";

export const LARGE_PRODUCTION_DELTA_LINES = 500;

export function assessRepositoryRisk(input, root = process.cwd()) {
  if (!input || input.schema !== "task-risk-tier-input/v1" || !Array.isArray(input.delivery?.files))
    throw new Error("Expected task-risk-tier-input/v1 with a delivery file list.");
  const files = input.delivery.files,
    paths = files.map(({ path: filePath }) => filePath),
    protectedChanges = classifyProtectedChanges(
      paths,
      deriveProtectedSurfaceRules(JSON.parse(readFileSync(path.join(root, "tools/gate-manifest.json"), "utf8"))),
    );
  if (protectedChanges.length)
    return result(
      "high",
      protectedChanges.map(({ file, surfaces }) => `protected surface ${surfaces.join(", ")}: ${file}`),
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
    );
  const production = files.filter(({ path: filePath }) => isProductionPath(filePath)),
    changedLines = production.reduce(
      (total, file) => total + file.additions + file.deletions + (file.binary ? 1 : 0),
      0,
    );
  if (changedLines > LARGE_PRODUCTION_DELTA_LINES)
    return result("high", [
      `production diff is ${String(changedLines)} changed lines; high threshold is ${String(LARGE_PRODUCTION_DELTA_LINES)}`,
    ]);
  if (production.length === 0) return result("low", ["delivery contains no production source paths"]);
  if (production.length === 1 && changedLines <= 40)
    return result("low", [`localized production diff is ${String(changedLines)} changed lines in one file`]);
  return result("medium", [
    `delivery changes ${String(production.length)} production files and ${String(changedLines)} production lines`,
  ]);
}

function isProductionPath(filePath) {
  if (/\.(?:md|mdx|txt|json|ya?ml)$/iu.test(filePath) || /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/u.test(filePath))
    return false;
  return /^packages\/[^/]+\/src\//u.test(filePath) || /^tools\/(?!.*\.test\.)[^/]+\.mjs$/u.test(filePath);
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
