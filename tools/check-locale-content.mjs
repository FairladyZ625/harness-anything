#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const legacyRoot = "packages/cli/src/commands/extensions/assets/software-coding/templates";
const commandPath = "packages/cli/src/cli/thin-command.ts";

export function checkLocaleContent(options = {}) {
  const rootDir = options.rootDir ?? process.cwd(), failures = [];
  const source = options.commandSource ?? readFileSync(path.join(rootDir, commandPath), "utf8");
  if (hasFiles(options.legacyRoot ?? path.join(rootDir, legacyRoot))) failures.push(`${legacyRoot}: retired localized template content must not return`);
  if (/--locale\b|\blocale:\s*/u.test(source)) failures.push(`${commandPath}: locale selection is not a supported thin CLI contract`);
  if (/\p{C}/u.test(source.replace(/[\n\r\t]/gu, ""))) failures.push(`${commandPath}: command help contains control characters`);
  return { ok: failures.length === 0, failures };
}
function hasFiles(root) { if (!existsSync(root)) return false; return readdirSync(root, { withFileTypes: true }).some((entry) => entry.isFile() || hasFiles(path.join(root, entry.name))); }

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) { const result = checkLocaleContent();
  if (!result.ok) { console.error("Thin CLI locale contract drift detected:"); for (const failure of result.failures) console.error(`- ${failure}`); process.exitCode = 1; } }
