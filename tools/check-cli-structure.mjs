import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const violations = [];

const parserFiles = [
  "packages/cli/src/cli/parse-args.ts",
  "packages/cli/src/cli/parser-registry.ts",
  ...listTsFiles("packages/cli/src/cli/parsers")
];

const extensionExecutorFiles = [
  "packages/cli/src/commands/extensions/index.ts",
  "packages/cli/src/commands/extensions/module.ts",
  "packages/cli/src/commands/extensions/preset.ts",
  "packages/cli/src/commands/extensions/shared.ts",
  "packages/cli/src/commands/extensions/template.ts",
  "packages/cli/src/commands/extensions/vertical.ts"
];

checkFileLines(parserFiles, 250, "CLI parser file");
checkFileLines(extensionExecutorFiles, 250, "extension executor file");
checkFunctions([...parserFiles, ...extensionExecutorFiles], { maxLines: 120, maxBranches: 40 });

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("CLI structure check passed.");

function listTsFiles(relativeDir) {
  const absolute = path.join(root, relativeDir);
  return readdirSync(absolute)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
    .map((entry) => `${relativeDir}/${entry}`);
}

function checkFileLines(files, limit, label) {
  for (const file of files) {
    const lines = readLines(file);
    if (lines.length > limit) {
      violations.push(`${file}: ${lines.length} lines exceeds ${label} max ${limit}`);
    }
  }
}

function checkFunctions(files, limits) {
  for (const file of files) {
    const sourceText = readSource(file);
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const fn of findFunctions(sourceFile)) {
      if (fn.lines > limits.maxLines) {
        violations.push(`${file}:${fn.startLine}: function ${fn.name} has ${fn.lines} lines; max ${limits.maxLines}`);
      }
      if (fn.branches > limits.maxBranches) {
        violations.push(`${file}:${fn.startLine}: function ${fn.name} has ${fn.branches} branch markers; max ${limits.maxBranches}`);
      }
    }
  }
}

function findFunctions(sourceFile) {
  const functions = [];

  function visit(node) {
    const name = functionName(node);
    if (name) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const body = node.getText(sourceFile);
      functions.push({
        name,
        startLine: start,
        lines: end - start + 1,
        branches: countBranches(body)
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return functions;
}

function readLines(file) {
  return readSource(file).split(/\r?\n/u);
}

function readSource(file) {
  return readFileSync(path.join(root, file), "utf8");
}

function functionName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return undefined;
}

function countBranches(body) {
  const branchKeywords = body.match(/\b(?:if|for|while|case|catch|switch)\b/gu)?.length ?? 0;
  const ternaries = body.match(/\?/gu)?.length ?? 0;
  return branchKeywords + ternaries;
}
