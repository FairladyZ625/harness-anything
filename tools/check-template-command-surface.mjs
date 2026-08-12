#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const legacyRoot = "packages/cli/src/commands/extensions/assets/software-coding/templates";
const commandPath = "packages/cli/src/cli/thin-command.ts";

export function checkTemplateCommandSurface(options = {}) {
  const rootDir = options.rootDir ?? process.cwd(), failures = [];
  const retiredRoot = options.legacyRoot ?? path.join(rootDir, legacyRoot);
  const source = options.commandSource ?? readFileSync(path.join(rootDir, commandPath), "utf8");
  if (hasFiles(retiredRoot)) failures.push(`${legacyRoot}: retired seeded templates must not remain after the thin CLI production flip`);
  if (/usage:\s*"ha\s+template\b/u.test(source)) failures.push(`${commandPath}: thin command directory must not advertise the retired template product surface`);
  return { ok: failures.length === 0, failures };
}
function hasFiles(root) { if (!existsSync(root)) return false; return readdirSync(root, { withFileTypes: true }).some((entry) => entry.isFile() || hasFiles(path.join(root, entry.name))); }

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) { const result = checkTemplateCommandSurface();
  if (!result.ok) { console.error("Retired template command surface returned:"); for (const failure of result.failures) console.error(`- ${failure}`); process.exitCode = 1; } }
