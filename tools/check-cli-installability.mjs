#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cliBuildConfigPath = "packages/cli/tsconfig.build.json";
const bundledPrebuildPlatforms = ["linux-x64", "linux-arm64"];
const fetchedPrebuildInstallers = [
  /\bprebuild-install\b/u,
  /\bnode-pre-gyp\b/u,
  /\bnode-gyp-build(?:-optional-packages)?\b/u
];

export function checkCliInstallability(root = process.cwd()) {
  const violations = [];
  const checked = new Set();
  const prebuildBackedNativePackages = new Set();
  const pending = runtimeWorkspaceRoots(root).flatMap((workspaceRoot) =>
    requiredDependencyEntries(readJson(path.join(root, workspaceRoot, "package.json")))
      .filter(([name]) => !name.startsWith("@harness-anything/"))
      .map(([name]) => ({ name, dependencyRoot: path.join(root, workspaceRoot), chain: [workspaceRoot, name] }))
  );

  while (pending.length > 0) {
    const request = pending.pop();
    const packageRoot = resolveDependencyPackage(request.dependencyRoot, request.name);
    if (!packageRoot) {
      violations.push(`${request.chain.join(" -> ")}: required runtime dependency is not installed`);
      continue;
    }
    const canonicalRoot = realpathSync(packageRoot);
    if (checked.has(canonicalRoot)) continue;
    checked.add(canonicalRoot);

    const manifest = readJson(path.join(canonicalRoot, "package.json"));
    const nativeRisk = nativeInstallRisk(canonicalRoot, manifest);
    if (nativeRisk.kind === "compile-required") {
      violations.push(`${request.chain.join(" -> ")}: ${nativeRisk.reason}; move the capability behind optionalDependencies`);
    } else if (nativeRisk.kind === "prebuild-backed") {
      prebuildBackedNativePackages.add(`${manifest.name}@${manifest.version}`);
    }

    for (const [name] of requiredDependencyEntries(manifest)) {
      pending.push({ name, dependencyRoot: canonicalRoot, chain: [...request.chain, name] });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    checkedPackageCount: checked.size,
    prebuildBackedNativePackages: [...prebuildBackedNativePackages].sort()
  };
}

function runtimeWorkspaceRoots(root) {
  const config = readJson(path.join(root, cliBuildConfigPath));
  const roots = new Set(["packages/cli"]);
  for (const include of config.include ?? []) {
    const match = /^\.\.\/([^/]+)(?:\/([^/]+))?\/src\/\*\*\/\*\.ts$/u.exec(include);
    if (!match) continue;
    roots.add(match[2] ? `packages/${match[1]}/${match[2]}` : `packages/${match[1]}`);
  }
  return [...roots].sort();
}

function requiredDependencyEntries(manifest) {
  const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
  return Object.entries(manifest.dependencies ?? {}).filter(([name]) => !optional.has(name));
}

function resolveDependencyPackage(start, packageName) {
  let current = start;
  while (true) {
    const candidate = path.join(current, "node_modules", ...packageName.split("/"));
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function nativeInstallRisk(packageRoot, manifest) {
  const install = String(manifest.scripts?.install ?? "");
  const hasBindingGyp = existsSync(path.join(packageRoot, "binding.gyp")) || manifest.gypfile === true;
  const invokesLocalCompiler = /\bnode-gyp\b/u.test(install) || (hasBindingGyp && install === "" && manifest.gypfile !== false);
  if (!hasBindingGyp && !invokesLocalCompiler) return { kind: "not-native" };

  if (fetchedPrebuildInstallers.some((pattern) => pattern.test(install))) {
    return { kind: "prebuild-backed" };
  }

  if (/\bprebuilds?\b/u.test(install)) {
    const missing = bundledPrebuildPlatforms.filter((platform) =>
      !existsSync(path.join(packageRoot, "prebuilds", platform))
    );
    if (missing.length === 0) return { kind: "prebuild-backed" };
    return {
      kind: "compile-required",
      reason: `${manifest.name}@${manifest.version} has a native install script but no bundled prebuild for ${missing.join(", ")}`
    };
  }

  return {
    kind: "compile-required",
    reason: `${manifest.name}@${manifest.version} requires local native compilation during install`
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function main() {
  const result = checkCliInstallability();
  if (!result.ok) {
    console.error("CLI installability check failed:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  const prebuildSummary = result.prebuildBackedNativePackages.length > 0
    ? `; prebuild-backed native packages: ${result.prebuildBackedNativePackages.join(", ")}`
    : "";
  console.log(`CLI installability check passed (${result.checkedPackageCount} required runtime package(s)${prebuildSummary}).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
