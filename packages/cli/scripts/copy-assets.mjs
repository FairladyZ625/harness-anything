import { randomUUID } from "node:crypto";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staleAssets = path.join(packageRoot, "dist/cli/src/commands");
if (existsSync(staleAssets)) rmSync(staleAssets, { recursive: true, force: true });
const bundledPresetAssets = path.resolve(packageRoot, "../preset/assets"), publishedPresetAssets = path.join(packageRoot, "dist/preset/assets");
if (existsSync(publishedPresetAssets)) rmSync(publishedPresetAssets, { recursive: true, force: true });
cpSync(bundledPresetAssets, publishedPresetAssets, { recursive: true });
writeFileSync(path.join(packageRoot, "dist/build-id.txt"), `${randomUUID()}\n`, "utf8");
