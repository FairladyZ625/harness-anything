import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

// `tsc` emits the CLI entry with the default 0644, and `node_modules/.bin/ha`
// is a symlink straight to it, so every re-emit leaves `ha` unexecutable until
// the next install relinks it. Restore the bit here, derived from the declared
// `bin` map rather than a hardcoded path, so adding a bin cannot silently miss
// this step.
for (const target of declaredBinTargets()) {
  if (!existsSync(target)) throw new Error(`declared bin target is missing after build: ${target}`);
  chmodSync(target, 0o755);
}

function declaredBinTargets() {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const bin = typeof manifest.bin === "string" ? { [manifest.name]: manifest.bin } : manifest.bin ?? {};
  return [...new Set(Object.values(bin))].map((relative) => path.join(packageRoot, relative));
}
