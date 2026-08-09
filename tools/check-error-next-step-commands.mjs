#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { entryValues, loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";

const gateId = "check-error-next-step-commands";
const repositoryRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const fixtureRoot = path.join(repositoryRoot, "tools/fixtures/check-error-next-step-commands");
const commandSpecRoot = "packages/cli/src/cli/command-spec";

export function inspectErrorNextStepCommands(rootDir = process.cwd()) {
  const registry = collectCommandContracts(rootDir);
  const { contracts } = registry;
  const findings = [];
  for (const occurrence of collectErrorHints(rootDir)) {
    const commandOrdinals = new Map();
    for (const candidate of extractCommandCandidates(occurrence.hint)) {
      const { command, quoted } = candidate;
      const tokens = tokenize(command);
      const hasLauncher = /^(?:ha|harness-anything)$/u.test(tokens[0] ?? "");
      let routeStart = hasLauncher ? 1 : 0;
      while (hasLauncher && registry.globalOptions.has(tokens[routeStart])) {
        const consumesValue = registry.globalOptions.get(tokens[routeStart]);
        routeStart += consumesValue ? 2 : 1;
      }
      const routeTokens = tokens.slice(routeStart);
      const contract = contracts
        .filter((candidate) => candidate.route.every((token, index) => routeTokens[index] === token))
        .sort((left, right) => right.route.length - left.route.length)[0];
      const commandKind = contract?.route.join(" ")
        ?? routeTokens.filter((token) => !token.startsWith("--") && !/^<[^>]+>$/u.test(token)).slice(0, 3).join(" ")
        ?? "unknown";
      const commandOrdinal = (commandOrdinals.get(commandKind) ?? 0) + 1;
      commandOrdinals.set(commandKind, commandOrdinal);
      const findingScope = `${commandKind || "unknown"}#${commandOrdinal}`;
      if (hasLauncher || contract) addPlaceholderFindings(findings, occurrence, command, findingScope);
      if (command.includes("...")) continue;
      if (!contract) {
        if (hasLauncher && quoted) {
          findings.push({
            ...occurrence,
            command,
            rule: "unknown-command-path",
            findingIdentity: `${findingScope}:path`,
            detail: `copied command path is not registered: ${routeTokens.filter((token) => !token.startsWith("--")).join(" ")}`
          });
        }
        continue;
      }
      if (!hasLauncher) {
        findings.push({
          ...occurrence,
          command,
          rule: "bare-command",
          findingIdentity: `${findingScope}:launcher`,
          detail: "copied registered command is missing the ha launcher"
        });
      }
      const suppliedOptions = new Set(tokens.filter((token) => token.startsWith("--")));
      for (const supplied of suppliedOptions) {
        if (!contract.options.has(supplied)) {
          findings.push({
            ...occurrence,
            command,
            rule: "unknown-option",
            findingIdentity: `${findingScope}:${supplied}`,
            detail: `copied command uses option ${supplied}, which is not declared for ${contract.route.join(" ")}`
          });
        }
      }
      if (!suppliedOptions.has("--help")) {
        for (const required of contract.requiredOptions) {
          if (suppliedOptions.has(required)) continue;
          findings.push({
            ...occurrence,
            command,
            rule: "missing-required-option",
            findingIdentity: `${findingScope}:${required}`,
            detail: `copied command is missing required option ${required}`
          });
        }
        for (const alternatives of contract.requiredOptionGroups) {
          if (alternatives.some((branch) => branch.every((option) => suppliedOptions.has(option)))) continue;
          findings.push({
            ...occurrence,
            command,
            rule: "missing-required-option",
            findingIdentity: `${findingScope}:group:${alternatives.map((branch) => branch.join(" ")).join("|")}`,
            detail: `copied command must include one complete required option branch: ${alternatives.map((branch) => branch.join(" ")).join(" | ")}`
          });
        }
      }
    }
  }
  return { contracts, findings: findings.map(withFindingKey) };
}

