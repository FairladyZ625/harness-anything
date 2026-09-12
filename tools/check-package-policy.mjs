import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { publicReadyPackagesByPath } from "./public-ready-packages.mjs";

const root = process.cwd();
const expectedPackages = new Map([
  ["packages/kernel/package.json", "@harness-anything/kernel"],
  ["packages/application/package.json", "@harness-anything/application"],
  ["packages/daemon/package.json", "@harness-anything/daemon"],
  ["packages/cli/package.json", "@harness-anything/cli"],
  ["packages/gui/package.json", "@harness-anything/gui"],
  ["packages/adapters/local/package.json", "@harness-anything/adapter-local"],
  ["packages/adapters/multica/package.json", "@harness-anything/adapter-multica"],
]);

const violations = [];

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function record(message) {
  violations.push(message);
}

const rootPackage = readJson("package.json");
if (rootPackage.name !== "harness-anything") record("root package name must remain harness-anything");
if (rootPackage.private !== true) record("root package must remain private until an explicit publish task");
if (
  !Array.isArray(rootPackage.workspaces) ||
  !rootPackage.workspaces.includes("packages/*") ||
  !rootPackage.workspaces.includes("packages/adapters/*")
) {
  record("root workspaces must include packages/* and packages/adapters/*");
}

for (const [relativePath, expectedName] of expectedPackages.entries()) {
  const packageJson = readJson(relativePath);
  if (packageJson.name !== expectedName)
    record(`${relativePath} expected name ${expectedName}, got ${packageJson.name}`);
  const publicContract = publicReadyPackagesByPath.get(relativePath);
  if (publicContract && (publicContract.required || packageJson.private !== true)) {
    if (packageJson.private === true) record(`${relativePath} must be public-ready for npm publish dry-run preflight`);
    if (packageJson.version !== publicContract.version)
      record(`${relativePath} must use version ${publicContract.version} for npm publish dry-run preflight`);
    if (packageJson.publishConfig?.access !== "public")
      record(`${relativePath} must define publishConfig.access public for the scoped npm package`);
    if (packageJson.repository?.directory !== publicContract.repositoryDirectory)
      record(`${relativePath} must declare repository.directory ${publicContract.repositoryDirectory}`);
    if (packageJson.engines?.node !== ">=24") record(`${relativePath} must declare Node >=24 runtime support`);
    for (const [name, target] of Object.entries(publicContract.bins))
      if (packageJson.bin?.[name] !== target) record(`${relativePath} must declare bin ${name} as ${target}`);
  } else {
    if (packageJson.private !== true)
      record(`${relativePath} is not in the approved npm publish set and must stay private`);
    const expectedVersion = relativePath === "packages/gui/package.json" ? "0.0.1" : "0.0.0";
    if (packageJson.version !== expectedVersion) record(`${relativePath} must use version ${expectedVersion}`);
    if (packageJson.publishConfig)
      record(`${relativePath} must not define publishConfig before the npm publish decision`);
  }
}

for (const relativePath of [
  "packages/kernel/.git",
  "packages/application/.git",
  "packages/daemon/.git",
  "packages/cli/.git",
  "packages/gui/.git",
  "packages/adapters/local/.git",
  "packages/adapters/multica/.git",
]) {
  if (existsSync(path.join(root, relativePath))) record(`package-level Git repository is forbidden: ${relativePath}`);
}

if (violations.length > 0) {
  console.error("Package policy check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Package policy check passed.");
