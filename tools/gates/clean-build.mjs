import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeRepoPath } from "./module-policy.mjs";
import { repoRoot } from "./git.mjs";

const GENERATED_SEGMENT = /(?:^|\/)(?:build|dist|out)(?:\/|$)/u;

function run(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { ok: result.status === 0, status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function manifestPaths(rootDir) {
  const paths = ["package.json"];
  const packagesRoot = path.join(rootDir, "packages");
  if (!existsSync(packagesRoot)) return paths;
  const walk = (directory, depth) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(directory, entry.name);
      const manifest = path.join(fullPath, "package.json");
      if (existsSync(manifest)) paths.push(path.relative(rootDir, manifest).split(path.sep).join("/"));
      if (depth < 1) walk(fullPath, depth + 1);
    }
  };
  walk(packagesRoot, 0);
  return paths.sort();
}

function targetStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(targetStrings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(targetStrings);
  return [];
}

function manifestTargets(manifest) {
  return [...new Set([
    ...targetStrings(manifest.exports),
    ...targetStrings(manifest.imports),
    ...targetStrings(manifest.bin),
    ...targetStrings(manifest.main),
    ...targetStrings(manifest.types)
  ])];
}

function inspectTargets(rootDir, manifests, stage) {
  const errors = [];
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(readFileSync(path.join(rootDir, manifestPath), "utf8"));
    const packageRoot = path.dirname(path.join(rootDir, manifestPath));
    for (const target of manifestTargets(manifest)) {
      const normalized = normalizeRepoPath(target.replace(/^\.\//u, ""));
      if (normalized === null) {
        errors.push(`${manifestPath}: invalid export/bin target ${target}`);
        continue;
      }
      const absoluteTarget = path.join(packageRoot, normalized);
      if (stage === "before" && GENERATED_SEGMENT.test(normalized) && existsSync(absoluteTarget)) {
        errors.push(`${manifestPath}: generated target is present before the clean build: ${target}`);
      }
      if (stage === "after" && !existsSync(absoluteTarget)) errors.push(`${manifestPath}: unresolved export/bin target after build: ${target}`);
    }
  }
  return errors;
}

function sourceDistReferences(rootDir) {
  const errors = [];
  const sourceImport = /\b(?:from\s*|import\s*\()\s*["'](?:\.\.?\/)+(?:[^"']*\/)?(?:dist|build|out)\//u;
  const walk = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["dist", "build", "out", "node_modules"].includes(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (/\.(?:c|m)?js$|\.(?:d\.)?tsx?$/u.test(entry.name) && sourceImport.test(readFileSync(fullPath, "utf8"))) {
        errors.push(`${path.relative(rootDir, fullPath).split(path.sep).join("/")}: source imports a generated dist/build/out path`);
      }
    }
  };
  for (const directory of ["packages", "src"]) walk(path.join(rootDir, directory));
  return errors;
}

function createArchiveTree(rootDir) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rebuild-clean-build-"));
  const archive = spawnSync("git", ["archive", "--format=tar", "HEAD"], { cwd: rootDir, maxBuffer: 128 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive failed: ${String(archive.stderr)}`);
  const extract = spawnSync("tar", ["-xf", "-", "-C", tempRoot], { input: archive.stdout, maxBuffer: 128 * 1024 * 1024 });
  if (extract.status !== 0) throw new Error(`tar extraction failed: ${String(extract.stderr)}`);
  const dependencies = path.join(rootDir, "node_modules");
  if (existsSync(dependencies)) symlinkSync(dependencies, path.join(tempRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return tempRoot;
}

export function evaluateCleanBuild(rootDir) {
  const tempRoot = createArchiveTree(rootDir);
  const errors = [];
  const commands = [];
  try {
    const manifests = manifestPaths(tempRoot);
    errors.push(...inspectTargets(tempRoot, manifests, "before"));
    errors.push(...sourceDistReferences(tempRoot));
    const rootManifest = JSON.parse(readFileSync(path.join(tempRoot, "package.json"), "utf8"));
    const rootBuild = rootManifest.scripts?.build !== undefined ? "build" : rootManifest.scripts?.typecheck !== undefined ? "typecheck" : null;
    if (rootBuild !== null) {
      const result = run("npm", ["run", rootBuild], { cwd: tempRoot });
      commands.push(`npm run ${rootBuild}`);
      if (!result.ok) errors.push(`clean ${rootBuild} failed (${result.status}): ${result.output}`);
    }
    for (const manifestPath of manifests.filter((entry) => entry !== "package.json")) {
      const manifest = JSON.parse(readFileSync(path.join(tempRoot, manifestPath), "utf8"));
      if (manifest.scripts?.build === undefined) continue;
      const unresolvedRuntimeTarget = [...targetStrings(manifest.exports), ...targetStrings(manifest.bin), ...targetStrings(manifest.main)]
        .some((target) => !existsSync(path.join(path.dirname(path.join(tempRoot, manifestPath)), target.replace(/^\.\//u, ""))));
      if (!unresolvedRuntimeTarget) continue;
      const result = run("npm", ["run", "build", "--workspace", manifest.name], { cwd: tempRoot });
      commands.push(`npm run build --workspace ${manifest.name}`);
      if (!result.ok) errors.push(`${manifestPath} clean build failed (${result.status}): ${result.output}`);
    }
    errors.push(...inspectTargets(tempRoot, manifests, "after"));
    return { ok: errors.length === 0, errors, commands };
  } finally {
    if (existsSync(tempRoot) && lstatSync(tempRoot).isDirectory()) rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== "--temp") throw new Error("usage: node tools/gates/clean-build.mjs --temp");
  const result = evaluateCleanBuild(repoRoot());
  for (const command of result.commands) console.log(`clean-build: ${command}`);
  if (!result.ok) for (const error of result.errors) console.error(`G30 clean-build: ${error}`);
  else console.log("G30 clean-build: pass (archive tree; exports/imports resolution; no tracked generated targets)");
  return result.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
