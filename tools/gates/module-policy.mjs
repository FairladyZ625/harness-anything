const SOURCE_EXTENSION = /\.(?:c|m)?js$|\.(?:d\.)?tsx?$/u;
const TEST_SEGMENT = /(?:^|\/)(?:__snapshots__|__tests__|e2e|fixtures?|snapshots?|test|tests)(?:\/|$)/u;
const TEST_FILE = /\.(?:integration\.)?(?:spec|test)\.[^.]+$/u;
const CANONICAL_MODULE =
  /^(?:packages|src)\/(kernel|task-lifecycle|doc-sync|preset|cli|gui|daemon|authority-write-path|identity-rbac)(?:\/|$)/u;
const CONCEPT_MODULE =
  /^packages\/(?:kernel\/src\/(?:domain|schemas)\/(decision|fact)-event|kernel\/src\/projection\/(decision|fact)-event-projection|application\/src\/(decision|fact)-service|daemon\/src\/(decision|fact)-actions)\.ts$/u;

export const BUDGETED_MODULES = Object.freeze([
  "kernel",
  "task-lifecycle",
  "write-contract",
  "doc-sync",
  "preset",
  "cli",
  "gui",
  "daemon",
  "fleet",
  "authority-write-path",
  "identity-rbac",
  "agent-runtime",
  "decision",
  "fact",
]);

const BUDGETED_PRODUCTION = Object.freeze({ production: true, budgetExempt: false });
const EXEMPT_PRODUCTION = Object.freeze({ production: true, budgetExempt: true });
export const MODULE_POLICY = Object.freeze(
  Object.fromEntries([...BUDGETED_MODULES.map((name) => [name, BUDGETED_PRODUCTION]), ["tooling", EXEMPT_PRODUCTION]]),
);
export const MODULES = Object.freeze(Object.keys(MODULE_POLICY));

export function normalizeRepoPath(filePath) {
  if (typeof filePath !== "string") return null;
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.length === 0 || normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  return normalized;
}

export function isTestPath(filePath) {
  const normalized = normalizeRepoPath(filePath);
  return normalized !== null && (TEST_SEGMENT.test(normalized) || TEST_FILE.test(normalized));
}

export function isProductionPath(filePath) {
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

export function classifyModule(filePath) {
  const normalized = normalizeRepoPath(filePath);
  if (normalized === null) return null;

  if (isTestPath(normalized) || /^(?:\.github|scripts)\//u.test(normalized)) return null;
  if (normalized.startsWith("tools/")) return "tooling";

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

export function isBudgetedProductionPath(filePath) {
  const policy = isProductionPath(filePath) ? MODULE_POLICY[classifyModule(filePath)] : null;
  return policy?.production === true && !policy.budgetExempt;
}

export function classifyPath(filePath) {
  const normalized = normalizeRepoPath(filePath);
  if (normalized === null) return { module: null, kind: "other" };
  return {
    module: classifyModule(normalized),
    kind: isProductionPath(normalized) ? "production" : isTestPath(normalized) ? "test" : "other",
  };
}
