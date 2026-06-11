import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceRoots = [path.join(root, "packages")];
const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const violations = [];
const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const oldRuntimePattern = /scripts\/(?:kernel\/task|lib\/task-)|(?:^|\/)(?:states|policies)\.mts$|TaskBinding/;

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

function resolveImport(file, specifier) {
  if (!specifier.startsWith(".")) return specifier;
  const resolved = path.normalize(path.join(path.dirname(file), specifier));
  return relative(resolved);
}

function importedPathViolates(file, specifier, isForbidden) {
  const resolved = resolveImport(file, specifier);
  return isForbidden(resolved);
}

for (const sourceRoot of sourceRoots) {
  for (const file of await walk(sourceRoot)) {
    const text = await readFile(file, "utf8");
    const rel = relative(file);

    if (rel.startsWith("packages/kernel/src/domain/")) {
      if (/\bfrom\s+["'][^"']*(?:legacy|scripts\/kernel\/task)[^"']*["']/.test(text)) {
        record(file, "domain layer imports legacy runtime");
      }
    }

    const imports = [...text.matchAll(importPattern)].map((match) => match[1] ?? match[2] ?? match[3]);
    if (rel.startsWith("packages/kernel/src/domain/")) {
      for (const specifier of imports) {
        if (/^(?:node:)?(?:fs|process|child_process|path|os|crypto|sqlite|better-sqlite3)$/.test(specifier)) {
          record(file, `domain layer imports IO/runtime module via ${specifier}`);
        }
        if (importedPathViolates(file, specifier, (target) => /packages\/kernel\/src\/(?:ports|application|store)\//.test(target))) {
          record(file, `domain layer imports upper kernel layer via ${specifier}`);
        }
      }
    }

    if (rel.startsWith("packages/kernel/src/ports/")) {
      for (const specifier of imports) {
        if (importedPathViolates(file, specifier, (target) => /packages\/kernel\/src\/(?:application|store)\//.test(target) || /packages\/(?:cli|gui|adapters)\//.test(target) || /^@harness-anything\/(?:cli|gui|adapter-)/.test(target))) {
          record(file, `ports layer imports implementation/controller layer via ${specifier}`);
        }
      }
    }

    if (rel.startsWith("packages/kernel/src/application/")) {
      for (const specifier of imports) {
        if (importedPathViolates(file, specifier, (target) => /packages\/kernel\/src\/store\//.test(target) || /packages\/(?:cli|gui|adapters)\//.test(target) || /^@harness-anything\/(?:cli|gui|adapter-)/.test(target))) {
          record(file, `application layer imports store/adapter/controller implementation via ${specifier}`);
        }
      }
    }

    if (rel.startsWith("packages/gui/")) {
      for (const specifier of imports) {
        if (importedPathViolates(file, specifier, (target) => /packages\/kernel\/src\/store\//.test(target) || /packages\/adapters\//.test(target) || /^@harness-anything\/adapter-/.test(target))) {
          record(file, `GUI imports store or external adapter implementation via ${specifier}`);
        }
      }
    }

    if (rel.startsWith("packages/cli/")) {
      for (const specifier of imports) {
        if (importedPathViolates(file, specifier, (target) => /packages\/gui\//.test(target) || /^@harness-anything\/gui/.test(target))) {
          record(file, `CLI imports GUI layer via ${specifier}`);
        }
      }
    }

    if (/packages\/(?!kernel\/src\/legacy-fixtures)/.test(rel)) {
      for (const specifier of imports) {
        if (oldRuntimePattern.test(specifier)) {
          record(file, `production package imports old runtime via ${specifier}`);
        }
      }
      if (oldRuntimePattern.test(text)) {
        record(file, "production package references old runtime symbol or path");
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
