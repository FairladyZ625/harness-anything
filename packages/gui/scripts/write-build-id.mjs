import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Same marker contract as the daemon and CLI copy-assets steps: the commit the build ran from,
// stable across rebuilds of one HEAD, with one shared fallback when no git identity resolves.
// `ha gui` compares it against the checkout's current build id to refuse serving a stale bundle.
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" });
const buildCommit = process.env.HARNESS_BUILD_COMMIT?.trim() || commit.stdout.trim() || "source-archive";
writeFileSync(path.join(packageRoot, "dist/build-id.txt"), `${buildCommit}\n`, "utf8");
