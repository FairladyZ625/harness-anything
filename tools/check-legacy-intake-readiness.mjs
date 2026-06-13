#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceFilePattern = /\.(?:ts|tsx|mts|js|jsx|mjs)$/u;
const oldRuntimePatterns = [
  /scripts-refactor/u,
  /scripts\/kernel\/task/u,
  /scripts\/lib\/task-lifecycle/u,
  /scripts\/lib\/task-scanner/u,
  /scripts\/lib\/task-/u,
  /(?:^|\/)(?:states|policies)\.mts/u,
  /\bTaskBinding\b/u
];
const forbiddenApiPatterns = [
  /\brequestTransition\b/u,
  /\bruntimeQueue\b/u,
  /\bproviderNeutralTransition\b/u,
  /(?:^|[.\s{,])rerun\s*[:(]/u,
  /(?:^|[.\s{,])cancel\s*[:(]/u,
  /(?:^|[.\s{,])assign\s*[:(]/u
];
const publicCompatibilityPatterns = [
  /\bcoding-agent-harness\b/u,
  /\bold\s+(?:npm\s+)?api\s+compatib/u,
  /\bold\s+task\s+schema\s+compatib/u,
  /\bold\s+runtime\s+compatib/u,
  /\bautomatic migration\b/u,
  /\bauto-migration\b/u
];
const retiredPackageScriptGatePatterns = [
  /\bcheck-cutover-readiness\b/u,
  /\bsmoke-full-cutover\b/u,
  /\bcutover-readiness\b/u,
  /\bfull-cutover\b/u
];
const minBehaviorCorpusItems = 15;

export async function evaluateLegacyIntakeReadiness(root = process.cwd()) {
  const violations = [];

  checkPackageSurface(root, violations);
  await checkProductionSource(root, violations);
  await checkPublicText(root, violations);
  checkBehaviorCorpusReport(root, violations);

  return violations;
}

function checkPackageSurface(root, violations) {
  const rootPackage = readJson(root, "package.json");
  if (rootPackage.name !== "harness-anything") {
    violations.push(`package.json: root package name must be harness-anything, got ${rootPackage.name}`);
  }
  if (rootPackage.private !== true) {
    violations.push("package.json: root package must stay private until explicit publish approval");
  }
  checkRootPackageScripts(rootPackage, violations);

  const cliPackage = readJson(root, "packages/cli/package.json");
  if (cliPackage.name !== "@harness-anything/cli") {
    violations.push(`packages/cli/package.json: expected @harness-anything/cli, got ${cliPackage.name}`);
  }
  if (cliPackage.scripts?.build !== "tsc -p tsconfig.build.json") {
    violations.push("packages/cli/package.json: build script must compile the package artifact");
  }
  if (cliPackage.bin?.["harness-anything"] !== "./dist/cli/src/index.js") {
    violations.push("packages/cli/package.json: bin.harness-anything must point at ./dist/cli/src/index.js");
  }
  if (cliPackage.exports?.["."] !== "./dist/cli/src/index.js") {
    violations.push("packages/cli/package.json: exports['.'] must point at ./dist/cli/src/index.js");
  }
  if (!Array.isArray(cliPackage.files) || !cliPackage.files.includes("dist")) {
    violations.push("packages/cli/package.json: files must include dist for package artifact smoke");
  }
  if (cliPackage.dependencies?.effect !== rootPackage.dependencies?.effect) {
    violations.push("packages/cli/package.json: effect dependency must match the root package dependency");
  }
  if (cliPackage.publishConfig) {
    violations.push("packages/cli/package.json: publishConfig is not allowed before explicit publish approval");
  }
}

function checkRootPackageScripts(rootPackage, violations) {
  const scripts = rootPackage.scripts;
  if (!scripts || typeof scripts !== "object") return;
  for (const [name, command] of Object.entries(scripts)) {
    const scriptText = `${name} ${String(command)}`;
    for (const pattern of retiredPackageScriptGatePatterns) {
      if (pattern.test(scriptText)) {
        violations.push(`package.json: script ${name} exposes retired full-cutover/cutover readiness gate name`);
        break;
      }
    }
  }
}

async function checkProductionSource(root, violations) {
  const files = await collectFiles(path.join(root, "packages"));
  for (const file of files) {
    const rel = relative(root, file);
    if (isTestFixtureOrGenerated(rel)) continue;
    const text = await readFile(file, "utf8");
    for (const pattern of oldRuntimePatterns) {
      if (pattern.test(text)) {
        violations.push(`${rel}: production source references retired old runtime path or symbol`);
        break;
      }
    }
    for (const pattern of forbiddenApiPatterns) {
      if (pattern.test(text)) {
        violations.push(`${rel}: production source exposes forbidden runtime-control API surface`);
        break;
      }
    }
  }
}

async function checkPublicText(root, violations) {
  const publicTextFiles = await collectPublicTextFiles(root);

  for (const rel of publicTextFiles) {
    const full = path.join(root, rel);
    if (!existsSync(full)) continue;
    const text = await readFile(full, "utf8");
    for (const pattern of oldRuntimePatterns) {
      if (pattern.test(text)) {
        violations.push(`${rel}: public surface references retired old runtime path or symbol`);
        break;
      }
    }
    for (const pattern of forbiddenApiPatterns) {
      if (pattern.test(text)) {
        violations.push(`${rel}: public surface exposes forbidden runtime-control API surface`);
        break;
      }
    }
    for (const pattern of publicCompatibilityPatterns) {
      if (pattern.test(text)) {
        violations.push(`${rel}: public text appears to promise old package/API/runtime compatibility`);
        break;
      }
    }
  }
}

function checkBehaviorCorpusReport(root, violations) {
  const dataPath = path.join(root, "tools/legacy-intake/behavior-corpus-classification.json");
  if (!existsSync(dataPath)) {
    violations.push("tools/legacy-intake/behavior-corpus-classification.json: missing machine-checkable behavior corpus classification input");
    return;
  }
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  const categories = data?.categories;
  if (!categories || typeof categories !== "object") {
    violations.push("tools/legacy-intake/behavior-corpus-classification.json: missing categories object");
    return;
  }
  for (const required of ["preserve", "intentional-change", "old-bug", "unsupported-input", "needs-decision"]) {
    if (!Number.isInteger(categories[required]) || categories[required] < 0) {
      violations.push(`tools/legacy-intake/behavior-corpus-classification.json: missing non-negative integer category ${required}`);
    }
  }
  if (Array.isArray(data?.items)) {
    const actualCounts = Object.fromEntries(Object.keys(categories).map((category) => [category, 0]));
    for (const item of data.items) {
      if (typeof item?.classification === "string" && item.classification in actualCounts) {
        actualCounts[item.classification] += 1;
      } else {
        violations.push("tools/legacy-intake/behavior-corpus-classification.json: item has unknown classification");
      }
    }
    for (const [category, expectedCount] of Object.entries(categories)) {
      if (actualCounts[category] !== expectedCount) {
        violations.push(`tools/legacy-intake/behavior-corpus-classification.json: category ${category} count ${expectedCount} does not match ${actualCounts[category]} item(s)`);
      }
    }
    if (data.items.length < minBehaviorCorpusItems) {
      violations.push(`tools/legacy-intake/behavior-corpus-classification.json: behavior corpus must include at least ${minBehaviorCorpusItems} classified items`);
    }
  } else {
    violations.push("tools/legacy-intake/behavior-corpus-classification.json: missing items array");
  }
  if (categories["needs-decision"] !== 0) {
    violations.push("tools/legacy-intake/behavior-corpus-classification.json: unresolved needs-decision differences remain");
  }

  const reportPath = path.join(root, "tools/legacy-intake/behavior-corpus-classification.md");
  if (!existsSync(reportPath)) {
    violations.push("tools/legacy-intake/behavior-corpus-classification.md: missing behavior corpus classification report");
    return;
  }

  const text = readFileSync(reportPath, "utf8");
  if (!text.includes("behavior-corpus-classification.json")) {
    violations.push("tools/legacy-intake/behavior-corpus-classification.md: report must reference machine-checkable JSON input");
  }
  for (const required of ["preserve", "intentional-change", "old-bug", "unsupported-input"]) {
    if (!text.includes(required)) {
      violations.push(`tools/legacy-intake/behavior-corpus-classification.md: missing ${required} classification category`);
    }
  }
  for (const [category, expectedCount] of Object.entries(categories)) {
    const row = text.split(/\r?\n/u).find((line) => new RegExp(`^\\|\\s*${escapeRegExp(category)}\\s*\\|`, "u").test(line));
    const markdownCount = row?.split("|")[2]?.trim();
    if (markdownCount !== String(expectedCount)) {
      violations.push(`tools/legacy-intake/behavior-corpus-classification.md: Markdown category ${category} count must match JSON count ${expectedCount}`);
    }
  }
  const needsDecisionLine = text.split(/\r?\n/u).find((line) => /^\|\s*needs-decision\s*\|/u.test(line));
  const needsDecisionCount = needsDecisionLine?.split("|")[2]?.trim();
  if (needsDecisionCount !== "0") {
    violations.push("tools/legacy-intake/behavior-corpus-classification.md: unresolved needs-decision differences remain");
  }
}

async function collectPublicTextFiles(root) {
  const files = await collectFiles(root);
  return files
    .map((file) => relative(root, file))
    .filter((rel) => {
      if (rel.startsWith("node_modules/") || rel.startsWith(".git/") || rel.startsWith(".harness") || rel.startsWith("dist/") || rel.startsWith("coverage/")) {
        return false;
      }
      // AGENTS.md / CLAUDE.md are local-only agent entries; check-private-boundary
      // enforces they stay untracked, so they are not public text.
      if (rel === "AGENTS.md" || rel === "CLAUDE.md") return false;
      if (rel === "package-lock.json") return false;
      if (/(?:^|\/)(?:test|tests|fixtures|__fixtures__)\//u.test(rel)) return false;
      return rel.endsWith(".md") || rel.endsWith(".yml") || rel.endsWith(".yaml") || rel.endsWith("package.json");
    });
}

async function collectFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name)) continue;
      files.push(...await collectFiles(full));
    } else if (entry.isFile() && (sourceFilePattern.test(entry.name) || entry.name.endsWith(".md") || entry.name.endsWith(".yml") || entry.name.endsWith(".yaml") || entry.name === "package.json")) {
      files.push(full);
    }
  }
  return files;
}

const ignoredDirectoryNames = new Set([
  ".git",
  ".harness",
  ".harness-private",
  ".worktrees",
  "coverage",
  "dist",
  "node_modules",
  "out"
]);

function readJson(root, rel) {
  return JSON.parse(readFileSync(path.join(root, rel), "utf8"));
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isTestFixtureOrGenerated(rel) {
  return /(?:^|\/)(?:test|tests|fixtures|__fixtures__)\//u.test(rel)
    || /\.test\.[cm]?[jt]s$/u.test(rel)
    || rel.endsWith(".d.ts");
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = await evaluateLegacyIntakeReadiness();
  if (violations.length > 0) {
    console.error("Legacy Intake readiness check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log("Legacy Intake readiness check passed.");
}
