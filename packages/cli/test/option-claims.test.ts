// harness-test-tier: fast
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { globalCommandOptions } from "../src/cli/command-spec/command-groups.ts";
import { commandSpecs } from "../src/cli/command-spec/index.ts";
import { specialCommandOptionClaims } from "../src/cli/command-spec/special-command-option-claims.ts";
import { optionFlagToken, validateCommandOptions } from "../src/cli/option-claims.ts";
import { bundledVerticalDefinition } from "../src/commands/extensions/bundled.ts";

const root = path.resolve(".");

test("unknown options fail closed with a nearest legal option", () => {
  assertUnknown(
    ["task", "progress", "append", "task_1", "--text", "probe", "--dryrun"],
    "--dry-run"
  );
  assertUnknown(["task", "list", "--status", "active"], "--state");
  assertUnknown(["daemon", "start", "--servce"], "--service");
  assertUnknown(["agent", "run", "--runtme", "codex"], "--runtime");
});

test("repeated and inline declared inputs remain accepted without passthrough", () => {
  assert.equal(validateCommandOptions([
    "script", "run", "example", "--input", "one=1", "--input", "two=2"
  ]).ok, true);
  assert.equal(validateCommandOptions([
    "decision", "propose", "--surface=--body"
  ]).ok, true);
  assertUnknown(["script", "run", "example", "--", "--dryrun"], "--help");
});

test("declared option sets equal the options read by current parser seams", () => {
  const global = optionSet(globalCommandOptions);
  const specsParsedBy = (parserName: string) => commandSpecs
    .filter((spec) => spec.parse.name === parserName)
    .flatMap(declaredOptions);
  const decisionPropose = commandSpecs.find((spec) => spec.kind === "decision-propose")!;
  const recordFact = commandSpecs.find((spec) => spec.kind === "record-fact")!;
  const daemonSources = [
    ...typescriptFiles(path.join(root, "packages/cli/src/commands/daemon")),
    path.join(root, "packages/cli/src/main.ts"),
    path.join(root, "packages/daemon/src/client/daemon-launch-spec-store.ts"),
    path.join(root, "packages/daemon/src/client/daemon-launch-configuration.ts")
  ];

  const declared = {
    global: sorted(global),
    taskCreate: sorted(without(optionSet(specsParsedBy("parseNewTaskArgs")), global)),
    taskList: sorted(without(optionSet(commandSpecs.find((spec) => spec.kind === "task-list")!.options), global)),
    decisionPropose: sorted(without(optionSet(declaredOptions(decisionPropose)), global)),
    recordFact: sorted(without(optionSet(declaredOptions(recordFact)), global)),
    githubIssues: sorted(without(optionSet(specsParsedBy("parseGithubIssuesArgs")), global)),
    migration: sorted(without(optionSet(specsParsedBy("parseMigrationArgs")), global)),
    agent: sorted(without(specialOptions("agent-"), global)),
    daemon: sorted(without(specialOptions("daemon-"), global)),
    compound: sorted(without(specialOptions("compound-"), global))
  };
  const observed = {
    global: sorted(new Set([
      ...literalOptionsInFunction(path.join(root, "packages/cli/src/cli/parse-options.ts"), "stripGlobalOptions"),
      ...literalOptionsInFunction(path.join(root, "packages/cli/src/cli/parse-args.ts"), "parseHelpRequest")
    ])),
    taskCreate: sorted(without(new Set([
      ...literalOptions(path.join(root, "packages/cli/src/cli/parsers/new-task.ts")),
      ...literalOptions(path.join(root, "packages/cli/src/cli/parsers/decision-surface-inputs.ts")),
      ...literalOptions(path.join(root, "packages/cli/src/cli/json-input.ts"))
    ]), global)),
    taskList: sorted(without(new Set([
      ...literalOptions(path.join(root, "packages/cli/src/cli/parsers/core-task-list.ts")),
      ...(bundledVerticalDefinition()?.entityFieldExtensions ?? [])
        .filter((extension) => extension.projection.queryable)
        .map((extension) => `--${extension.field}`)
    ]), global)),
    decisionPropose: sorted(without(new Set([
      ...literalOptionsInFunction(path.join(root, "packages/cli/src/cli/parsers/decision.ts"), "parseDecisionPropose"),
      ...literalOptionsInFunction(path.join(root, "packages/cli/src/cli/parsers/decision.ts"), "parseEvidenceRelations"),
      ...literalOptions(path.join(root, "packages/cli/src/cli/parsers/decision-propose-inputs.ts")),
      ...literalOptionsInFunction(path.join(root, "packages/cli/src/cli/parsers/decision-fulfillment.ts"), "parseClaimFulfillments"),
      ...literalOptionsInFunction(path.join(root, "packages/cli/src/cli/parsers/decision-surface-inputs.ts"), "parseDecisionSurfaceInputs"),
      ...literalOptionsInFunction(path.join(root, "packages/cli/src/cli/parsers/decision-body.ts"), "readDecisionBody"),
      ...literalOptionsInFunction(path.join(root, "packages/cli/src/cli/json-input.ts"), "extractJsonInput")
    ]), global)),
    recordFact: sorted(without(new Set([
      ...literalOptionsInFunction(path.join(root, "packages/cli/src/cli/parsers/record.ts"), "parseFactRecord"),
      ...literalOptionsInFunction(path.join(root, "packages/cli/src/cli/parsers/record.ts"), "readMemoryTags"),
      ...literalOptionsInFunction(path.join(root, "packages/cli/src/cli/json-input.ts"), "extractJsonInput")
    ]), global)),
    githubIssues: sorted(without(
      new Set(literalOptions(path.join(root, "packages/cli/src/cli/parsers/github-issues.ts"))),
      global
    )),
    migration: sorted(without(
      new Set(literalOptions(path.join(root, "packages/cli/src/cli/parse-migration-args.ts"))),
      global
    )),
    agent: sorted(without(
      semanticOptions(path.join(root, "packages/cli/src/commands/agent-runtime.ts")),
      global
    )),
    daemon: sorted(without(
      new Set(daemonSources.flatMap((file) => [...semanticOptions(file)])),
      global
    )),
    compound: sorted(without(
      semanticOptions(path.join(root, "packages/cli/src/receipt/compound-exit-command.ts")),
      global
    ))
  };

  assert.deepEqual(declared, observed);
});

