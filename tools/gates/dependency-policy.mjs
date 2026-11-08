import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { changedFiles, git, listWorktreeFiles, pathExistsAt, repoRoot } from "./git.mjs";
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

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Compare exports/conditions by JSON value, not by the object's insertion order. */
function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Node's exports sugar: a string/array/conditional map is the `.` subpath. */
function exportEntries(exportsField) {
  if (!record(exportsField))
    return exportsField === undefined || exportsField === null ? new Map() : new Map([[".", exportsField]]);
  const subpaths = Object.keys(exportsField).filter((key) => key.startsWith("."));
  return subpaths.length > 0
    ? new Map(subpaths.map((key) => [key, exportsField[key]]))
    : new Map([[".", exportsField]]);
}

function exportChanges(before, after) {
  const previous = exportEntries(before),
    next = exportEntries(after),
    added = [...next.keys()].filter((key) => !previous.has(key)).sort(),
    removed = [...previous.keys()].filter((key) => !next.has(key)).sort(),
    changed = [...next.keys()]
      .filter((key) => previous.has(key) && stableValue(previous.get(key)) !== stableValue(next.get(key)))
      .sort();
  return [
    ...added.map((key) => `exports +${JSON.stringify(key)}`),
    ...removed.map((key) => `exports -${JSON.stringify(key)}`),
    ...changed.map((key) => `exports ${JSON.stringify(key)} changed`),
  ];
}

function dependencyChanges(section, before, after) {
  const previous = record(before) ? before : {},
    next = record(after) ? after : {},
    changes = [];
  for (const name of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (Object.hasOwn(next, name) && !Object.hasOwn(previous, name))
      changes.push(`${section}.${name} added ${JSON.stringify(next[name])}`);
    else if (Object.hasOwn(previous, name) && !Object.hasOwn(next, name))
      changes.push(`${section}.${name} removed ${JSON.stringify(previous[name])}`);
    else if (stableValue(previous[name]) !== stableValue(next[name]))
      changes.push(`${section}.${name} ${JSON.stringify(previous[name])} -> ${JSON.stringify(next[name])}`);
  }
  return changes.sort();
}

function revisionExists(rootDir, revision) {
  if (typeof revision !== "string" || revision.length === 0) return false;
  try {
    git(rootDir, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function readManifestAt(rootDir, revision, manifestPath) {
  if (!pathExistsAt(rootDir, revision, manifestPath)) return null;
  return JSON.parse(git(rootDir, ["show", `${revision}:${manifestPath}`]));
}

function manifestDescription(manifestPath, before, after) {
  const changes = [];
  if (before === null) changes.push("added");
  if (after === null) changes.push("removed");
  const previous = before ?? {},
    next = after ?? {};
  changes.push(...exportChanges(previous.exports, next.exports));
  for (const section of DEPENDENCY_SECTIONS)
    changes.push(...dependencyChanges(section, previous[section], next[section]));
  return `${manifestPath}: ${changes.length > 0 ? changes.join("; ") : "no exports or dependency range changes"}`;
}

/**
 * One deterministic declaration description for the same diff G31 judges. The dependency-surface
 * predicate is hasDependencyChange itself; this function only phrases the manifests it selects.
 * Without a repository root (or when the frozen base/head is missing from it), the selected paths
 * still produce a non-none declaration so publication is never blocked on missing history.
 */
export function describeDependencyChange({ paths, rootDir, base, head }) {
  if (!hasDependencyChange(paths)) return "none";
  const dependencyPaths = [...new Set(paths.filter((filePath) => hasDependencyChange([filePath])))].sort(),
    manifests = dependencyPaths.filter((filePath) => filePath !== "package-lock.json"),
    details = [],
    comparable = typeof rootDir === "string" && revisionExists(rootDir, base) && revisionExists(rootDir, head);
  for (const manifestPath of manifests)
    details.push(
      comparable
        ? manifestDescription(
            manifestPath,
            readManifestAt(rootDir, base, manifestPath),
            readManifestAt(rootDir, head, manifestPath),
          )
        : `${manifestPath}: diff detail unavailable (frozen base or head is missing from this checkout)`,
    );
  if (dependencyPaths.includes("package-lock.json")) details.push("package-lock.json changed");
  return details.length > 0 ? details.join("; ") : "dependency surface changed";
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
// and also gates the rewrite-ci dependency-policy job.
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
