import { existsSync, readFileSync, readdirSync } from "node:fs";
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

const coreRunnerFiles = [
  "packages/cli/src/cli/runner-registry.ts",
  ...listTsFiles("packages/cli/src/commands/core")
];

checkFileLines(existingFiles(parserFiles), 250, "CLI parser file");
checkFileLines(existingFiles(extensionExecutorFiles), 250, "extension executor file");
checkFileLines(existingFiles(coreRunnerFiles), 250, "core runner file");
checkFunctions(existingFiles([...parserFiles, ...extensionExecutorFiles, ...coreRunnerFiles]), { maxLines: 120, maxBranches: 40 });
checkCliCommandDescriptorization();
checkCliUtilitySingleSource();

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("CLI structure check passed.");

function listTsFiles(relativeDir) {
  const absolute = path.join(root, relativeDir);
  let entries;
  try {
    entries = readdirSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
    .map((entry) => `${relativeDir}/${entry}`);
}

function listTsFilesRecursive(relativeDir) {
  const absolute = path.join(root, relativeDir);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) return listTsFilesRecursive(relativePath);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [relativePath] : [];
  });
}

function checkFileLines(files, limit, label) {
  for (const file of files) {
    const lines = readLines(file);
    if (lines.length > limit) {
      violations.push(`${file}: ${lines.length} lines exceeds ${label} max ${limit}`);
    }
  }
}

function existingFiles(files) {
  return files.filter((file) => existsSync(path.join(root, file)));
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

function checkCliCommandDescriptorization() {
  const parsedCommandKinds = collectParsedCommandKinds("packages/cli/src/cli/types.ts");
  const descriptorFacts = collectCommandDescriptorFacts();
  const registeredArrays = collectRegisteredDescriptorArrays("packages/cli/src/cli/command-spec/index.ts");
  const registeredFacts = descriptorFacts.filter((fact) => registeredArrays.includes(fact.arrayName));
  const descriptorKinds = registeredFacts.map((fact) => fact.kind);
  const commandRegistry = readSource("packages/cli/src/cli/command-registry.ts");
  const parserRegistry = readSource("packages/cli/src/cli/parser-registry.ts");
  const runnerRegistryPath = "packages/cli/src/cli/runner-registry.ts";
  const runnerRegistry = existsSync(path.join(root, runnerRegistryPath)) ? readSource(runnerRegistryPath) : "";
  const cliEntrypointPaths = existingFiles(["packages/cli/src/index.ts", "packages/cli/src/main.ts"]);
  const cliEntrypoint = cliEntrypointPaths.map(readSource).join("\n");
  const lifecycleExecutorPath = "packages/cli/src/commands/lifecycle.ts";
  const lifecycleExecutor = existsSync(path.join(root, lifecycleExecutorPath)) ? readSource(lifecycleExecutorPath) : "";

  for (const arrayName of new Set(descriptorFacts.map((fact) => fact.arrayName))) {
    const count = registeredArrays.filter((candidate) => candidate === arrayName).length;
    if (count !== 1) {
      violations.push(`packages/cli/src/cli/command-spec/index.ts: descriptor array ${arrayName} must be registered exactly once; found ${count}`);
    }
  }
  for (const arrayName of registeredArrays) {
    if (!descriptorFacts.some((fact) => fact.arrayName === arrayName)) {
      violations.push(`packages/cli/src/cli/command-spec/index.ts: registered descriptor array ${arrayName} was not found in command-spec modules`);
    }
  }
  for (const fact of descriptorFacts) {
    if (!fact.hasDirectParse || !fact.hasDirectRun) {
      violations.push(`${fact.file}:${fact.line}: descriptor ${fact.kind} must carry direct parse and run function references`);
    }
    if (fact.hasDispatchId) {
      violations.push(`${fact.file}:${fact.line}: descriptor ${fact.kind} must not use parserId or runnerId indirection`);
    }
  }
  for (const kind of new Set(descriptorKinds)) {
    const facts = registeredFacts.filter((fact) => fact.kind === kind);
    if (facts.length !== 1) {
      violations.push(`packages/cli/src/cli/command-spec/index.ts: ParsedCommand kind ${kind} must have exactly one registered descriptor; found ${facts.length}`);
    }
  }
  for (const kind of parsedCommandKinds) {
    const count = descriptorKinds.filter((candidate) => candidate === kind).length;
    if (count !== 1) {
      violations.push(`packages/cli/src/cli/command-spec/index.ts: ParsedCommand kind ${kind} must have exactly one registered descriptor; found ${count}`);
    }
  }
  for (const kind of new Set(descriptorKinds.filter((kind) => !parsedCommandKinds.includes(kind)))) {
    violations.push(`packages/cli/src/cli/command-spec/index.ts: descriptor ${kind} has no ParsedCommand action kind`);
  }

  if (!/\bexport\s+const\s+commandDescriptors\s*=\s*commandSpecs\b/u.test(commandRegistry)) {
    violations.push("packages/cli/src/cli/command-registry.ts: commandDescriptors must directly alias commandSpecs");
  }
  if (!/\bcommandSpecs\b/u.test(parserRegistry) || !/\.parse\b/u.test(parserRegistry)) {
    violations.push("packages/cli/src/cli/parser-registry.ts: parser registry must be derived from commandSpecs parse references");
  }
  if (/\bparserId\b|\bcommandKindsForParser\b/u.test(parserRegistry)) {
    violations.push("packages/cli/src/cli/parser-registry.ts: parser registry must not use string parser ids");
  }
  if (!/\bcommandSpecMap\b/u.test(runnerRegistry) || !/\.run\b/u.test(runnerRegistry)) {
    violations.push("packages/cli/src/cli/runner-registry.ts: runner registry must be derived from commandSpecs run references");
  }
  if (/\brunnerId\b|\brunnerIdForAction\b/u.test(runnerRegistry)) {
    violations.push("packages/cli/src/cli/runner-registry.ts: runner registry must not use string runner ids");
  }
  if (!/\brunRegisteredCommand\b/u.test(cliEntrypoint)) {
    violations.push("packages/cli/src/{index,main}.ts: entrypoint must dispatch through runRegisteredCommand");
  }
  if (/\bif\s*\(\s*runnerId\s*===/u.test(cliEntrypoint)) {
    violations.push("packages/cli/src/{index,main}.ts: entrypoint must not hand-dispatch runner ids");
  }
  if (/\bfunction\s+runCommand\b/u.test(lifecycleExecutor)) {
    violations.push("packages/cli/src/commands/lifecycle.ts: lifecycle.ts must not contain catch-all runCommand dispatcher");
  }
}

function collectParsedCommandKinds(file) {
  const sourceFile = parseTypeScript(file);
  const parsedCommand = sourceFile.statements.find((statement) =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === "ParsedCommand"
  );
  if (!parsedCommand) {
    violations.push(`${file}: missing ParsedCommand interface`);
    return [];
  }
  const action = parsedCommand.members.find((member) =>
    ts.isPropertySignature(member) && propertyName(member.name) === "action"
  );
  if (!action?.type) {
    violations.push(`${file}: ParsedCommand must declare an action type`);
    return [];
  }
  const kinds = [];
  function visit(node) {
    if (ts.isPropertySignature(node) && propertyName(node.name) === "kind" && node.type) {
      collectStringLiteralTypes(node.type, kinds);
    }
    ts.forEachChild(node, visit);
  }
  visit(action.type);
  return [...new Set(kinds)];
}

function collectCommandDescriptorFacts() {
  const files = listTsFiles("packages/cli/src/cli/command-spec")
    .filter((file) => path.basename(file).startsWith("command-spec-"));
  return files.flatMap((file) => {
    const sourceFile = parseTypeScript(file);
    const facts = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
        if (!ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== "defineCommandSpecs") continue;
        const descriptors = declaration.initializer.arguments[0];
        if (!descriptors || !ts.isArrayLiteralExpression(descriptors)) continue;
        for (const element of descriptors.elements) {
          if (!ts.isObjectLiteralExpression(element)) continue;
          const properties = new Map(element.properties
            .filter(ts.isPropertyAssignment)
            .map((property) => [propertyName(property.name), property]));
          const kindProperty = properties.get("kind");
          const kind = kindProperty && ts.isStringLiteral(kindProperty.initializer) ? kindProperty.initializer.text : "<unknown>";
          const parseProperty = properties.get("parse");
          const runProperty = properties.get("run");
          facts.push({
            arrayName: declaration.name.text,
            file,
            line: sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1,
            kind,
            hasDirectParse: Boolean(parseProperty && ts.isIdentifier(parseProperty.initializer)),
            hasDirectRun: Boolean(runProperty && ts.isIdentifier(runProperty.initializer)),
            hasDispatchId: properties.has("parserId") || properties.has("runnerId")
          });
        }
      }
    }
    return facts;
  });
}

