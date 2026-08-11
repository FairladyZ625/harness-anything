import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { changedFiles, repoRoot } from "./git.mjs";
import { classifyPath, normalizeRepoPath } from "./module-policy.mjs";
import { parseTestTierMarker } from "../test-tier-manifest.mjs";

const ALL_TIERS = Object.freeze(["fast", "contract", "integration"]);

function tierForTest(filePath, readTestTier) {
  if (readTestTier !== undefined) return readTestTier(filePath);
  if (/(?:^|\/)(?:integration|e2e)(?:\/|\.)|\.integration\.(?:test|spec)\./u.test(filePath)) return "integration";
  if (/(?:^|[.-])contract(?:[./-]|$)/u.test(filePath)) return "contract";
  return "fast";
}

function isGovernancePath(filePath) {
  return filePath === "eslint.config.mjs"
    || filePath === "package.json"
    || filePath === "package-lock.json"
    || filePath.startsWith("tools/gates/")
    || filePath === ".github/workflows/rebuild-gates.yml";
}

export function selectTests(changedPaths, options = {}) {
  const required = new Set();
  const paths = [];
  const proof = [];
  const errors = [];
  let governanceMechanismChanged = false;
  let governanceFixtureChanged = false;
  for (const rawPath of changedPaths) {
    const filePath = normalizeRepoPath(rawPath);
    if (filePath === null) {
      errors.push(`changed path is not normalized: ${rawPath}`);
      continue;
    }
    const classification = classifyPath(filePath);
    if ((filePath.startsWith("tools/gates/") && !filePath.startsWith("tools/gates/test/"))
      || filePath === "eslint.config.mjs"
      || filePath === ".github/workflows/rebuild-gates.yml") governanceMechanismChanged = true;
    if (filePath.startsWith("tools/gates/test/")) governanceFixtureChanged = true;
    const tiers = [];
    if (classification.kind === "production") tiers.push(...ALL_TIERS);
    else if (classification.kind === "test") {
      const tier = tierForTest(filePath, options.readTestTier);
      if (tier === null) tiers.push(...ALL_TIERS);
      else tiers.push(tier);
    }
    else if (isGovernancePath(filePath)) tiers.push("fast", "contract");
    else proof.push(`${filePath}: non-production (${classification.module ?? "unclassified"}/${classification.kind})`);
    for (const tier of tiers) required.add(tier);
    paths.push({ path: filePath, module: classification.module, kind: classification.kind, tiers: [...new Set(tiers)] });
  }
  if (governanceMechanismChanged && !governanceFixtureChanged) errors.push("governance mechanism changes require a tools/gates/test data fixture in the same change");
  if (required.size === 0 && proof.length !== changedPaths.length) errors.push("zero test selection lacks proof that every changed path is non-production");
  return { ok: errors.length === 0, required: ALL_TIERS.filter((tier) => required.has(tier)), paths, proof, errors };
}

function parseArgs(argv) {
  const index = argv.indexOf("--base");
  if (index === -1 || argv[index + 1] === undefined || argv.length !== 2) {
    throw new Error("usage: node tools/gates/test-selection.mjs --base <sha>");
  }
  return argv[index + 1];
}

export function main(argv = process.argv.slice(2)) {
  const base = parseArgs(argv);
  const rootDir = repoRoot();
  const result = selectTests(changedFiles(rootDir, base), {
    readTestTier(filePath) {
      const absolutePath = path.join(rootDir, filePath);
      if (!/\.(?:test|spec)\.(?:mjs|js|ts|tsx)$/u.test(filePath) || !existsSync(absolutePath)) return null;
      return parseTestTierMarker(readFileSync(absolutePath, "utf8"), filePath);
    }
  });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
