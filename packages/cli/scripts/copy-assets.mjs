import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staleAssets = path.join(packageRoot, "dist/cli/src/commands");
if (existsSync(staleAssets)) rmSync(staleAssets, { recursive: true, force: true });