function collectRegisteredDescriptorArrays(file) {
  const sourceFile = parseTypeScript(file);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "commandSpecs") continue;
      const initializer = declaration.initializer ? unwrapExpression(declaration.initializer) : undefined;
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) continue;
      return initializer.elements
        .filter(ts.isSpreadElement)
        .map((element) => element.expression)
        .filter(ts.isIdentifier)
        .map((identifier) => identifier.text);
    }
  }
  violations.push(`${file}: missing commandSpecs array registry`);
  return [];
}

function collectStringLiteralTypes(node, values) {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    values.push(node.literal.text);
    return;
  }
  ts.forEachChild(node, (child) => collectStringLiteralTypes(child, values));
}

function parseTypeScript(file) {
  return ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function unwrapExpression(expression) {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function checkCliUtilitySingleSource() {
  const utilityAuthorities = new Map([
    ["canonicalPath", "packages/cli/src/cli/path.ts"],
    ["isGeneratedOrVendorPath", "packages/cli/src/cli/path.ts"],
    ["isPathInside", "packages/cli/src/cli/path.ts"],
    ["isSamePath", "packages/cli/src/cli/path.ts"],
    ["normalizeSlashes", "packages/cli/src/cli/path.ts"],
    ["readOption", "packages/cli/src/cli/parse-options.ts"],
    ["readRequiredValueOption", "packages/cli/src/cli/parse-options.ts"]
  ]);
  for (const file of listTsFilesRecursive("packages/cli/src")) {
    const sourceText = readSource(file);
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const fn of findFunctions(sourceFile)) {
      const authority = utilityAuthorities.get(fn.name);
      if (authority && file !== authority) {
        violations.push(`${file}:${fn.startLine}: duplicate ${fn.name} implementation; import from ${authority}`);
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