export function assessErrorNextStepCommandBaseline(findings, allowedDebtKeys) {
  const allowed = new Set(allowedDebtKeys);
  const current = new Set(findings.map((finding) => finding.key));
  const warnings = findings
    .filter((finding) => allowed.has(finding.key))
    .map((finding) => `known debt ${formatFinding(finding)}`);
  const violations = findings
    .filter((finding) => !allowed.has(finding.key))
    .map((finding) => `new finding ${formatFinding(finding)}`);
  for (const key of allowed) {
    if (!current.has(key)) violations.push(`stale baseline ${key}: remove the repaid entry`);
  }
  return { warnings, violations };
}

export function assessErrorNextStepCommandBaselineRatchet(currentAllowedKeys, previousAllowedKeys) {
  const previous = new Set(previousAllowedKeys);
  return currentAllowedKeys
    .filter((key) => !previous.has(key))
    .map((key) => `baseline growth is forbidden; ${key} was not present in the previous baseline`);
}

function collectCommandContracts(rootDir) {
  const absoluteRoot = path.join(rootDir, commandSpecRoot);
  if (!existsSync(absoluteRoot)) return { contracts: [], globalOptions: new Map() };
  const contracts = [];
  const globalOptions = new Map();
  for (const filePath of walkTypeScriptFiles(absoluteRoot)) {
    const sourceFile = parseSource(filePath);
    const declarations = variableInitializers(sourceFile);
    const globalOptionsNode = unwrapExpression(variableInitializer(sourceFile, "globalCommandOptions"));
    if (globalOptionsNode && ts.isArrayLiteralExpression(globalOptionsNode)) {
      for (const option of globalOptionsNode.elements.filter(ts.isObjectLiteralExpression)) {
        const declaration = staticString(propertyInitializer(option, "flag"));
        if (!declaration) continue;
        const [flag, operand] = declaration.split(/\s+/u);
        if (flag) globalOptions.set(flag, operand !== undefined);
      }
    }
    const specialClaimsNode = unwrapExpression(variableInitializer(sourceFile, "specialCommandOptionClaims"));
    if (specialClaimsNode && ts.isArrayLiteralExpression(specialClaimsNode)) {
      for (const claimNode of specialClaimsNode.elements) {
        if (!ts.isCallExpression(claimNode) || !ts.isIdentifier(claimNode.expression) || claimNode.expression.text !== "claim") continue;
        const routes = evaluateStringMatrix(claimNode.arguments[1]);
        const options = new Set(evaluateOptionFlags(claimNode.arguments[2], declarations));
        for (const route of routes) {
          contracts.push({
            usage: `special:${route.join(" ")}`,
            route,
            options,
            requiredOptions: [],
            requiredOptionGroups: []
          });
        }
      }
    }
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const usage = staticString(propertyInitializer(node, "usage"));
        const optionsNode = propertyInitializer(node, "options");
        if (usage && optionsNode && ts.isArrayLiteralExpression(optionsNode)) {
          const required = requiredOptionContractFromUsage(usage);
          const options = optionsNode.elements
            .filter(ts.isObjectLiteralExpression)
            .map((option) => staticString(propertyInitializer(option, "flag")))
            .filter(Boolean)
            .map((flag) => flag.split(/\s+/u)[0]);
          contracts.push({
            usage,
            route: routeFromUsage(usage),
            options: new Set(options),
            requiredOptions: required.options,
            requiredOptionGroups: required.groups
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return {
    globalOptions,
    contracts: contracts.filter((contract) => contract.route.length > 0).map((contract) => ({
      ...contract,
      options: new Set([...contract.options, ...globalOptions.keys()])
    }))
  };
}

function collectErrorHints(rootDir) {
  const occurrences = [];
  const absoluteCommandSpecRoot = path.join(rootDir, commandSpecRoot);
  for (const absoluteRoot of discoverCallerSourceRoots(rootDir)) {
    for (const filePath of walkTypeScriptFiles(absoluteRoot)) {
      if (filePath === absoluteCommandSpecRoot || filePath.startsWith(`${absoluteCommandSpecRoot}${path.sep}`)) continue;
      const sourceFile = parseSource(filePath);
      const relative = path.relative(rootDir, filePath).split(path.sep).join("/");
      const addHints = (node, owner, identity) => {
        for (const hint of staticStrings(node)) {
          occurrences.push({
            hint,
            location: `${relative}:${sourceFile.getLineAndCharacterOfPosition(owner.getStart()).line + 1}`,
            sourcePath: relative,
            sourceOffset: owner.getStart(),
            identity
          });
        }
      };
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "cliError") {
          addHints(node.arguments[1], node, `call:cliError:${sourceText(node.arguments[0], sourceFile)}`);
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const hintPosition = node.expression.text === "failureReceipt" || node.expression.text === "identityFailure"
            ? 2
            : undefined;
          if (hintPosition !== undefined) {
            addHints(
              node.arguments[hintPosition],
              node,
              `call:${node.expression.text}:${sourceText(node.arguments[1], sourceFile)}`
            );
          }
        }
        if (ts.isPropertyAssignment(node)) {
          const name = propertyNameText(node.name);
          if (name === "defaultHint" || name === "hint" || name === "nextCommand") {
            addHints(node.initializer, node, `property:${name}:${propertyOwnerIdentity(node, sourceFile)}`);
          } else if (name === "message" && ts.isObjectLiteralExpression(node.parent) && objectBoolean(node.parent, "ok") === false) {
            addHints(node.initializer, node, `property:message:${propertyOwnerIdentity(node, sourceFile)}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  const unique = [...new Map(occurrences.map((occurrence) => [
    `${occurrence.sourcePath}\u0000${occurrence.sourceOffset}\u0000${occurrence.hint}`,
    occurrence
  ])).values()];
  const ordinals = new Map();
  return unique.map((occurrence) => {
    const group = `${occurrence.sourcePath}\u0000${occurrence.identity}`;
    const ordinal = (ordinals.get(group) ?? 0) + 1;
    ordinals.set(group, ordinal);
    return {
      hint: occurrence.hint,
      location: occurrence.location,
      sourceIdentity: `${occurrence.sourcePath}#${occurrence.identity}#${ordinal}`
    };
  });
}

function discoverCallerSourceRoots(rootDir) {
  const packagesRoot = path.join(rootDir, "packages");
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesRoot, entry.name, "src"))
    .filter(existsSync);
}

function routeFromUsage(usage) {
  const route = [];
  for (const token of tokenize(usage)) {
    if (/^(?:--|\[|\(|<)/u.test(token)) break;
    route.push(token);
  }
  return route;
}

function requiredOptionContractFromUsage(usage) {
  const visible = [...usage];
  let squareDepth = 0;
  for (let index = 0; index < visible.length; index += 1) {
    if (usage[index] === "[") squareDepth += 1;
    if (squareDepth > 0) visible[index] = " ";
    if (usage[index] === "]") squareDepth = Math.max(0, squareDepth - 1);
  }

  const requiredText = visible.join("");
  const withoutGroups = [...requiredText];
  const groups = [];
  for (const match of requiredText.matchAll(/\(([^()]*)\)/gu)) {
    const branches = match[1]
      .split("|")
      .map((branch) => [...new Set(branch.match(/--[a-z][a-z0-9-]*/giu) ?? [])]);
    if (branches.length > 0 && branches.every((branch) => branch.length > 0)) groups.push(branches);
    const start = match.index ?? 0;
    for (let index = start; index < start + match[0].length; index += 1) withoutGroups[index] = " ";
  }
  return {
    options: [...new Set(withoutGroups.join("").match(/--[a-z][a-z0-9-]*/giu) ?? [])],
    groups
  };
}

function extractCommandCandidates(hint) {
  const commands = [];
  const quoted = /`([^`\n]+)`/gu;
  for (const match of hint.matchAll(quoted)) {
    for (const command of splitCommandChain(match[1])) commands.push({ command, quoted: true });
  }
  if (commands.length > 0) return commands;
  const inline = /\b(?:ha|harness-anything)\s+[^\n.;]+/giu;
  for (const match of hint.matchAll(inline)) {
    for (const command of splitCommandChain(match[0])) commands.push({ command, quoted: false });
  }
  if (commands.length > 0) return commands;
  const imperativeBare = /\brun\s+([a-z][^\n.;]+)/giu;
  for (const match of hint.matchAll(imperativeBare)) {
    const instruction = match[1].split(/\b(?:after|before|then)\b/iu)[0].trim();
    for (const command of splitCommandChain(instruction)) commands.push({ command, quoted: false });
  }
  return commands;
}

function splitCommandChain(command) {
  return command.split(/\s*(?:&&|\|\|)\s*/u).map((part) => part.trim()).filter(Boolean);
}

function addPlaceholderFindings(findings, occurrence, command, findingScope) {
  const placeholders = [...command.matchAll(/<[^>\n]+>/gu)].map((match) => ({
    text: match[0],
    offset: match.index ?? 0
  }));
  const ellipsisOffset = command.indexOf("...");
  if (ellipsisOffset >= 0) placeholders.push({ text: "...", offset: ellipsisOffset });
  const ordinals = new Map();
  for (const placeholder of placeholders) {
    if (placeholder.text === "<context>") continue;
    const ordinal = (ordinals.get(placeholder.text) ?? 0) + 1;
    ordinals.set(placeholder.text, ordinal);
    findings.push({
      ...occurrence,
      command,
      rule: "unresolved-placeholder",
      findingIdentity: `${findingScope}:${placeholder.text}#${ordinal}`,
      detail: `copied command contains unresolved placeholder ${placeholder.text} at character ${placeholder.offset + 1}`
    });
  }
}

