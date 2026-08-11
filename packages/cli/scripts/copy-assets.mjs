import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const copies = [
  {
    source: path.join(packageRoot, "src/commands/extensions/assets"),
    target: path.join(packageRoot, "dist/cli/src/commands/extensions/assets")
  },
  {
    source: path.join(packageRoot, "src/commands/daemon/assets"),
    target: path.join(packageRoot, "dist/cli/src/commands/daemon/assets")
  },
  {
    source: path.join(repoRoot, "tools/gates/receipt-verify.mjs"),
    target: path.join(packageRoot, "dist/cli/runtime/receipt-verify.mjs")
  }
];

for (const { source, target } of copies) {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
