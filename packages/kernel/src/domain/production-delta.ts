export interface ProductionNumstatRecord {
  readonly addedText: string;
  readonly deletedText: string;
  readonly filePath: string;
}

export interface ProductionDeltaChange {
  readonly filePath: string;
  readonly module: string;
  readonly added: number;
  readonly deleted: number;
}

export interface ProductionDeltaCounts {
  readonly added: number;
  readonly deleted: number;
  readonly changed: readonly ProductionDeltaChange[];
  readonly unclassified: readonly string[];
}

const SOURCE_EXTENSION = /\.(?:c|m)?js$|\.(?:d\.)?tsx?$/u;
const TEST_SEGMENT = /(?:^|\/)(?:__tests__|e2e|fixtures?|test|tests)(?:\/|$)/u;
const TEST_FILE = /\.(?:integration\.)?(?:spec|test)\.[^.]+$/u;
const CANONICAL_MODULE =
  /^(?:packages|src)\/(kernel|task-lifecycle|doc-sync|preset|cli|gui|daemon|storage|authority-write-path|identity-rbac)(?:\/|$)/u;
const CONCEPT_MODULE =
  /^packages\/(?:kernel\/src\/(?:domain|schemas)\/(decision|fact)-event|kernel\/src\/projection\/(decision|fact)-event-projection|application\/src\/(decision|fact)-service|daemon\/src\/(decision|fact)-actions)\.ts$/u;

export function normalizeRepoPath(filePath: string): string | null {
  if (typeof filePath !== "string") return null;
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.length === 0 || normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  return normalized;
}

export function isTestPath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  return normalized !== null && (TEST_SEGMENT.test(normalized) || TEST_FILE.test(normalized));
}

export function isProductionPath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  if (normalized === null || !SOURCE_EXTENSION.test(normalized) || isTestPath(normalized)) return false;
  return (
    /^packages\/(?:[^/]+|adapters\/[^/]+)\/src\//u.test(normalized) ||
    /^src\/(?:kernel|task-lifecycle|doc-sync|preset|cli|gui|daemon|authority-write-path|identity-rbac)\//u.test(
      normalized,
    ) ||
    normalized.startsWith("tools/")
  );
}

export function classifyModule(filePath: string): string | null {
  const normalized = normalizeRepoPath(filePath);
  if (normalized === null) return null;

  if (isTestPath(normalized) || /^(?:\.github|scripts)\//u.test(normalized)) return null;
  if (normalized.startsWith("tools/")) return "tooling";

  if (/^packages\/authorization-(?:builtin|keycloak)\//u.test(normalized)) return "identity-rbac";
  if (/^packages\/authorization-gui\//u.test(normalized)) return "gui";
  if (/^packages\/authorization-keycloak-gui\//u.test(normalized)) return "gui";

  if (normalized === "packages/kernel/src/domain/write-chain.contract.ts") return "write-contract";
  const conceptModule = CONCEPT_MODULE.exec(normalized)?.slice(1).find(Boolean);
  if (conceptModule !== undefined) return conceptModule;
  if (/^packages\/daemon\/src\/fleet\//u.test(normalized)) return "fleet";
  if (/agent-runtime/u.test(normalized)) return "agent-runtime";
  if (/^packages\/gui\//u.test(normalized)) return "gui";
  if (/^packages\/daemon\/src\/identity\//u.test(normalized)) return "identity-rbac";
  if (/doc-sync/u.test(normalized)) return "doc-sync";
  if (/^packages\/cli\/src\/(?:cli\/parsers\/extensions-|commands\/extensions\/)/u.test(normalized)) return "preset";

  const canonicalModule = CANONICAL_MODULE.exec(normalized)?.[1];
  if (canonicalModule !== undefined) return canonicalModule;

  if (/^packages\/daemon\//u.test(normalized)) return "daemon";
  if (/^packages\/cli\//u.test(normalized)) return "cli";
  if (/^packages\/application\//u.test(normalized)) return "task-lifecycle";
  if (/^packages\/adapters\/local\/src\/task-/u.test(normalized)) return "task-lifecycle";
  if (/^packages\/(?:kernel|adapters\/[^/]+)\//u.test(normalized)) return "kernel";

  return null;
}

export function classifyPath(filePath: string): {
  readonly module: string | null;
  readonly kind: "production" | "test" | "other";
} {
  const normalized = normalizeRepoPath(filePath);
  if (normalized === null) return { module: null, kind: "other" };
  return {
    module: classifyModule(normalized),
    kind: isProductionPath(normalized) ? "production" : isTestPath(normalized) ? "test" : "other",
  };
}

export function productionDeltaFromNumstat(records: readonly ProductionNumstatRecord[]): ProductionDeltaCounts {
  const changed: ProductionDeltaChange[] = [],
    unclassified: string[] = [];
  let added = 0;
  let deleted = 0;

  for (const record of records) {
    if (!isProductionPath(record.filePath)) continue;
    const moduleName = classifyModule(record.filePath);
    if (moduleName === null) {
      unclassified.push(record.filePath);
      continue;
    }
    if (record.addedText === "-" || record.deletedText === "-")
      throw new Error(`production source must be text: ${record.filePath}`);
    if (!/^\d+$/u.test(record.addedText) || !/^\d+$/u.test(record.deletedText))
      throw new Error(`git produced an invalid numstat record for ${record.filePath}`);
    const fileAdded = Number.parseInt(record.addedText, 10),
      fileDeleted = Number.parseInt(record.deletedText, 10);
    added += fileAdded;
    deleted += fileDeleted;
    changed.push({ filePath: record.filePath, module: moduleName, added: fileAdded, deleted: fileDeleted });
  }

  return { added, deleted, changed, unclassified };
}