function tokenize(text) {
  return (text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/gu) ?? [])
    .map((token) => token.replace(/^['"]|['"]$/gu, "").replace(/[,'".:;]+$/gu, ""));
}

function staticStrings(node) {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [node.head.text + node.templateSpans.map((span) => `<context>${span.literal.text}`).join("")];
  }
  if (ts.isConditionalExpression(node)) return [...staticStrings(node.whenTrue), ...staticStrings(node.whenFalse)];
  if (ts.isParenthesizedExpression(node)) return staticStrings(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStrings(node.left);
    const right = staticStrings(node.right);
    if (left.length > 0 && right.length > 0) return left.flatMap((a) => right.map((b) => a + b));
  }
  return [];
}

function staticString(node) {
  return staticStrings(node)[0];
}

function propertyInitializer(object, name) {
  const property = object.properties.find((candidate) =>
    ts.isPropertyAssignment(candidate) && propertyNameText(candidate.name) === name
  );
  return property?.initializer;
}

function objectBoolean(object, name) {
  const value = propertyInitializer(object, name);
  if (value?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value?.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function propertyOwnerIdentity(property, sourceFile) {
  const object = ts.isObjectLiteralExpression(property.parent) ? property.parent : undefined;
  const code = object ? propertyInitializer(object, "code") : undefined;
  if (code) return `code:${sourceText(code, sourceFile)}`;
  if (object && ts.isPropertyAssignment(object.parent)) {
    return `entry:${sourceText(object.parent.name, sourceFile)}`;
  }
  for (let current = property.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return `function:${current.name.text}`;
    if (ts.isMethodDeclaration(current)) return `method:${sourceText(current.name, sourceFile)}`;
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return `variable:${current.name.text}`;
  }
  return "module";
}

function sourceText(node, sourceFile) {
  return node ? node.getText(sourceFile).replace(/\s+/gu, " ").trim() : "unknown";
}

function propertyNameText(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function variableInitializer(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
    }
  }
  return undefined;
}

function variableInitializers(sourceFile) {
  const declarations = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        declarations.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return declarations;
}

function evaluateStringMatrix(node) {
  const value = unwrapExpression(node);
  if (!value || !ts.isArrayLiteralExpression(value)) return [];
  return value.elements
    .map((row) => {
      const array = unwrapExpression(row);
      if (!array || !ts.isArrayLiteralExpression(array)) return [];
      return array.elements.map(staticString).filter(Boolean);
    })
    .filter((row) => row.length > 0);
}

function evaluateOptionFlags(node, declarations, seen = new Set()) {
  const value = unwrapExpression(node);
  if (!value) return [];
  if (ts.isIdentifier(value)) {
    if (seen.has(value.text)) return [];
    const initializer = declarations.get(value.text);
    if (!initializer) return [];
    return evaluateOptionFlags(initializer, declarations, new Set([...seen, value.text]));
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.flatMap((element) => {
      if (!ts.isObjectLiteralExpression(element)) return [];
      const flag = staticString(propertyInitializer(element, "flag"));
      return flag ? [flag.split(/\s+/u)[0]] : [];
    });
  }
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
    if (value.expression.text === "options") return value.arguments.map(staticString).filter(Boolean);
    if (value.expression.text === "mergeOptions") {
      return [...new Set(value.arguments.flatMap((argument) => evaluateOptionFlags(argument, declarations, seen)))];
    }
  }
  return [];
}

