import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { changedFiles, repoRoot } from "./git.mjs";
import { writeCiGateResult } from "../ci-gate-result.mjs";

const DEPENDENCY_SECTIONS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
const DECLARATION = /^Dependency-Change:[ \t]*(.*?)\s*$/gmu;

function packageManifestPaths(rootDir) {
  const result = ["package.json"];
  const packagesRoot = path.join(rootDir, "packages");
  if (!existsSync(packagesRoot)) return result;
  const walk = (directory, depth) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(directory, entry.name);
      if (existsSync(path.join(fullPath, "package.json")))
        result.push(path.relative(rootDir, path.join(fullPath, "package.json")).split(path.sep).join("/"));
      if (depth < 1) walk(fullPath, depth + 1);
    }
  };
  walk(packagesRoot, 0);
  return result.sort();
}

export function validateLockfile(rootDir) {
  const lockPath = path.join(rootDir, "package-lock.json");
  if (!existsSync(lockPath)) return ["package-lock.json is required"];
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const errors = [];
  if (!Number.isInteger(lock.lockfileVersion)) errors.push("package-lock.json must declare lockfileVersion");
  for (const manifestPath of packageManifestPaths(rootDir)) {
    const manifest = JSON.parse(readFileSync(path.join(rootDir, manifestPath), "utf8"));
    const lockKey = manifestPath === "package.json" ? "" : path.posix.dirname(manifestPath);
    const locked = lock.packages?.[lockKey];
    if (locked === undefined) {
      errors.push(`package-lock.json is missing workspace entry ${lockKey || "<root>"}`);
      continue;
    }
    for (const section of DEPENDENCY_SECTIONS) {
      const declared = manifest[section] ?? {};
      const snapshot = locked[section] ?? {};
      for (const dependency of new Set([...Object.keys(declared), ...Object.keys(snapshot)])) {
        if (declared[dependency] !== snapshot[dependency]) {
          errors.push(
            `${manifestPath}: ${section}.${dependency} is ${JSON.stringify(declared[dependency])} but lockfile records ${JSON.stringify(snapshot[dependency])}`,
          );
        }
      }
    }
  }
  return errors;
}

export function validateDependencyDeclaration(paths, prBody, declarationRequired = true) {
  if (!declarationRequired) return [];
  const dependencyChanged = paths.some(
    (filePath) => filePath === "package-lock.json" || /(?:^|\/)package\.json$/u.test(filePath),
  );
  if (!dependencyChanged) return [];
  const declarations = [...prBody.matchAll(DECLARATION)].map((match) => match[1]);
  if (declarations.length !== 1)
    return [`dependency changes require exactly one Dependency-Change: declaration; found ${declarations.length}`];
  if (declarations[0].length === 0 || /^(?:none|n\/a)$/iu.test(declarations[0]))
    return ["Dependency-Change: must describe the deterministic dependency change"];
  return [];
}

function parseArgs(argv) {
  const options = { base: null, prBodyFile: null, sbom: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--lock") continue;
    if (arg === "--sbom") {
      options.sbom = true;
      continue;
    }
    if (arg === "--base") {
      options.base = argv[(index += 1)] ?? null;
      continue;
    }
    if (arg === "--pr-body-file") {
      options.prBodyFile = argv[(index += 1)] ?? null;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (options.prBodyFile !== null && options.base === null) {
    throw new Error(
      "usage: node tools/gates/dependency-policy.mjs [--lock] [--sbom] [--base <ref> --pr-body-file <path>]",
    );
  }
  return options;
}

// The Dependency-Change declaration judges the pull request as it is now, so it runs only in the
// pr-body workflow where the live body is fetched per run. Lockfile consistency is body-independent
// and also gates rebuild-gates runs, including pushes to main.
export function main(argv = process.argv.slice(2)) {
  try {
    const { base, prBodyFile, sbom } = parseArgs(argv);
    const rootDir = repoRoot();
    const errors = [...validateLockfile(rootDir)];
    if (prBodyFile !== null) {
      const prBody = readFileSync(prBodyFile, "utf8");
      errors.push(...validateDependencyDeclaration(changedFiles(rootDir, base), prBody));
    }
    console.log("dependency-policy: online advisory lookup skipped (non-required; deterministic gate is offline)");
    if (sbom) console.log("dependency-policy: SBOM reporting is not required by the P2 mission contract");
    writeCiGateResult("G31", errors.length === 0 ? "pass" : "fail", { errors: errors.length });
    if (errors.length > 0) for (const error of errors) console.error(`G31 dependency-policy: ${error}`);
    else console.log("G31 dependency-policy: pass");
    return errors.length === 0 ? 0 : 1;
  } catch (error) {
    writeCiGateResult("G31", "fail", {});
    console.error(`G31 dependency-policy: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
