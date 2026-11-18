import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(import.meta.dirname, "..");
const vite = fileURLToPath(new URL("./bin/vite.js", import.meta.resolve("vite/package.json")));
const preserveOutput = process.argv.includes("--preserve-output") ? ["--no-emptyOutDir"] : [];
const options = { cwd: guiRoot, stdio: "inherit" };

for (const config of ["vite.config.ts", "vite.preload.config.ts", "vite.main.config.ts"]) {
  execFileSync(process.execPath, [vite, "build", "--config", config, ...preserveOutput], options);
}
execFileSync(process.execPath, ["scripts/write-build-id.mjs"], options);
