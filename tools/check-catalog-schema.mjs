#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const legacyCatalog = "packages/cli/src/commands/extensions/assets/software-coding/template-catalog.json";
const commandPath = "packages/daemon/src/protocol/daemon-protocol.contract.ts";
const parserPath = "packages/cli/src/cli/thin-command.ts";

export function checkCatalogSchema(options = {}) {
  const rootDir = options.rootDir ?? process.cwd(), failures = [];
  const source = options.commandSource ?? readFileSync(path.join(rootDir, commandPath), "utf8");
  const parser = options.parserSource ?? readFileSync(path.join(rootDir, parserPath), "utf8");
  const entries = [...source.matchAll(/\{[^{}]*\busage:\s*"([^"]+)"\s*,\s*summary:\s*"([^"]*)"[^{}]*\}/gu)].map((match) => ({ usage: match[1], summary: match[2] }));
  if (existsSync(options.legacyCatalog ?? path.join(rootDir, legacyCatalog))) failures.push(`${legacyCatalog}: retired template catalog must not remain`);
  if (entries.length < (options.minimumCommands ?? 13)) failures.push(`${commandPath}: command directory contains ${entries.length} entries`);
  for (const [index, entry] of entries.entries()) {
    if (!entry.usage.startsWith("ha ")) failures.push(`${commandPath}: entries[${index}].usage must start with ha`);
    if (!entry.summary.trim()) failures.push(`${commandPath}: entries[${index}].summary must be non-empty`);
  }
  if (!parser.includes("daemon-protocol.contract.ts") || !parser.includes("resolveThinCliCommand") || !parser.includes("thinCliCommands")) failures.push(`${parserPath}: parser must consume the daemon protocol command directory`);
  if (/\bconst\s+thinCliCommands\s*=/u.test(parser)) failures.push(`${parserPath}: parser must not restore a local command directory`);
  return { ok: failures.length === 0, failures };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) { const result = checkCatalogSchema();
  if (!result.ok) { console.error("Thin command directory schema check failed:"); for (const failure of result.failures) console.error(`- ${failure}`); process.exitCode = 1; }
  else console.log("Thin command directory schema check passed."); }
