import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staleAssets = path.join(packageRoot, "dist/cli/src/commands");
if (existsSync(staleAssets)) rmSync(staleAssets, { recursive: true, force: true });
const bundledPresetAssets = path.resolve(packageRoot, "../preset/assets"),
  publishedPresetAssets = path.join(packageRoot, "dist/preset/assets");
if (existsSync(publishedPresetAssets)) rmSync(publishedPresetAssets, { recursive: true, force: true });
cpSync(bundledPresetAssets, publishedPresetAssets, { recursive: true });
// The build marker identifies the source commit. Rebuilding unchanged HEAD must not make a
// resident daemon drain and restart solely because the asset-copy step generated a new UUID.
const buildCommit =
  process.env.HARNESS_BUILD_COMMIT?.trim() ||
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: packageRoot,
    encoding: "utf8",
  }).trim();
writeFileSync(path.join(packageRoot, "dist/build-id.txt"), `${buildCommit}\n`, "utf8");
