#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverWorkspacePackages } from "./workspace-packages.mjs";

const CLI_PACKAGE_NAME = "@harness-anything/cli";

export function checkPackagePolicy(root = process.cwd()) {
  const violations = [];
  const record = (message) => violations.push(message);
  const rootPackage = readJson(path.join(root, "package.json"));
  const lockfile = readJson(path.join(root, "package-lock.json"));
  const workspacePackages = discoverWorkspacePackages(root);

  if (rootPackage.name !== "harness-anything") record("root package name must remain harness-anything");
  if (rootPackage.private !== true) record("root package must remain private until an explicit publish task");

  const names = new Map();
  for (const workspacePackage of workspacePackages) {
    const { manifest: packageJson, manifestPath, relativeRoot } = workspacePackage;
    const lockEntry = lockfile.packages?.[relativeRoot];
    if (!lockEntry) {
      record(`${manifestPath} is a workspace package but is missing from package-lock.json`);
    } else {
      if (packageJson.name !== lockEntry.name) record(`${manifestPath} name ${packageJson.name} does not match package-lock.json ${lockEntry.name}`);
      if (packageJson.version !== lockEntry.version) record(`${manifestPath} version ${packageJson.version} does not match package-lock.json ${lockEntry.version}`);
    }

    if (typeof packageJson.name !== "string" || packageJson.name.trim() === "") {
      record(`${manifestPath} must declare a non-empty package name`);
    } else if (names.has(packageJson.name)) {
      record(`${manifestPath} duplicates package name ${packageJson.name} from ${names.get(packageJson.name)}`);
    } else {
      names.set(packageJson.name, manifestPath);
    }

    if (packageJson.name === CLI_PACKAGE_NAME) {
      checkCliPolicy(packageJson, manifestPath, record);
    } else {
      checkPrivateWorkspacePolicy(packageJson, manifestPath, record);
    }

    const nestedGitPath = `${relativeRoot}/.git`;
    if (existsSync(path.join(root, nestedGitPath))) record(`package-level Git repository is forbidden: ${nestedGitPath}`);
  }

  if (!names.has(CLI_PACKAGE_NAME)) record(`workspace packages must include ${CLI_PACKAGE_NAME}`);
  return { ok: violations.length === 0, violations, workspaceCount: workspacePackages.length };
}

function checkCliPolicy(packageJson, manifestPath, record) {
  if (packageJson.private === true) record(`${manifestPath} must be public-ready for the CLI-only npm publish dry-run preflight`);
  if (packageJson.version !== "0.1.0") record(`${manifestPath} must use version 0.1.0 for the npm publish dry-run preflight`);
  if (packageJson.publishConfig?.access !== "public") record(`${manifestPath} must define publishConfig.access public for the scoped CLI package`);
  if (packageJson.repository?.directory !== "packages/cli") record(`${manifestPath} must declare repository.directory packages/cli`);
  if (packageJson.engines?.node !== ">=24") record(`${manifestPath} must declare Node >=24 runtime support`);
}

function checkPrivateWorkspacePolicy(packageJson, manifestPath, record) {
  if (packageJson.private !== true) record(`${manifestPath} must stay private until npm ownership is explicitly confirmed`);
  if (packageJson.version !== "0.1.0") record(`${manifestPath} must match the unified 0.1.0 release version (operator decision 2026-07-17)`);
  if (packageJson.publishConfig) record(`${manifestPath} must not define publishConfig before the npm publish decision`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function main() {
  const result = checkPackagePolicy();
  if (!result.ok) {
    console.error("Package policy check failed:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Package policy check passed (${result.workspaceCount} workspace package(s)).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
