import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceRoots = [path.join(root, "packages")];
const sourceFile = /\.(?:ts|mts|js|mjs)$/;
const violations = [];

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...await walk(full));
    } else if (sourceFile.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function record(file, reason) {
  violations.push(`${relative(file)}: ${reason}`);
}

for (const sourceRoot of sourceRoots) {
  for (const file of await walk(sourceRoot)) {
    const text = await readFile(file, "utf8");
    const rel = relative(file);

    if (rel.startsWith("packages/kernel/src/domain/")) {
      if (/\bfrom\s+["'](?:node:)?(?:fs|process|child_process|sqlite|better-sqlite3)["']/.test(text)) {
        record(file, "domain layer imports IO/runtime module");
      }
      if (/\bfrom\s+["'][^"']*(?:legacy|scripts\/kernel\/task)[^"']*["']/.test(text)) {
        record(file, "domain layer imports legacy runtime");
      }
    }

    if (/packages\/(?!kernel\/src\/legacy-fixtures)/.test(rel)) {
      if (/\bfrom\s+["'][^"']*scripts\/kernel\/task[^"']*["']/.test(text)) {
        record(file, "production package imports old task kernel");
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Import boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Import boundary check passed.");

