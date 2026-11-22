import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = fileURLToPath(new URL("./bin/vite.js", import.meta.resolve("vite/package.json")));
const options = { cwd: packageRoot, stdio: "inherit" };

for (const config of ["vite.config.ts", "vite.preload.config.ts", "vite.main.config.ts"]) {
  execFileSync(process.execPath, [vite, "build", "--config", config], options);
}

const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim();
mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
writeFileSync(path.join(packageRoot, "dist", "build-id.txt"), `${gitCommit}\n`, "utf8");
