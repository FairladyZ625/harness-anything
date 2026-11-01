import {
  classifyModule as classifyKernelModule,
  classifyPath,
  isProductionPath,
  isTestPath,
  normalizeRepoPath,
} from "../../packages/kernel/src/domain/production-delta.ts";

export function classifyModule(filePath) {
  const moduleName = classifyKernelModule(filePath);
  if (moduleName !== null) return moduleName;
  const normalized = normalizeRepoPath(filePath);
  return normalized?.startsWith("packages/dsh-plugin/") ? "dsh-plugin" : null;
}

export { classifyPath, isProductionPath, isTestPath, normalizeRepoPath };

export const BUDGETED_MODULES = Object.freeze([
  "kernel",
  "task-lifecycle",
  "write-contract",
  "doc-sync",
  "preset",
  "cli",
  "gui",
  "daemon",
  "storage",
  "fleet",
  "authority-write-path",
  "identity-rbac",
  "agent-runtime",
  "decision",
  "fact",
  "dsh-plugin",
]);

const BUDGETED_PRODUCTION = Object.freeze({ production: true, budgetExempt: false });
const EXEMPT_PRODUCTION = Object.freeze({ production: true, budgetExempt: true });
export const MODULE_POLICY = Object.freeze(
  Object.fromEntries([...BUDGETED_MODULES.map((name) => [name, BUDGETED_PRODUCTION]), ["tooling", EXEMPT_PRODUCTION]]),
);

export function isBudgetedProductionPath(filePath) {
  const policy = isProductionPath(filePath) ? MODULE_POLICY[classifyModule(filePath)] : null;
  return policy?.production === true && !policy.budgetExempt;
}
