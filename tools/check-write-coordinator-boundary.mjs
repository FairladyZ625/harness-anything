#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { entryValues, loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";

const root = process.cwd();
const coordinatorPath = "packages/kernel/src/store/write-journal-coordinator.ts";
const coordinatorFile = path.join(root, coordinatorPath);
const findings = [];

const allowlist = loadGateAllowlist("check-write-coordinator-boundary", {
  requiredSections: ["knownMetabolicDecisionDebt"]
});
const allowedDebt = new Set(entryValues(allowlist.knownMetabolicDecisionDebt));

const metabolicModules = new Map([
  ["../entity/disposition.ts", new Set(["evaluateEntityDisposition"])],
  ["../domain/index.ts", new Set(["isDomainStatus", "isPackageDisposition", "isTerminalStatus"])]
]);

const importedPolicyLocals = new Map();
const text = readFileSync(coordinatorFile, "utf8");

for (const statement of extractImportStatements(text)) {
  const specifier = statement.specifier;
  const bannedNames = metabolicModules.get(specifier);
  if (!bannedNames) continue;

  if (statement.dynamic) {
    record(`dynamic-import:${specifier}`, `dynamic import of metabolic policy module ${specifier}`);
    continue;
  }

  for (const name of statement.named) {
    if (!bannedNames.has(name.imported)) continue;
    importedPolicyLocals.set(name.local, { specifier, imported: name.imported });
    record(`named-import:${specifier}:${name.imported}:${name.local}`, `WriteCoordinator imports metabolic policy ${name.imported} from ${specifier}`);
  }
}

for (const [local, source] of importedPolicyLocals) {
  for (const match of text.matchAll(new RegExp(`(?<![\\w$])${escapeRegExp(local)}\\s*\\(`, "gu"))) {
    if (isImportDeclarationOffset(text, match.index ?? 0)) continue;
    record(
      `call-import:${source.specifier}:${source.imported}:${local}`,
      `WriteCoordinator calls metabolic policy ${local} from ${source.specifier}`
    );
  }
}

if (/\bfunction\s+assertHardDeleteAllowed\s*\(/u.test(text)) {
  record("local-function:assertHardDeleteAllowed", "WriteCoordinator owns hard-delete admissibility logic instead of delegating the policy decision");
}

const stale = [...allowedDebt].filter((entry) => !findings.some((finding) => finding.key === entry));
if (stale.length > 0) {
  findings.push(...stale.map((entry) => ({
    key: entry,
    message: `allowlist entry is stale and should be removed: ${entry}`,
    allowed: false
  })));
}

if (findings.some((finding) => !finding.allowed)) {
  console.error("WriteCoordinator boundary check failed:");
  for (const finding of findings.filter((item) => !item.allowed)) {
    console.error(`- ${finding.key}: ${finding.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(`WriteCoordinator boundary check passed (${findings.length} governed debt finding(s)).`);
}

function record(key, message) {
  const allowed = allowedDebt.has(`${coordinatorPath}#${key}`);
  findings.push({ key: `${coordinatorPath}#${key}`, message, allowed });
}

function extractImportStatements(source) {
  const statements = [];
  const staticPattern = /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;?/gu;
  for (const match of source.matchAll(staticPattern)) {
    statements.push({
      dynamic: false,
      specifier: match[2],
      named: parseNamedImports(match[1] ?? "")
    });
  }

  const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of source.matchAll(dynamicPattern)) {
    statements.push({
      dynamic: true,
      specifier: match[1],
      named: []
    });
  }
  return statements;
}

function parseNamedImports(importClause) {
  const namedMatch = /\{([\s\S]*?)\}/u.exec(importClause);
  if (!namedMatch) return [];
  return namedMatch[1]
    .split(",")
    .map((raw) => raw.trim().replace(/^type\s+/u, ""))
    .filter(Boolean)
    .map((part) => {
      const [imported, local] = part.split(/\s+as\s+/u).map((value) => value.trim()).filter(Boolean);
      return { imported, local: local ?? imported };
    });
}

function isImportDeclarationOffset(source, offset) {
  const lineStart = source.lastIndexOf("\n", offset) + 1;
  return /^\s*import\b/u.test(source.slice(lineStart, offset));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
