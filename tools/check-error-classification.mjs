import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultScanRoots = [
  "packages/cli/src",
  "packages/kernel/src",
  "packages/adapters"
];

const forbiddenPatterns = [
  {
    name: "message-includes",
    pattern: /\bmessage\.includes\s*\(/u,
    reason: "classify errors with typed error tags or Error subclasses, not message.includes"
  },
  {
    name: "raw-includes",
    pattern: /\braw\.includes\s*\(/u,
    reason: "classify errors with typed error tags, not MalformedSnapshot.raw text"
  },
  {
    name: "stringified-error-includes",
    pattern: /\bString\s*\([^)\n]*(?:error|cause|raw|message)[^)\n]*\)\.includes\s*\(/u,
    reason: "do not classify stringified errors by substring"
  }
];

export function findErrorClassificationViolations(rootDir = process.cwd(), scanRoots = defaultScanRoots) {
  const violations = [];
  for (const scanRoot of scanRoots) {
    const absoluteRoot = path.join(rootDir, scanRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const filePath of listSourceFiles(absoluteRoot)) {
      const relativePath = path.relative(rootDir, filePath).split(path.sep).join("/");
      const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
      lines.forEach((line, index) => {
        for (const forbidden of forbiddenPatterns) {
          if (forbidden.pattern.test(line)) {
            violations.push({
              file: relativePath,
              line: index + 1,
              rule: forbidden.name,
              reason: forbidden.reason,
              source: line.trim()
            });
          }
        }
      });
    }
  }
  return violations;
}

function listSourceFiles(inputPath) {
  const files = [];
  for (const entry of readdirSync(inputPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const fullPath = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".ts")) files.push(fullPath);
  }
  return files;
}

function main() {
  const violations = findErrorClassificationViolations();
  if (violations.length === 0) return;

  console.error("Error classification gate failed:");
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} [${violation.rule}] ${violation.reason}`);
    console.error(`  ${violation.source}`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
