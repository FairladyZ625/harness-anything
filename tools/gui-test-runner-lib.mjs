import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

export const guiVitestFilePattern = /\.vitest\.(?:ts|tsx)$/u;
export const guiTestRoots = ["packages/gui/test"];

export async function collectGuiVitestFiles(repoRoot, roots = guiTestRoots) {
  const files = (await Promise.all(roots.map((root) => collectFromDirectory(resolve(repoRoot, root), repoRoot)))).flat();
  return files.sort();
}

async function collectFromDirectory(directory, repoRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
      continue;
    }

    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFromDirectory(entryPath, repoRoot));
      continue;
    }

    if (entry.isFile() && guiVitestFilePattern.test(entry.name)) {
      files.push(relative(repoRoot, entryPath).split("\\").join("/"));
    }
  }

  return files;
}

export function validateGuiVitestManifest(testFiles, manifest) {
  const actual = new Set(testFiles);
  const seen = new Set();
  const errors = [];

  for (const file of manifest) {
    if (!actual.has(file)) {
      errors.push(`GUI Vitest manifest references missing file: ${file}`);
    }
    if (seen.has(file)) {
      errors.push(`GUI Vitest file appears more than once in manifest: ${file}`);
    }
    seen.add(file);
  }

  for (const file of testFiles) {
    if (!seen.has(file)) {
      errors.push(`GUI Vitest file missing from manifest: ${file}`);
    }
  }

  return { errors };
}
