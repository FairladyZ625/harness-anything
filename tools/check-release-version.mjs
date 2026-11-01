#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { publicWorkspaceNamesTopologically, readWorkspacePackages } from "./public-workspaces.mjs";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag?.startsWith("v")) throw new Error(`Release tag must use v<version>; got ${tag ?? "missing"}`);
const version = tag.slice(1);
const rootDirectory = path.resolve(process.env.RELEASE_ROOT ?? process.cwd());
const root = JSON.parse(readFileSync(path.join(rootDirectory, "package.json"), "utf8"));
const packages = readWorkspacePackages(rootDirectory);
const publicNames = new Set(publicWorkspaceNamesTopologically(rootDirectory));
const manifestsByName = new Map(packages.map((entry) => [entry.manifest.name, entry.manifest]));
const mismatches = [];
if (root.version !== version) mismatches.push(`package.json=${root.version}`);
for (const entry of packages) {
  if (publicNames.has(entry.manifest.name) && entry.manifest.version !== version)
    mismatches.push(`${entry.packagePath}=${entry.manifest.version}`);
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, value] of Object.entries(entry.manifest[section] ?? {})) {
      if (!publicNames.has(name) || !manifestsByName.has(name) || value === "*") continue;
      if (value !== version) mismatches.push(`${entry.packagePath}:${section}.${name}=${value}`);
    }
  }
}
if (mismatches.length > 0) throw new Error(`Release version mismatch for ${tag}: ${mismatches.join(", ")}`);
console.log(`Release ${tag} matches root, ${publicNames.size} public workspaces, and their internal dependency specs.`);
