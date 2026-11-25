import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Same marker contract as cli, daemon, and gui: honor HARNESS_BUILD_COMMIT when set,
// resolve HEAD inside a git checkout, and fall back to "source-archive" in gitless archive trees.
export function resolveBuildCommit(rootDir, env = process.env) {
  const stamped = env.HARNESS_BUILD_COMMIT?.trim();
  if (stamped) return stamped;
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" });
  if (commit.status === 0) {
    const resolved = (commit.stdout ?? "").trim();
    if (resolved) return resolved;
  }
  return "source-archive";
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const vite = fileURLToPath(new URL("./bin/vite.js", import.meta.resolve("vite/package.json")));
  const options = { cwd: packageRoot, stdio: "inherit" };

  for (const config of ["vite.config.ts", "vite.preload.config.ts", "vite.main.config.ts"]) {
    execFileSync(process.execPath, [vite, "build", "--config", config], options);
  }

  const gitCommit = resolveBuildCommit(packageRoot);
  mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  writeFileSync(path.join(packageRoot, "dist", "build-id.txt"), `${gitCommit}\n`, "utf8");
}
