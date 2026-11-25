#!/usr/bin/env node
/**
 * Static anti-regression gate for Windows portability (Issue #4477 / task_60653ee4139523060fac49b667).
 *
 * Scans repository source and test files under `packages/**` and `tools/**` and blocks
 * three recurring POSIX-only regression patterns from entering `main`:
 *   1. `hardcoded-tmp-sock`: hardcoded `/tmp/*.sock` (or `/private/tmp/*.sock`) path literals
 *      or template literals. Use `os.tmpdir()` / `mkdtempSync` / daemon endpoint helpers.
 *   2. `unguarded-cmd-spawn`: `spawnSync` / `execFileSync` invoking `.cmd`/`.bat` or bare
 *      `npm`/`npx`/`yarn`/`pnpm` commands without `shell` or `cmdShellInvocation(...)`,
 *      which fails with `EINVAL` on Node 24 Windows.
 *   3. `unguarded-posix-mode-assertion`: test assertions comparing file/directory mode bits
 *      against `0o600`/`0o700` without a Windows platform guard (`process.platform !== "win32"`
 *      or equivalent branch/skip).
 *
 * Pre-existing legacy test occurrences are frozen as an exact-count ratchet in
 * `tools/gate-allowlists/check-windows-portability.json` (zero growth allowed; stale entries
 * fail the gate so debt can only shrink).
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";
import { listWorktreeFiles } from "./gates/git.mjs";

const GATE_ID = "check-windows-portability";
const SCAN_ROOTS = ["packages", "tools"];
const SOURCE_FILE_PATTERN = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const IGNORED_DIRS = new Set(["node_modules", "app-node_modules", "dist", "dist-electron", "out", "coverage", ".git"]);
const SELF_EXCLUDED_FILES = new Set([
  "tools/check-windows-portability.mjs",
  "tools/check-windows-portability.test.mjs",
]);
const READ_BATCH_SIZE = 64;

const RULE_SPECS = Object.freeze([
  { id: "hardcoded-tmp-sock", section: "hardcodedTmpSock" },
  { id: "unguarded-cmd-spawn", section: "unguardedCmdSpawn" },
  { id: "unguarded-posix-mode-assertion", section: "unguardedPosixModeAssertion" },
]);

const TMP_SOCK_LITERAL_PATTERN = /(?:^|["'=\s{,(])\/(?:private\/)?tmp\/[^\s"'`},)]*\.sock\b/u;
const TMP_SOCK_TEMPLATE_PATTERN = /\/(?:private\/)?tmp\/[^`]*\.sock\b/u;
const CMD_SHIM_LITERAL_PATTERN = /\.(?:cmd|bat)$/iu;
const BARE_NPM_SHIM_PATTERN = /^(?:npm|npx|yarn|pnpm)$/iu;
const CMD_SPAWN_TEXT_HINT_PATTERN = /(?:\.cmd|\.bat|\b(?:npm|npx|yarn|pnpm)\b)/iu;
const ASSERT_EQUAL_CALLEE_PATTERN = /^assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)$/u;
const EXPECT_MATCHER_PATTERN = /^(?:toBe|toEqual|toStrictEqual)$/u;
const MODE_CONTEXT_PATTERN = /\.mode\b|\b(?:statSync|lstatSync|fstatSync|stat|lstat)\s*\(|\b\w*mode\b/iu;
const TEST_RUNNER_CALLEE_PATTERN = /^(?:test|describe|it)(?:\.\w+)?$/u;

export async function scanWindowsPortability(root = process.cwd(), options = {}) {
  const allowlist = loadGateAllowlist(GATE_ID, {
    allowlistRoot: options.allowlistRoot,
    requiredSections: RULE_SPECS.map((rule) => rule.section),
    report: options.report,
  });
  const frozenBySection = new Map(
    RULE_SPECS.map((rule) => [rule.section, readFrozenSection(allowlist[rule.section], rule.section)]),
  );

  const files = collectScanFiles(root);
  if (files.length === 0) {
    throw new Error(`${GATE_ID}: required scan roots (${SCAN_ROOTS.join(", ")}) contain no source files`);
  }

  const hits = [];
  for (let offset = 0; offset < files.length; offset += READ_BATCH_SIZE) {
    const batch = files.slice(offset, offset + READ_BATCH_SIZE);
    const contents = await Promise.all(batch.map((relativePath) => readFile(path.join(root, relativePath), "utf8")));
    for (let index = 0; index < batch.length; index += 1) {
      const relativePath = batch[index];
      const text = contents[index];
      const checkTmpSock = text.includes("/tmp/") && text.includes(".sock");
      const checkCmdSpawn =
        (text.includes("spawnSync") || text.includes("execFileSync")) && CMD_SPAWN_TEXT_HINT_PATTERN.test(text);
      const checkModeAssert =
        (text.includes("0o600") || text.includes("0o700")) &&
        (text.includes("assert") || text.includes("expect")) &&
        (text.includes(".mode") ||
          text.includes("statSync") ||
          text.includes("lstatSync") ||
          text.includes("fstatSync") ||
          /\b\w+Mode\b/u.test(text));
      if (!checkTmpSock && !checkCmdSpawn && !checkModeAssert) continue;

      const source = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, scriptKindFor(relativePath));
      const cmdBindings = checkCmdSpawn ? collectCmdVariableBindings(source) : new Map();

      const visit = (node) => {
        if (checkTmpSock) {
          const tmpHit = detectHardcodedTmpSock(node, source, relativePath);
          if (tmpHit) hits.push(tmpHit);
        }
        if (checkCmdSpawn) {
          const cmdHit = detectUnguardedCmdSpawn(node, source, relativePath, cmdBindings);
          if (cmdHit) hits.push(cmdHit);
        }
        if (checkModeAssert) {
          const modeHit = detectUnguardedPosixModeAssertion(node, source, relativePath);
          if (modeHit) hits.push(modeHit);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  return evaluateRatchet(files.length, hits, frozenBySection);
}

function collectScanFiles(root) {
  const rawFiles = existsSync(path.join(root, ".git"))
    ? listWorktreeFiles(
        root,
        SCAN_ROOTS.filter((dir) => existsSync(path.join(root, dir))),
      )
    : walkFallbackFiles(root);
  return rawFiles
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => SOURCE_FILE_PATTERN.test(file) && !file.endsWith(".d.ts") && !SELF_EXCLUDED_FILES.has(file))
    .sort();
}

function walkFallbackFiles(root) {
  const results = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        results.push(path.relative(root, fullPath).split(path.sep).join("/"));
      }
    }
  };
  for (const dir of SCAN_ROOTS) {
    const fullDir = path.join(root, dir);
    if (existsSync(fullDir)) walk(fullDir);
  }
  return results;
}

function readFrozenSection(entries, section) {
  if (!Array.isArray(entries)) {
    throw new Error(`${GATE_ID}: entries.${section} must be an array`);
  }
  const byPath = new Map();
  for (const entry of entries) {
    if (typeof entry.path !== "string" || entry.path.trim() === "" || entry.path.startsWith("/")) {
      throw new Error(`${GATE_ID}: entries.${section} entry must have a repository-relative path`);
    }
    if (!Number.isSafeInteger(entry.count) || entry.count <= 0) {
      throw new Error(`${GATE_ID}: entries.${section} entry for ${entry.path} must declare a positive integer count`);
    }
    if (byPath.has(entry.path)) {
      throw new Error(`${GATE_ID}: duplicate entries.${section} path ${entry.path}`);
    }
    byPath.set(entry.path, entry.count);
  }
  return byPath;
}

function evaluateRatchet(scannedFiles, hits, frozenBySection) {
  const violations = [];
  let allowlistedHits = 0;

  for (const rule of RULE_SPECS) {
    const ruleHits = hits.filter((hit) => hit.rule === rule.id);
    const hitsByPath = new Map();
    for (const hit of ruleHits) {
      const group = hitsByPath.get(hit.path) ?? [];
      group.push(hit);
      hitsByPath.set(hit.path, group);
    }

    const frozen = frozenBySection.get(rule.section);
    for (const [filePath, fileHits] of [...hitsByPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const allowedCount = frozen.get(filePath) ?? 0;
      if (fileHits.length <= allowedCount) {
        allowlistedHits += fileHits.length;
        continue;
      }
      allowlistedHits += allowedCount;
      const reported = allowedCount === 0 ? fileHits : fileHits.slice(allowedCount);
      for (const hit of reported) {
        const suffix =
          allowedCount > 0 ? ` (file count ${fileHits.length} exceeds frozen baseline ${allowedCount})` : "";
        violations.push(`${hit.path}:${hit.line}:${hit.column}: [${hit.rule}] ${hit.message}${suffix}`);
      }
    }

    for (const [filePath, allowedCount] of [...frozen.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const actualCount = hitsByPath.get(filePath)?.length ?? 0;
      if (actualCount < allowedCount) {
        violations.push(
          `stale allowlist entry: ${filePath} [${rule.id}] has ${actualCount} occurrence(s), ` +
            `fewer than frozen baseline ${allowedCount} (lower or remove it in tools/gate-allowlists/${GATE_ID}.json)`,
        );
      }
    }
  }

  return {
    ok: violations.length === 0,
    scannedFiles,
    totalHits: hits.length,
    allowlistedHits,
    hits,
    violations,
  };
}

function detectHardcodedTmpSock(node, source, relativePath) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (!TMP_SOCK_LITERAL_PATTERN.test(node.text)) return null;
    const pos = lineCol(source, node.getStart(source));
    return {
      rule: "hardcoded-tmp-sock",
      path: relativePath,
      ...pos,
      message: `hardcoded POSIX /tmp socket literal ${JSON.stringify(node.text)}; use os.tmpdir() / mkdtempSync or a platform-neutral endpoint helper`,
    };
  }
  if (ts.isTemplateExpression(node)) {
    const raw = node.getText(source);
    if (!TMP_SOCK_TEMPLATE_PATTERN.test(raw)) return null;
    const pos = lineCol(source, node.getStart(source));
    return {
      rule: "hardcoded-tmp-sock",
      path: relativePath,
      ...pos,
      message: `hardcoded POSIX /tmp socket template ${raw}; use os.tmpdir() / mkdtempSync or a platform-neutral endpoint helper`,
    };
  }
  return null;
}

function collectCmdVariableBindings(source) {
  const bindings = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const classification = classifyCommandExpression(node.initializer, source, bindings);
      if (classification !== null) bindings.set(node.name.text, classification);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

function classifyCommandExpression(expr, source, bindings) {
  const unwrapped = unwrapExpression(expr);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    if (CMD_SHIM_LITERAL_PATTERN.test(unwrapped.text)) return "explicit-cmd";
    if (BARE_NPM_SHIM_PATTERN.test(unwrapped.text)) return "bare-npm";
    return null;
  }
  if (ts.isTemplateExpression(unwrapped)) {
    const tail = unwrapped.templateSpans.at(-1)?.literal.text ?? "";
    return CMD_SHIM_LITERAL_PATTERN.test(tail) ? "explicit-cmd" : null;
  }
  if (ts.isConditionalExpression(unwrapped)) {
    const polarity = conditionChecksWin32(unwrapped.condition, source);
    if (polarity === "is-win32") return classifyCommandExpression(unwrapped.whenTrue, source, bindings);
    if (polarity === "not-win32") return classifyCommandExpression(unwrapped.whenFalse, source, bindings);
    const left = classifyCommandExpression(unwrapped.whenTrue, source, bindings);
    const right = classifyCommandExpression(unwrapped.whenFalse, source, bindings);
    if (left === "explicit-cmd" || right === "explicit-cmd") return "explicit-cmd";
    if (left === "bare-npm" || right === "bare-npm") return "bare-npm";
    return null;
  }
  if (ts.isCallExpression(unwrapped)) {
    const callee = memberCalleeName(unwrapped.expression);
    if ((callee === "join" || callee === "resolve") && unwrapped.arguments.length > 0) {
      const lastArg = unwrapped.arguments.at(-1);
      if (lastArg && (ts.isStringLiteral(lastArg) || ts.isNoSubstitutionTemplateLiteral(lastArg))) {
        if (CMD_SHIM_LITERAL_PATTERN.test(lastArg.text)) return "explicit-cmd";
      }
    }
    return null;
  }
  if (ts.isIdentifier(unwrapped)) {
    return bindings.get(unwrapped.text) ?? null;
  }
  return null;
}

function detectUnguardedCmdSpawn(node, source, relativePath, bindings) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return null;
  const callee = memberCalleeName(node.expression);
  if (callee !== "spawnSync" && callee !== "execFileSync") return null;

  const cmdArg = node.arguments[0];
  const classification = classifyCommandExpression(cmdArg, source, bindings);
  if (classification === null) return null;

  const optionsArg = extractSpawnOptionsArg(node);
  if (optionsArg && optionsEnableShell(optionsArg)) return null;

  if (classification === "bare-npm" && enclosingWin32GuardPresent(node, source)) return null;

  const pos = lineCol(source, node.getStart(source));
  const cmdDisplay = cmdArg.getText(source).replace(/\s+/gu, " ");
  return {
    rule: "unguarded-cmd-spawn",
    path: relativePath,
    ...pos,
    message:
      `${callee}(${cmdDisplay}, ...) invokes a Windows .cmd/npm shim without shell or cmdShellInvocation(...); ` +
      'pass `shell: process.platform === "win32"` or route through `cmdShellInvocation(...)` to avoid Node 24 EINVAL on Windows',
  };
}

function extractSpawnOptionsArg(callNode) {
  if (callNode.arguments.length >= 3) return callNode.arguments[2];
  if (callNode.arguments.length === 2) {
    const second = unwrapExpression(callNode.arguments[1]);
    if (ts.isObjectLiteralExpression(second)) return second;
  }
  return null;
}

function optionsEnableShell(optionsNode) {
  const unwrapped = unwrapExpression(optionsNode);
  if (!ts.isObjectLiteralExpression(unwrapped)) return false;
  for (const prop of unwrapped.properties) {
    if (ts.isPropertyAssignment(prop) && propertyKeyName(prop.name) === "shell") {
      const value = unwrapExpression(prop.initializer);
      if (value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword) continue;
      if (ts.isIdentifier(value) && value.text === "undefined") continue;
      return true;
    }
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "shell") {
      return true;
    }
    if (ts.isSpreadAssignment(prop) && expressionProvidesEnabledShell(prop.expression)) {
      return true;
    }
  }
  return false;
}

function expressionProvidesEnabledShell(expr) {
  const unwrapped = unwrapExpression(expr);
  if (ts.isObjectLiteralExpression(unwrapped)) return optionsEnableShell(unwrapped);
  if (ts.isConditionalExpression(unwrapped)) {
    return expressionProvidesEnabledShell(unwrapped.whenTrue) || expressionProvidesEnabledShell(unwrapped.whenFalse);
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return expressionProvidesEnabledShell(unwrapped.right);
  }
  return false;
}

function detectUnguardedPosixModeAssertion(node, source, relativePath) {
  if (!ts.isCallExpression(node)) return null;
  if (!matchesModeEqualityAssertion(node, source)) return null;

  const callText = node.getText(source);
  if (!MODE_CONTEXT_PATTERN.test(callText)) return null;

  const unguardedOctal = findUnguardedPosixModeLiteral(node, source);
  if (!unguardedOctal) return null;

  if (enclosingWin32GuardPresent(node, source)) return null;

  const pos = lineCol(source, node.getStart(source));
  return {
    rule: "unguarded-posix-mode-assertion",
    path: relativePath,
    ...pos,
    message:
      `POSIX-only mode assertion (${unguardedOctal}) lacks a Windows platform guard; ` +
      'wrap with `if (process.platform !== "win32")` or branch expected mode for win32',
  };
}

function matchesModeEqualityAssertion(callNode, source) {
  const exprText = callNode.expression.getText(source);
  if (ASSERT_EQUAL_CALLEE_PATTERN.test(exprText)) return true;
  if (
    ts.isPropertyAccessExpression(callNode.expression) &&
    EXPECT_MATCHER_PATTERN.test(callNode.expression.name.text) &&
    callNode.expression.expression.getText(source).startsWith("expect(")
  ) {
    return true;
  }
  return false;
}

function findUnguardedPosixModeLiteral(callNode, source) {
  let found = null;
  const search = (node) => {
    if (found !== null) return;
    if (ts.isConditionalExpression(node) && conditionChecksWin32(node.condition, source) !== null) {
      const polarity = conditionChecksWin32(node.condition, source);
      // If `process.platform === "win32" ? winVal : 0o600`, the else-branch is POSIX-only (safe).
      // Only inspect the branch that executes on win32.
      if (polarity === "is-win32") {
        search(node.whenTrue);
      } else {
        search(node.whenFalse);
      }
      return;
    }
    if (ts.isNumericLiteral(node)) {
      const raw = node.getText(source);
      if (raw === "0o600" || raw === "0o700") {
        found = raw;
        return;
      }
    }
    ts.forEachChild(node, search);
  };
  for (const arg of callNode.arguments) search(arg);
  return found;
}

function enclosingWin32GuardPresent(node, source) {
  let child = node;
  for (let current = node.parent; current; child = current, current = current.parent) {
    if (ts.isIfStatement(current)) {
      const polarity = conditionChecksWin32(current.expression, source);
      if (polarity === "not-win32" && current.thenStatement === child) return true;
      if (polarity === "is-win32" && current.elseStatement === child) return true;
    }
    if (ts.isConditionalExpression(current)) {
      const polarity = conditionChecksWin32(current.condition, source);
      if (polarity === "not-win32" && current.whenTrue === child) return true;
      if (polarity === "is-win32" && current.whenFalse === child) return true;
    }
    if (ts.isBinaryExpression(current)) {
      const polarity = conditionChecksWin32(current.left, source);
      if (
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        polarity === "not-win32" &&
        current.right === child
      ) {
        return true;
      }
      if (
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
        polarity === "is-win32" &&
        current.right === child
      ) {
        return true;
      }
    }
    if (ts.isBlock(current) || ts.isSourceFile(current)) {
      for (const stmt of current.statements) {
        if (stmt.pos >= child.pos) break;
        if (statementExitsEarlyOnWin32(stmt, source)) return true;
      }
    }
    if (ts.isCallExpression(current) && testCallSkipsWin32(current, source)) {
      return true;
    }
  }
  return false;
}

function conditionChecksWin32(expr, source) {
  const text = expr.getText(source);
  if (!/(?:process\.)?platform\b/u.test(text)) return null;
  if (/(?:process\.)?platform\s*!==?\s*["']win32["']/u.test(text)) return "not-win32";
  if (/(?:process\.)?platform\s*===?\s*["'](?:linux|darwin)["']/u.test(text)) return "not-win32";
  if (/(?:process\.)?platform\s*===?\s*["']win32["']/u.test(text)) return "is-win32";
  return null;
}

function statementExitsEarlyOnWin32(stmt, source) {
  if (!ts.isIfStatement(stmt)) return false;
  if (conditionChecksWin32(stmt.expression, source) !== "is-win32") return false;
  const body = stmt.thenStatement.getText(source);
  return /\b(?:return|continue|skip)\b/u.test(body);
}

function testCallSkipsWin32(callNode, source) {
  const callee = callNode.expression.getText(source);
  if (!TEST_RUNNER_CALLEE_PATTERN.test(callee)) return false;
  for (const arg of callNode.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    const text = arg.getText(source);
    if (/\bskip\s*:/u.test(text) && /win32/u.test(text)) return true;
  }
  return false;
}

function memberCalleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

function propertyKeyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function scriptKindFor(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:ts|mts|cts)$/u.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function lineCol(source, position) {
  const { line, character } = source.getLineAndCharacterOfPosition(position);
  return { line: line + 1, column: character + 1 };
}

function printAllowlistSkeleton(hits) {
  const entries = {};
  for (const rule of RULE_SPECS) {
    const counts = new Map();
    for (const hit of hits.filter((candidate) => candidate.rule === rule.id)) {
      counts.set(hit.path, (counts.get(hit.path) ?? 0) + 1);
    }
    entries[rule.section] = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([filePath, count]) => ({
        path: filePath,
        count,
        ref: "task_60653ee4139523060fac49b667",
        reason: `Pre-existing legacy ${rule.id} occurrence(s) frozen at baseline; zero growth allowed.`,
      }));
  }
  console.log(
    JSON.stringify(
      {
        schema: "harness-anything/gate-allowlist/v1",
        gateId: GATE_ID,
        entries,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const rootArg = process.argv.find((arg, index) => index >= 2 && !arg.startsWith("--"));
  const root = rootArg ? path.resolve(rootArg) : process.cwd();
  const printBaseline = process.argv.includes("--print-allowlist");
  const result = await scanWindowsPortability(root, { report: !printBaseline });
  if (printBaseline) {
    printAllowlistSkeleton(result.hits);
    return;
  }
  if (!result.ok) {
    console.error(`Windows portability check failed (${result.violations.length} violation(s)):`);
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Windows portability check passed (${result.scannedFiles} file(s) scanned, ${result.allowlistedHits} frozen baseline hit(s), 0 violations).`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(`Windows portability check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
