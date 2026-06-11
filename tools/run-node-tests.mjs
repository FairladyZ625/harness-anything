#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const roots = ["packages", "tools"];
const testFilePattern = /\.(test|spec)\.(?:mjs|js|ts)$/u;
const ignoredDirectoryNames = new Set(["node_modules", "dist", "coverage", ".git"]);

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || ignoredDirectoryNames.has(entry.name)) {
      continue;
    }

    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(entryPath));
      continue;
    }

    if (entry.isFile() && testFilePattern.test(entry.name)) {
      files.push(relative(repoRoot, entryPath));
    }
  }

  return files;
}

const testFiles = (
  await Promise.all(roots.map((root) => collectTestFiles(resolve(repoRoot, root))))
).flat().sort();

if (testFiles.length === 0) {
  console.log("No node test files found.");
  process.exit(0);
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  cwd: repoRoot,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal !== null) {
    console.error(`node --test terminated by signal ${signal}`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
