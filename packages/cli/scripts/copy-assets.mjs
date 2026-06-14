import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(packageRoot, "src/commands/extensions/assets");
const target = path.join(packageRoot, "dist/cli/src/commands/extensions/assets");

if (existsSync(target)) {
  rmSync(target, { recursive: true, force: true });
}
mkdirSync(path.dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
