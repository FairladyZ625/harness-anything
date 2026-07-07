import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface LegacyIntakeReadinessEvidence {
  readonly schema: "harness-legacy-intake-readiness-evidence/v1";
  readonly ok: boolean;
  readonly packageReleaseDecision: {
    readonly publishState: "not-published";
    readonly packageBoundary: "cli-dry-run-only";
    readonly privatePackageVersionPolicy: "0.0.0";
    readonly cliDryRunVersion: "0.1.0";
  };
  readonly behaviorCorpus: {
    readonly dataPath: string;
    readonly reportPath: string;
    readonly needsDecision: number;
    readonly itemCount: number;
  };
  readonly violations: ReadonlyArray<string>;
}

const minBehaviorCorpusItems = 15;

export function evaluateLegacyIntakeReadinessEvidence(rootDir: string): LegacyIntakeReadinessEvidence {
  const violations: string[] = [];
  checkPackageDecision(rootDir, violations);
  const behaviorCorpus = checkBehaviorCorpus(rootDir, violations);

  return {
    schema: "harness-legacy-intake-readiness-evidence/v1",
    ok: violations.length === 0,
    packageReleaseDecision: {
      publishState: "not-published",
      packageBoundary: "cli-dry-run-only",
      privatePackageVersionPolicy: "0.0.0",
      cliDryRunVersion: "0.1.0"
    },
    behaviorCorpus,
    violations
  };
}

function checkPackageDecision(rootDir: string, violations: string[]): void {
  const packages = [
    "package.json",
    "packages/kernel/package.json",
    "packages/application/package.json",
    "packages/daemon/package.json",
    "packages/cli/package.json",
    "packages/gui/package.json",
    "packages/adapters/local/package.json",
    "packages/adapters/multica/package.json",
    "packages/adapters/github-issues/package.json",
    "packages/adapters/linear/package.json"
  ];

  for (const packagePath of packages) {
    const json = readJsonObject(rootDir, packagePath, violations);
    if (packagePath === "packages/cli/package.json") {
      if (json.private === true) violations.push(`${packagePath}: CLI package must be public-ready for npm publish dry-run preflight`);
      if (json.version !== "0.1.0") violations.push(`${packagePath}: version must be 0.1.0 for npm publish dry-run preflight`);
      if (asObject(json.publishConfig).access !== "public") violations.push(`${packagePath}: publishConfig.access must be public for npm publish dry-run preflight`);
    } else {
      if (json.private !== true) violations.push(`${packagePath}: package must remain private for M2 Legacy Intake readiness`);
      if (packagePath !== "package.json" && json.version !== "0.0.0") {
        violations.push(`${packagePath}: version must remain 0.0.0 before publish planning`);
      }
      if (json.publishConfig) violations.push(`${packagePath}: publishConfig is not allowed before publish planning`);
    }
  }

  const cliPackage = readJsonObject(rootDir, "packages/cli/package.json", violations);
  const cliBin = asObject(cliPackage.bin);
  const cliExports = asObject(cliPackage.exports);
  if (cliBin["harness-anything"] !== "dist/cli/src/index.js") {
    violations.push("packages/cli/package.json: bin.harness-anything must point at dist/cli/src/index.js");
  }
  if (cliBin.ha !== "dist/cli/src/index.js") {
    violations.push("packages/cli/package.json: bin.ha must point at dist/cli/src/index.js");
  }
  if (cliExports["."] !== "./dist/cli/src/index.js") {
    violations.push("packages/cli/package.json: exports['.'] must point at ./dist/cli/src/index.js");
  }
}

function checkBehaviorCorpus(rootDir: string, violations: string[]): LegacyIntakeReadinessEvidence["behaviorCorpus"] {
  const dataPath = "tools/legacy-intake/behavior-corpus-classification.json";
  const reportPath = "tools/legacy-intake/behavior-corpus-classification.md";
  const dataFullPath = path.join(rootDir, dataPath);
  const reportFullPath = path.join(rootDir, reportPath);

  if (!existsSync(dataFullPath)) {
    violations.push(`${dataPath}: missing machine-checkable behavior corpus`);
    return { dataPath, reportPath, needsDecision: -1, itemCount: 0 };
  }
  if (!existsSync(reportFullPath)) violations.push(`${reportPath}: missing behavior corpus report`);

  const data = readJsonObject(rootDir, dataPath, violations);
  const categories = readCategoryCounts(asObject(data.categories));
  const items = readCorpusItems(data.items);
  const needsDecision = categories["needs-decision"] ?? -1;

  if (data.publishState !== "not-published") {
    violations.push(`${dataPath}: publishState must remain not-published for M2 Legacy Intake readiness`);
  }
  for (const category of ["preserve", "intentional-change", "old-bug", "unsupported-input", "needs-decision"]) {
    if (!Number.isInteger(categories[category]) || categories[category] < 0) {
      violations.push(`${dataPath}: missing non-negative category ${category}`);
    }
  }
  if (needsDecision !== 0) violations.push(`${dataPath}: unresolved needs-decision differences remain`);

  const counts = Object.fromEntries(Object.keys(categories).map((category) => [category, 0]));
  for (const item of items) {
    if (!item.classification || !(item.classification in counts)) {
      violations.push(`${dataPath}: item has unknown classification`);
      continue;
    }
    counts[item.classification] += 1;
  }
  for (const [category, expected] of Object.entries(categories)) {
    if (counts[category] !== expected) {
      violations.push(`${dataPath}: category ${category} count ${expected} does not match ${counts[category]} item(s)`);
    }
  }
  if (items.length < minBehaviorCorpusItems) {
    violations.push(`${dataPath}: behavior corpus must include at least ${minBehaviorCorpusItems} classified items`);
  }

  return { dataPath, reportPath, needsDecision, itemCount: items.length };
}

function readJsonObject(rootDir: string, relativePath: string, violations: string[]): Record<string, unknown> {
  const fullPath = path.join(rootDir, relativePath);
  if (!existsSync(fullPath)) {
    violations.push(`${relativePath}: missing required Legacy Intake readiness evidence file`);
    return {};
  }
  try {
    return asObject(JSON.parse(readFileSync(fullPath, "utf8")));
  } catch {
    violations.push(`${relativePath}: invalid JSON`);
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readCategoryCounts(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => Number.isInteger(entry[1]))
  );
}

function readCorpusItems(value: unknown): ReadonlyArray<{ readonly classification?: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asObject(item);
    return typeof record.classification === "string" ? { classification: record.classification } : {};
  });
}
