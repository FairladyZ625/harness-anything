import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./rewrite-workspace-imports.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const copies = [
  {
    source: path.join(packageRoot, "src/commands/extensions/assets"),
    target: path.join(packageRoot, "dist/cli/src/commands/extensions/assets")
  },
  {
    source: path.join(packageRoot, "src/commands/daemon/assets"),
    target: path.join(packageRoot, "dist/cli/src/commands/daemon/assets")
  }
];

for (const { source, target } of copies) {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
