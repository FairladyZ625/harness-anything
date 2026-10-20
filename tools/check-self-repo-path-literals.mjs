#!/usr/bin/env node
/**
 * Rejects repo-root-relative directory literals in product source.
 *
 * What it catches: a string literal or template-literal part under
 * packages/*\/src that starts with one of this repository's own directory
 * prefixes and names a directory (trailing slash, or no file extension).
 *
 * Why that shape: the defect class is product behavior keyed on this
 * checkout's layout, e.g. #3815's
 * `deliverables.some((path) => path.startsWith("packages/kernel/src/domain/"))`.
 * A consumer repository never has those paths, so the predicate is silently
 * dead for users. File-shaped contract-provenance strings
 * ("packages/kernel/src/domain/gate-run.ts#SCHEMA") name the file that declares
 * a contract and are validated in-repo; they are not routing predicates.
 *
 * The forbidden prefix list and the per-file exceptions are externalized in
 * tools/gate-allowlists/check-self-repo-path-literals.json. Every entry carries
 * ref+reason, and an exception that no longer fires is stale and fails here.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";
import { listWorktreeFiles } from "./gates/git.mjs";
import { visit } from "./gates/syntax-boundary-utils.mjs";

const gateId = "check-self-repo-path-literals";
const sourceFile = /\.(?:ts|tsx|mts|cts|js|jsx|mjs)$/u;
const productSource = /^packages\/(?:[^/]+\/src|[^/]+\/[^/]+\/src)\//u;

export async function scanSelfRepoPathLiterals(root = process.cwd()) {
  const allowlist = loadGateAllowlist(gateId, {
    requiredSections: ["forbiddenDirectories", "allowlistedUsages"],
  });
  const forbidden = readForbiddenDirectories(allowlist.forbiddenDirectories);
  const allowlisted = readAllowlistedUsages(allowlist.allowlistedUsages, forbidden);

  const files = listWorktreeFiles(root, ["packages"]).filter(
    (file) => productSource.test(file) && sourceFile.test(file),
  );
  if (files.length === 0) {
    throw new Error(`${gateId}: required scan root packages/*/src has no source files`);
  }

  const violations = [];
  const usedAllowlistKeys = new Set();
  let allowlistedHits = 0;

  for (const relative of files) {
    const text = await readFile(path.join(root, relative), "utf8");
    const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, scriptKind(relative));
    visit(source, (node) => {
      for (const part of literalParts(node, source)) {
        if (!namesDirectory(part.text)) continue;
        for (const prefix of forbidden) {
          if (!part.text.startsWith(prefix)) continue;
          const key = allowlistKey(relative, prefix);
          if (allowlisted.has(key)) {
            usedAllowlistKeys.add(key);
            allowlistedHits += 1;
            continue;
          }
          const { line, character } = source.getLineAndCharacterOfPosition(part.start);
          violations.push(
            `${relative}:${line + 1}:${character + 1}: repo-root directory literal ` +
              `${JSON.stringify(part.text)} matches ${JSON.stringify(prefix)}`,
          );
        }
      }
    });
  }

  for (const [key, entry] of allowlisted) {
    if (!usedAllowlistKeys.has(key)) {
      violations.push(
        `stale allowlist entry: ${entry.path} no longer contains a directory literal matching ` +
          `${JSON.stringify(entry.prefix)} (remove it from tools/gate-allowlists/${gateId}.json)`,
      );
    }
  }

  return { scannedFiles: files.length, allowlistedHits, violations };
}

function readForbiddenDirectories(entries) {
  const values = entries.map((entry) => {
    if (typeof entry.value !== "string" || entry.value.trim() === "" || !entry.value.endsWith("/")) {
      throw new Error(
        `${gateId}: forbiddenDirectories entry must have a repository-relative directory value ending in "/"`,
      );
    }
    return entry.value;
  });
  // An emptied policy would turn the gate into a no-op; fail closed instead.
  if (values.length === 0) throw new Error(`${gateId}: forbiddenDirectories must not be empty`);
  if (new Set(values).size !== values.length) throw new Error(`${gateId}: duplicate forbiddenDirectories value`);
  return values;
}

function readAllowlistedUsages(entries, forbidden) {
  const byKey = new Map();
  for (const entry of entries) {
    if (typeof entry.path !== "string" || entry.path.trim() === "" || entry.path.startsWith("/")) {
      throw new Error(`${gateId}: allowlistedUsages entry must have a repository-relative path`);
    }
    if (!Array.isArray(entry.prefixes) || entry.prefixes.length === 0) {
      throw new Error(`${gateId}: allowlistedUsages entry for ${entry.path} must list prefixes`);
    }
    for (const prefix of entry.prefixes) {
      if (!forbidden.includes(prefix)) {
        throw new Error(
          `${gateId}: allowlistedUsages entry for ${entry.path} names ${JSON.stringify(prefix)}, ` +
            "which is not in forbiddenDirectories",
        );
      }
      const key = allowlistKey(entry.path, prefix);
      if (byKey.has(key)) {
        throw new Error(`${gateId}: duplicate allowlistedUsages entry for ${entry.path} / ${prefix}`);
      }
      byKey.set(key, { path: entry.path, prefix });
    }
  }
  return byKey;
}

function literalParts(node, source) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [{ text: node.text, start: node.getStart(source) }];
  }
  if (ts.isTemplateExpression(node)) {
    return [
      { text: node.head.text, start: node.head.getStart(source) },
      ...node.templateSpans.map((span) => ({
        text: span.literal.text,
        start: span.literal.getStart(source),
      })),
    ];
  }
  return [];
}

// A literal names a directory when it ends in "/" or when its last path segment
// has no file extension. "packages/kernel/src/domain/" is a directory prefix;
// "packages/kernel/src/domain/gate-run.ts#SCHEMA" is a file reference.
function namesDirectory(literal) {
  const pathText = literal.split("#")[0];
  if (pathText.endsWith("/")) return true;
  const lastSegment = pathText.slice(pathText.lastIndexOf("/") + 1);
  return !/\.[A-Za-z0-9]+$/u.test(lastSegment);
}

function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:ts|mts|cts)$/u.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function allowlistKey(file, prefix) {
  return `${file}\u0000${prefix}`;
}

async function main() {
  const result = await scanSelfRepoPathLiterals(process.cwd());
  if (result.violations.length > 0) {
    console.error("Repo-root directory literals found in product source:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Self-repo path literal check passed (${result.scannedFiles} product source file(s), ` +
      `${result.allowlistedHits} allowlisted hit(s)).`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`Self-repo path literal check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
