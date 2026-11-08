import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { changedFiles, listWorktreeFiles, repoRoot } from "./git.mjs";
import { writeCiGateResult } from "../ci-gate-result.mjs";

const DEPENDENCY_SECTIONS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
const DECLARATION = /^Dependency-Change:[ \t]*(.*?)\s*$/gmu;

function packageManifestPaths(rootDir) {
  // Workspace manifests are the package.json files git can see under packages/;
  // deeper pack copies (build-resources) are gitignored and never declarations.
  return [
    "package.json",
    ...listWorktreeFiles(rootDir, ["packages"]).filter((file) => path.posix.basename(file) === "package.json"),
  ].sort();
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

/** The dependency surface G31 judges, shared with the PR body renderer so both use one predicate. */
export function hasDependencyChange(paths) {
  return paths.some((filePath) => filePath === "package-lock.json" || /(?:^|\/)package\.json$/u.test(filePath));
}

/** The declaration line format G31 parses, shared with the renderer that writes it. */
export function readDependencyDeclarations(prBody) {
  return [...prBody.matchAll(DECLARATION)].map((match) => match[1]);
}

export function replaceDependencyDeclaration(prBody, description) {
  return prBody.replace(DECLARATION, (declaration) => {
    // G31's line pattern tolerates whitespace after the value (including CRLF); keep it so
    // replacing the declaration never changes the body's line structure.
    const trailingWhitespace = /\s*$/u.exec(declaration)?.[0] ?? "";
    return `Dependency-Change: ${description}${trailingWhitespace}`;
  });
}

export function validateDependencyDeclaration(paths, prBody, declarationRequired = true) {
  if (!declarationRequired) return [];
  if (!hasDependencyChange(paths)) return [];
  const declarations = readDependencyDeclarations(prBody);
  if (declarations.length !== 1)
    return [
      `dependency changes require exactly one \`Dependency-Change: <description>\` line under ## Machine-Readable Declarations; found ${declarations.length}`,
    ];
  if (declarations[0].length === 0 || /^(?:none|n\/a)$/iu.test(declarations[0]))
    return [
      "Dependency-Change: must describe the deterministic dependency change; replace `none` with what changed (for example `bump effect to 2.0.0`)",
    ];
  return [];
}

function parseArgs(argv) {
  const options = { base: null, prBodyFile: null, prBodyEnv: null, sbom: false };
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
    if (arg === "--pr-body-env") {
      options.prBodyEnv = argv[(index += 1)] ?? null;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (options.prBodyFile !== null && options.prBodyEnv !== null) {
    throw new Error("--pr-body-file and --pr-body-env are mutually exclusive");
  }
  if ((options.prBodyFile !== null || options.prBodyEnv !== null) && options.base === null) {
    throw new Error(
      "usage: node tools/gates/dependency-policy.mjs [--lock] [--sbom] [--base <ref> (--pr-body-file <path> | --pr-body-env <name>)]",
    );
  }
  return options;
}

// The Dependency-Change declaration judges the pull request as it is now, so it runs only in the
// pr-body workflow where the live body is fetched per run. Lockfile consistency is body-independent
// and also gates the rewrite-ci dependency-policy job.
export function main(argv = process.argv.slice(2)) {
  try {
    const { base, prBodyFile, prBodyEnv, sbom } = parseArgs(argv);
    const rootDir = repoRoot();
    const errors = [...validateLockfile(rootDir)];
    const prBody =
      prBodyFile !== null
        ? readFileSync(prBodyFile, "utf8")
        : prBodyEnv !== null
          ? (process.env[prBodyEnv] ?? "")
          : null;
    if (prBody !== null) {
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
