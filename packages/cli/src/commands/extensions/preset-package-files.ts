import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export function presetManifestPathFromSource(sourcePath: string): string {
  return statSync(sourcePath).isDirectory() ? path.join(sourcePath, "preset.json") : sourcePath;
}

export function copyPresetPackage(
  sourceRoot: string,
  targetRoot: string,
  writeTarget: (filePath: string, body: Buffer) => void,
  options: { readonly prepareTarget?: (targetRoot: string) => void } = {}
): void {
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) return;
  options.prepareTarget?.(targetRoot);
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      copyPresetPackage(source, target, writeTarget);
    } else if (entry.isFile() && !existsSync(target)) {
      writeTarget(target, readFileSync(source));
    }
  }
}
