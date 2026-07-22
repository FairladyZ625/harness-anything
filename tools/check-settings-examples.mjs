#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderEnvExample, renderHarnessYamlExample } from "./generate-settings-examples.mjs";

export function checkSettingsExamples(root = process.cwd()) {
  const expected = new Map([
    ["harness.yaml.example", renderHarnessYamlExample()],
    [".env.example", renderEnvExample()]
  ]);
  const findings = [];
  for (const [relativePath, expectedBody] of expected) {
    const filename = path.join(root, relativePath);
    let actualBody;
    try {
      actualBody = readFileSync(filename, "utf8");
    } catch {
      findings.push(`${relativePath} is missing`);
      continue;
    }
    if (actualBody !== expectedBody) findings.push(`${relativePath} differs from the typed landed-settings registry`);
  }
  return { ok: findings.length === 0, findings };
}

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  if (index < 0) return process.cwd();
  const value = argv[index + 1];
  if (!value || argv.length !== index + 2) throw new Error("--root requires one directory path");
  return path.resolve(value);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = checkSettingsExamples(parseRoot(process.argv.slice(2)));
  if (!result.ok) {
    for (const finding of result.findings) console.error(`settings example drift: ${finding}`);
    console.error("Run: node tools/generate-settings-examples.mjs");
    process.exitCode = 1;
  } else {
    console.log("settings examples match the typed landed-settings registry");
  }
}