function unwrapExpression(node) {
  let current = node;
  while (current && (
    ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current)
  )) current = current.expression;
  return current;
}

function parseSource(filePath) {
  return ts.createSourceFile(filePath, readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walkTypeScriptFiles(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const absolute = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...walkTypeScriptFiles(absolute));
    else if (entry.isFile() && /\.tsx?$/u.test(entry.name) && !/\.(?:test|spec)\.tsx?$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

function withFindingKey(finding) {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      sourceIdentity: finding.sourceIdentity,
      rule: finding.rule,
      findingIdentity: finding.findingIdentity
    }))
    .digest("hex")
    .slice(0, 16);
  return { ...finding, key: `${finding.sourceIdentity}#${finding.rule}#${digest}` };
}

function formatFinding(finding) {
  return `${finding.key} ${finding.detail}: ${finding.command}`;
}

function previousBaselineKeys() {
  try {
    const raw = execFileSync("git", [
      "show",
      "HEAD^:tools/gate-allowlists/check-error-next-step-commands.json"
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const parsed = JSON.parse(raw);
    return entryValues(parsed.entries?.knownDebt ?? []);
  } catch {
    return null;
  }
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const fixtureIndex = process.argv.indexOf("--fixture");
  if (fixtureIndex >= 0) {
    const fixtureName = process.argv[fixtureIndex + 1] ?? "";
    if (!/^[a-z0-9-]+$/u.test(fixtureName)) throw new Error(`${gateId}: invalid fixture name`);
    const selectedFixture = path.join(fixtureRoot, fixtureName);
    if (!existsSync(selectedFixture)) throw new Error(`${gateId}: unknown fixture ${fixtureName}`);
    const result = inspectErrorNextStepCommands(selectedFixture);
    for (const finding of result.findings) console.error(`ERROR ${formatFinding(finding)}`);
    if (result.findings.length > 0) {
      console.error(`${gateId}: fixture ${fixtureName} failed with ${result.findings.length} finding(s)`);
      process.exitCode = 1;
    } else {
      console.log(`${gateId}: fixture ${fixtureName} passed`);
    }
  } else {
    const result = inspectErrorNextStepCommands();
    const entries = loadGateAllowlist(gateId, {
      requiredSections: ["knownDebt"],
      ratchetSections: ["knownDebt"]
    });
    const allowedDebtKeys = entryValues(entries.knownDebt);
    const assessed = assessErrorNextStepCommandBaseline(result.findings, allowedDebtKeys);
    const previous = previousBaselineKeys();
    if (previous !== null) {
      assessed.violations.push(...assessErrorNextStepCommandBaselineRatchet(allowedDebtKeys, previous));
    }
    for (const warning of assessed.warnings) console.warn(`BASELINE ${warning}`);
    for (const violation of assessed.violations) console.error(`ERROR ${violation}`);
    if (assessed.violations.length > 0) {
      console.error(`${gateId}: failed with ${assessed.violations.length} violation(s)`);
      process.exitCode = 1;
    } else {
      console.log(`${gateId}: passed (${result.contracts.length} command contracts; ${result.findings.length} baseline finding(s))`);
    }
  }
}
