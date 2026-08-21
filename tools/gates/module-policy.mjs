const SOURCE_EXTENSION = /\.(?:c|m)?js$|\.(?:d\.)?tsx?$/u;
const TEST_SEGMENT = /(?:^|\/)(?:__tests__|e2e|fixtures?|test|tests)(?:\/|$)/u;
const TEST_FILE = /\.(?:integration\.)?(?:spec|test)\.[^.]+$/u;

export const MODULES = Object.freeze([
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
  "test-infra"
]);

const moduleSet = new Set(MODULES);

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
  return /^packages\/(?:[^/]+|adapters\/[^/]+)\/src\//u.test(normalized)
    || /^src\/(?:kernel|task-lifecycle|doc-sync|preset|cli|gui|daemon|authority-write-path|identity-rbac)\//u.test(normalized);
}

function moduleFromCanonicalPrefix(filePath) {
  const match = /^(?:packages|src)\/(kernel|task-lifecycle|doc-sync|preset|cli|gui|daemon|authority-write-path|identity-rbac|test-infra)(?:\/|$)/u.exec(filePath);
  return match && moduleSet.has(match[1]) ? match[1] : null;
}

export function classifyModule(filePath) {
  const normalized = normalizeRepoPath(filePath);
  if (normalized === null) return null;

  if (isTestPath(normalized) || /^(?:\.github|scripts|tools)\//u.test(normalized)) return "test-infra";

  if (normalized === "packages/kernel/src/domain/write-chain.contract.ts") return "write-contract";
  if (/^packages\/daemon\/src\/fleet\//u.test(normalized)) return "fleet";
  if (/agent-runtime/u.test(normalized)) return "agent-runtime";
  if ([
    "packages/kernel/src/domain/decision-event.ts",
    "packages/kernel/src/schemas/decision-event.ts",
    "packages/kernel/src/projection/decision-event-projection.ts",
    "packages/application/src/decision-service.ts",
    "packages/daemon/src/decision-actions.ts"
  ].includes(normalized)) return "decision";
  if ([
    "packages/kernel/src/domain/fact-event.ts",
    "packages/kernel/src/schemas/fact-event.ts",
    "packages/kernel/src/projection/fact-event-projection.ts",
    "packages/application/src/fact-service.ts",
    "packages/daemon/src/fact-actions.ts"
  ].includes(normalized)) return "fact";
  if (/^packages\/gui\//u.test(normalized)) return "gui";
  if (/^packages\/daemon\/src\/identity\//u.test(normalized)) return "identity-rbac";
  if (/doc-sync/u.test(normalized)) return "doc-sync";
  if (/^packages\/cli\/src\/(?:cli\/parsers\/extensions-|commands\/extensions\/)/u.test(normalized)) return "preset";

  const canonicalModule = moduleFromCanonicalPrefix(normalized);
  if (canonicalModule !== null) return canonicalModule;

  if (/^packages\/daemon\//u.test(normalized)) return "daemon";
  if (/^packages\/cli\//u.test(normalized)) return "cli";

  if (/^packages\/application\//u.test(normalized)) return "task-lifecycle";
  if (/^packages\/adapters\/local\/src\/task-/u.test(normalized)) return "task-lifecycle";
  if (/^packages\/(?:kernel|adapters\/[^/]+)\//u.test(normalized)) return "kernel";

  return null;
}

export function classifyPath(filePath) {
  const normalized = normalizeRepoPath(filePath);
  if (normalized === null) return { module: null, kind: "other" };
  return {
    module: classifyModule(normalized),
    kind: isProductionPath(normalized) ? "production" : isTestPath(normalized) ? "test" : "other"
  };
}