function assertUnknown(argv: ReadonlyArray<string>, suggestion: string): void {
  const result = validateCommandOptions(argv);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "unknown_option");
  assert.match(result.error.hint, new RegExp(`Did you mean '${escapeRegExp(suggestion)}'\\?`, "u"));
}

function specialOptions(prefix: string): Set<string> {
  return optionSet(
    specialCommandOptionClaims
      .filter((claim) => claim.kind.startsWith(prefix))
      .flatMap((claim) => claim.options)
  );
}

function optionSet(options: ReadonlyArray<{ readonly flag: string }>): Set<string> {
  return new Set(options.map((option) => optionFlagToken(option.flag)));
}

function declaredOptions(spec: {
  readonly options: ReadonlyArray<{ readonly flag: string }>;
  readonly hiddenOptions?: ReadonlyArray<{ readonly flag: string }>;
}): ReadonlyArray<{ readonly flag: string }> {
  return [...spec.options, ...(spec.hiddenOptions ?? [])];
}

function literalOptions(filePath: string): ReadonlyArray<string> {
  const source = sourceFile(filePath);
  const flags = new Set<string>();
  visit(source, (node) => {
    if (ts.isStringLiteralLike(node) && isLongOptionLiteral(node.text)) flags.add(normalizeLiteral(node.text));
  });
  return [...flags];
}

function literalOptionsInFunction(filePath: string, functionName: string): ReadonlyArray<string> {
  const source = sourceFile(filePath);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === functionName
  );
  assert.ok(declaration, `missing ${functionName} in ${filePath}`);
  const flags = new Set<string>();
  visit(declaration, (node) => {
    if (ts.isStringLiteralLike(node) && isLongOptionLiteral(node.text)) flags.add(normalizeLiteral(node.text));
  });
  return [...flags];
}

function semanticOptions(filePath: string): Set<string> {
  const source = sourceFile(filePath);
  const flags = new Set<string>();
  visit(source, (node) => {
    if (!ts.isStringLiteralLike(node) || !isLongOptionLiteral(node.text)) return;
    const parent = node.parent;
    const directCallArgument = ts.isCallExpression(parent) && parent.arguments.includes(node);
    const compared = ts.isBinaryExpression(parent);
    const switched = ts.isCaseClause(parent);
    const exportedFlag = ts.isVariableDeclaration(parent)
      && parent.name.getText(source) === "daemonLaunchOptionsResolvedFlag";
    if (directCallArgument || compared || switched || exportedFlag) flags.add(normalizeLiteral(node.text));
  });
  return flags;
}

function sourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function typescriptFiles(directory: string): ReadonlyArray<string> {
  return readdirSync(directory).flatMap((name) => {
    const entry = path.join(directory, name);
    return statSync(entry).isDirectory()
      ? typescriptFiles(entry)
      : entry.endsWith(".ts")
        ? [entry]
        : [];
  });
}

function without(source: Set<string>, ...excluded: ReadonlyArray<Set<string>>): Set<string> {
  return new Set([...source].filter((flag) => excluded.every((set) => !set.has(flag))));
}

function sorted(values: Set<string>): ReadonlyArray<string> {
  return [...values].sort();
}

function isLongOptionLiteral(value: string): boolean {
  return /^--[a-z0-9-]+=?$/u.test(value);
}

function normalizeLiteral(value: string): string {
  return value.endsWith("=") ? value.slice(0, -1) : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
