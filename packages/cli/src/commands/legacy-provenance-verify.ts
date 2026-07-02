import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput } from "../../../kernel/src/layout/index.ts";
import { resolveHarnessLayout } from "../../../kernel/src/layout/index.ts";

export function collectLegacyProvenanceWarnings(rootInput: HarnessLayoutInput): ReadonlyArray<Record<string, string>> {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  if (!existsSync(layout.tasksRoot)) return [];
  return readdirSync(layout.tasksRoot, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const provenancePath = path.join(layout.tasksRoot, entry.name, "legacy-provenance.json");
    if (!existsSync(provenancePath)) return [];
    const taskPackage = normalizeSlashes(path.relative(rootDir, path.dirname(provenancePath)));
    try {
      const provenance = parseLegacyProvenance(JSON.parse(readFileSync(provenancePath, "utf8")));
      if (!isLegacyStoredPath(provenance.storedPath)) {
        return [legacyProvenanceWarning("legacy_provenance_invalid", taskPackage, provenance.legacyId, provenance.storedPath)];
      }
      if (existsSync(path.join(rootDir, provenance.storedPath))) return [];
      return [legacyProvenanceWarning("legacy_provenance_target_missing", taskPackage, provenance.legacyId, provenance.storedPath)];
    } catch {
      return [legacyProvenanceWarning("legacy_provenance_invalid", taskPackage, "", "")];
    }
  }).sort((left, right) => `${left.taskPackage}:${left.code}`.localeCompare(`${right.taskPackage}:${right.code}`));
}

function parseLegacyProvenance(value: unknown): { readonly legacyId: string; readonly storedPath: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid legacy provenance");
  const candidate = value as { readonly schema?: unknown; readonly legacyId?: unknown; readonly storedPath?: unknown };
  if (candidate.schema !== "legacy-rebuild-provenance/v1") throw new Error("invalid legacy provenance schema");
  if (typeof candidate.legacyId !== "string" || candidate.legacyId.length === 0) throw new Error("invalid legacy provenance id");
  if (typeof candidate.storedPath !== "string" || candidate.storedPath.length === 0) throw new Error("invalid legacy provenance storedPath");
  return { legacyId: candidate.legacyId, storedPath: candidate.storedPath };
}

function isLegacyStoredPath(value: string): boolean {
  return value.startsWith("harness/legacy/") && !value.includes("..") && !value.includes("\\") && !path.isAbsolute(value);
}

function legacyProvenanceWarning(code: string, taskPackage: string, legacyId: string, storedPath: string): Record<string, string> {
  return {
    code,
    severity: "warning",
    taskPackage,
    legacyId,
    storedPath
  };
}

function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}
