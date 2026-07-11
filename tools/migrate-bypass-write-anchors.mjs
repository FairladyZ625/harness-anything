#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scanBypassWriteCalls } from "./check-bypass-write-boundary.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const allowlistPath = path.join(repoRoot, "tools/gate-allowlists/check-bypass-write-boundary.json");

export function migrateBypassWriteAnchors(allowlist, findings) {
  const stableByLegacy = new Map(findings.map((finding) => [finding.legacyKey, finding.key]));
  let migratedCount = 0;
  const entries = structuredClone(allowlist.entries);
  for (const sectionEntries of Object.values(entries)) {
    for (const entry of sectionEntries) {
      const stable = stableByLegacy.get(entry.value);
      if (!stable) throw new Error(`no fs write call matches legacy anchor: ${entry.value}`);
      entry.value = stable;
      migratedCount += 1;
    }
  }
  return { allowlist: { ...allowlist, entries }, migratedCount };
}

function main(args) {
  const write = args.includes("--write");
  const source = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const result = migrateBypassWriteAnchors(source, scanBypassWriteCalls(repoRoot));
  const output = `${JSON.stringify(result.allowlist, null, 2)}\n`;
  if (write) {
    writeFileSync(allowlistPath, output, "utf8");
    console.log(`migrated ${result.migratedCount} bypass write anchors in ${path.relative(repoRoot, allowlistPath)}`);
  } else {
    process.stdout.write(output);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
