import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertPublicDependencyClosure, readWorkspacePackages } from "./public-workspaces.mjs";
import { backupName, ownerName } from "./package-exports-lifecycle.mjs";

const root = process.cwd();
const violations = [];
const requiredBins = new Map([
  [
    "@harness-anything/cli",
    new Map([
      ["harness-anything", "dist/cli/src/index.js"],
      ["ha", "dist/cli/src/index.js"],
    ]),
  ],
  ["@harness-anything/daemon", new Map([["harness-anything-daemon", "dist/index.js"]])],
]);

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function record(message) {
  violations.push(message);
}

const rootPackage = readJson("package.json");
if (rootPackage.name !== "harness-anything") record("root package name must remain harness-anything");
if (rootPackage.private !== true) record("root package must remain private until an explicit publish task");
if (!Array.isArray(rootPackage.workspaces) || !rootPackage.workspaces.includes("packages/*")) {
  record("root workspaces must include packages/*");
}

const packages = readWorkspacePackages(root);
for (const entry of packages) {
  const { manifest, packagePath, directory } = entry;
  if (manifest.private === true) {
    if (manifest.version !== "0.0.1") record(`${packagePath} is not in the npm publish set and must use version 0.0.1`);
    if (manifest.publishConfig) record(`${packagePath} must not define publishConfig before the npm publish decision`);
    continue;
  }
  if (manifest.version !== rootPackage.version)
    record(`${packagePath} must use version ${rootPackage.version} for npm publish`);
  if (manifest.publishConfig?.access !== "public")
    record(`${packagePath} must define publishConfig.access public for the scoped npm package`);
  if (manifest.repository?.directory !== directory)
    record(`${packagePath} must declare repository.directory ${directory}`);
  if (manifest.engines?.node !== ">=24") record(`${packagePath} must declare Node >=24 runtime support`);
  const bins = requiredBins.get(manifest.name);
  for (const [name, target] of bins ?? [])
    if (manifest.bin?.[name] !== target) record(`${packagePath} must declare bin ${name} as ${target}`);
  for (const lifecycleFile of [backupName, ownerName])
    if (existsSync(path.join(root, directory, lifecycleFile)))
      record(`${packagePath} was left in package exports rewrite state (${lifecycleFile} exists)`);
}

for (const entry of packages)
  if (existsSync(path.join(root, entry.directory, ".git")))
    record(`package-level Git repository is forbidden: ${entry.packagePath}`);

try {
  assertPublicDependencyClosure(root);
} catch (error) {
  record(error instanceof Error ? error.message : String(error));
}

if (violations.length > 0) {
  console.error("Package policy check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Package policy check passed.");
