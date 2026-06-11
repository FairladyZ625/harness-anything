import { readdir, readFile } from "node:fs/promises";
import { relative } from "node:path";

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const kernelRoot = new URL("../../", import.meta.url);
const repoRoot = new URL("../../../../", import.meta.url);
const sourceFilePattern = /\.(?:ts|mjs|js)$/u;

async function walk(directory: URL): Promise<ReadonlyArray<URL>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: URL[] = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }

    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) {
      files.push(...await walk(entryUrl));
      continue;
    }

    if (entry.isFile() && sourceFilePattern.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(entryUrl);
    }
  }

  return files;
}

export async function readKernelSourceFiles(): Promise<ReadonlyArray<SourceFile>> {
  const files = await walk(new URL("src/", kernelRoot));
  return Promise.all(files.map(async (file) => ({
    path: relative(repoRoot.pathname, file.pathname),
    text: await readFile(file, "utf8")
  })));
}

export async function readKernelSourceFilesUnder(subdirectory: string): Promise<ReadonlyArray<SourceFile>> {
  const files = await walk(new URL(`src/${subdirectory}/`, kernelRoot));
  return Promise.all(files.map(async (file) => ({
    path: relative(repoRoot.pathname, file.pathname),
    text: await readFile(file, "utf8")
  })));
}
