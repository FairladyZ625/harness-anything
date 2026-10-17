#!/usr/bin/env node
import { readFileSync } from "node:fs";
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag?.startsWith("v")) throw new Error(`Release tag must use v<version>; got ${tag ?? "missing"}`);
const version = tag.slice(1);
const root = JSON.parse(readFileSync("package.json", "utf8"));
const packages = [
  "packages/application/package.json",
  "packages/cli/package.json",
  "packages/daemon/package.json",
  "packages/gui/package.json",
  "packages/kernel/package.json",
  "packages/preset/package.json",
];
const mismatches = [];
if (root.version !== version) mismatches.push(`package.json=${root.version}`);
for (const file of packages) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (pkg.version !== version) mismatches.push(`${file}=${pkg.version}`);
}
if (mismatches.length) throw new Error(`Release version mismatch for ${tag}: ${mismatches.join(", ")}`);
console.log(`Release ${tag} matches root, npm workspaces, and GUI app version.`);
