import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256Text } from "../../../../kernel/src/index.ts";

export function writeMachineEvidenceRegistry(outputRoot: string, generated: ReadonlyArray<string>): void {
  const machineEvidence = generated
    .map((filePath) => ({
      absolutePath: filePath,
      relativePath: toSlash(path.relative(outputRoot, filePath))
    }))
    .filter((entry) => /^artifacts\/(?:preset-result|evidence|gate-retro\.snapshot)\.json$/u.test(entry.relativePath));
  if (machineEvidence.length === 0) return;
  const registryPath = path.join(outputRoot, "artifacts", ".machine-evidence.registry.json");
  const registry = {
    schema: "machine-evidence-registry/v1",
    boundary: "preset-machine-evidence",
    entries: machineEvidence.map((entry) => ({
      path: entry.relativePath,
      sha256: `sha256:${sha256Text(readFileSync(entry.absolutePath, "utf8"))}`,
      recordedAt: new Date(0).toISOString()
    })).sort((left, right) => left.path.localeCompare(right.path))
  };
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

export function toSlash(value: string): string {
  return value.split(path.sep).join("/");
}
