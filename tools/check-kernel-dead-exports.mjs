#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { entryValues, loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";

const root = process.cwd();
const kernelEntry = "packages/kernel/src/index.ts";
const sourceFilePattern = /\.(?:ts|tsx|mts|js|jsx|mjs)$/u;
const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

const allowlist = loadGateAllowlist("check-kernel-dead-exports", {
  requiredSections: ["zeroConsumptionExports"]
});
const allowedZeroExports = new Set(entryValues(allowlist.zeroConsumptionExports));

const exportedNames = collectKernelExports();
const consumedNames = collectConsumedKernelNames();
const zeroConsumptionExports = exportedNames.filter((name) => !consumedNames.has(name));
const findings = [];

for (const name of zeroConsumptionExports) {
  if (!allowedZeroExports.has(name)) {
    findings.push(`kernel export ${name} has zero non-test consumers and is not allowlisted`);
  }
}

for (const name of allowedZeroExports) {
  if (!zeroConsumptionExports.includes(name)) {
    findings.push(`allowlist entry ${name} is stale because the export now has a consumer or no longer exists`);
  }
}

if (findings.length > 0) {
  console.error("Kernel dead-export check failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Kernel dead-export check passed (${zeroConsumptionExports.length} allowlisted zero-consumption export(s), ${consumedNames.size} consumed export(s)).`);
}

function collectKernelExports() {
  const configPath = path.join(root, "packages/kernel/tsconfig.json");
  if (!configPath) throw new Error("tsconfig.json not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const source = program.getSourceFile(path.join(root, kernelEntry));
  if (!source) throw new Error(`${kernelEntry} is not in the TypeScript program`);
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error(`${kernelEntry} has no module symbol`);
  return checker.getExportsOfModule(symbol)
    .map((item) => String(item.escapedName))
    .filter((name) => name !== "default" && !name.startsWith("__"))
    .sort((left, right) => left.localeCompare(right));
}

function collectConsumedKernelNames() {
  const files = [
    ...walk(path.join(root, "packages")),
    ...walk(path.join(root, "tools"))
  ].filter((file) => !isTestOrFixturePath(relative(file)) && !relative(file).startsWith("packages/kernel/src/"));
  const consumed = new Set();

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier || !isKernelImport(file, specifier)) continue;
      const statement = match[0];
      for (const name of extractNamedImports(statement)) consumed.add(name);
      const namespace = extractNamespaceImport(statement);
      if (namespace) {
        for (const property of extractNamespacePropertyReads(text, namespace)) consumed.add(property);
      }
    }
  }
  return consumed;
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
      files.push(...walk(full));
    } else if (sourceFilePattern.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isTestOrFixturePath(rel) {
  return /(?:^|\/)(?:__fixtures__|fixtures|test|tests)\//u.test(rel) || /\.test\.[cm]?[jt]s$/u.test(rel);
}

function isKernelImport(file, specifier) {
  if (specifier === "@harness-anything/kernel" || specifier.startsWith("@harness-anything/kernel/")) return true;
  if (specifier.includes("kernel/src/")) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = path.relative(root, path.normalize(path.join(path.dirname(file), specifier))).split(path.sep).join("/");
  return resolved === "packages/kernel/src/index.ts" ||
    resolved.startsWith("packages/kernel/src/") ||
    resolved === "packages/kernel/src/index" ||
    resolved.startsWith("packages/kernel/src/index.");
}

function extractNamedImports(statement) {
  const namedMatch = /\{([\s\S]*?)\}/u.exec(statement);
  if (!namedMatch) return [];
  return namedMatch[1]
    .split(",")
    .map((raw) => raw.trim().replace(/^type\s+/u, ""))
    .filter(Boolean)
    .map((part) => part.split(/\s+as\s+/u)[0]?.trim())
    .filter(Boolean);
}

function extractNamespaceImport(statement) {
  const match = /^import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/u.exec(statement.trim());
  return match?.[1] ?? null;
}

function extractNamespacePropertyReads(text, namespace) {
  const properties = new Set();
  const pattern = new RegExp(`(?<![\\\\w$])${escapeRegExp(namespace)}\\\\.([A-Za-z_$][\\\\w$]*)`, "gu");
  for (const match of text.matchAll(pattern)) properties.add(match[1]);
  return properties;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
