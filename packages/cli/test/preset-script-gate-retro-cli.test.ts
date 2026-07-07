import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI gate-architecture-retrospective gather writes gate snapshot data", () => {
  withTempRoot((rootDir) => {
    seedRetrospectiveSourceSurface(rootDir);
    runJson(rootDir, ["init"]);
    const created = runJson(rootDir, ["new-task", "--title", "Gate Retro", "--vertical", "software/coding", "--preset", "gate-architecture-retrospective"]);

    const result = runJson(rootDir, ["script", "run", "preset:gate-architecture-retrospective:gather", "--task", created.taskId]);

    assert.equal(result.ok, true);
    assert.equal(result.script.id, "preset:gate-architecture-retrospective:gather");
    assert.equal(result.generated.some((filePath: string) => filePath.endsWith("artifacts/gate-retro.snapshot.json")), true);
    assert.equal(result.generated.some((filePath: string) => filePath.endsWith("artifacts/gate-retro.snapshot.md")), true);
    const snapshot = JSON.parse(readFileSync(path.join(rootDir, created.packagePath, "artifacts", "gate-retro.snapshot.json"), "utf8"));
    assert.equal(snapshot.schema, "gate-architecture-retro-snapshot/v1");
    assert.equal(snapshot.coordinationTaskId, created.taskId);
    assert.equal(snapshot.gateManifest.gateCount, 2);
    assert.equal(snapshot.allowlists.summary.totalEntries, 1);
    assert.equal(snapshot.knownDebt.summary.entries, 1);
    assert.deepEqual(snapshot.checkDiff.onlyInCheck, ["smoke-cli-package"]);
    assert.equal(snapshot.importGraph.summary.kernelDeepImportEdges, 1);
    assert.match(readFileSync(path.join(rootDir, created.packagePath, "artifacts", "gate-retro.snapshot.md"), "utf8"), /Gate Architecture Retrospective Snapshot/u);
  });
});

test("CLI metadata check enforces gate retrospective snapshot and final analysis shape", () => {
  withTempRoot((rootDir) => {
    seedRetrospectiveSourceSurface(rootDir);
    runJson(rootDir, ["init"]);
    const created = runJson(rootDir, ["new-task", "--title", "Gate Retro", "--vertical", "software/coding", "--preset", "gate-architecture-retrospective"]);
    assert.equal(existsSync(path.join(rootDir, created.packagePath, "artifacts", "gate-retro.analysis.scaffold.md")), true);

    const missing = runJson(rootDir, ["check", "--profile", "target-project", "--strict"], false);
    assert.equal(missing.ok, false);
    assert.equal(missing.warnings.some((warning: Record<string, unknown>) => warning.source === "gate-retro-checker" && warning.code === "gate_retro_snapshot_missing"), true);
    assert.equal(missing.warnings.some((warning: Record<string, unknown>) => warning.source === "gate-retro-checker" && warning.code === "gate_retro_analysis_missing"), true);

    const artifactsDir = path.join(rootDir, created.packagePath, "artifacts");
    const snapshotBody = JSON.stringify({ schema: "gate-architecture-retro-snapshot/v1" }, null, 2);
    writeFileSync(path.join(artifactsDir, "gate-retro.snapshot.json"), snapshotBody, "utf8");
    writeFileSync(path.join(artifactsDir, ".machine-evidence.registry.json"), JSON.stringify({
      schema: "machine-evidence-registry/v1",
      boundary: "preset-machine-evidence",
      entries: [{
        path: "artifacts/gate-retro.snapshot.json",
        sha256: `sha256:${createHash("sha256").update(snapshotBody).digest("hex")}`,
        recordedAt: new Date(0).toISOString()
      }]
    }, null, 2), "utf8");
    writeFileSync(path.join(artifactsDir, "gate-retro.analysis.md"), validGateRetroAnalysis(), "utf8");

    const passed = runJson(rootDir, ["check", "--profile", "target-project", "--strict"]);
    assert.equal(passed.ok, true);
    assert.equal(passed.warnings.some((warning: Record<string, unknown>) => warning.source === "gate-retro-checker"), false);

    writeFileSync(path.join(artifactsDir, "gate-retro.analysis.md"), invalidLoadBearingFinding(), "utf8");
    const blocked = runJson(rootDir, ["check", "--profile", "target-project", "--strict"], false);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.warnings.some((warning: Record<string, unknown>) => warning.code === "gate_retro_load_bearing_decision_missing"), true);
  });
});

function seedRetrospectiveSourceSurface(rootDir: string): void {
  writeJson(rootDir, "package.json", {
    scripts: {
      check: "npm run harness:check-gate-surface && npm run harness:smoke-cli-package",
      "check:pr": "npm run harness:check-gate-surface",
      "harness:check-gate-surface": "node tools/check-gate-surface.mjs",
      "harness:smoke-cli-package": "node tools/smoke-cli-package.mjs"
    }
  });
  writeFile(rootDir, "eslint.config.mjs", [
    "import { kernelImportBoundaryKnownDebt } from './tools/kernel-import-boundary-known-debt.mjs';",
    "export default [{ rules: { 'no-restricted-imports': 'error', 'no-restricted-syntax': 'error' } }];",
    "void kernelImportBoundaryKnownDebt;",
    ""
  ].join("\n"));
  writeJson(rootDir, "tools/gate-manifest.json", {
    schema: "harness-anything/gate-manifest/v1",
    authorityBasis: ["ADR-0022#D6", "ADR-0023#D4"],
    surfaces: {
      packageJson: {
        check: ["check-gate-surface", "smoke-cli-package"],
        checkPr: ["check-gate-surface"]
      }
    },
    gates: [
      {
        id: "check-gate-surface",
        command: "npm run harness:check-gate-surface",
        category: "meta-governance",
        tier: "pr-required",
        bypassFixtureRequired: false,
        executionSurfaces: { packageJson: { check: true, checkPr: true } }
      },
      {
        id: "smoke-cli-package",
        command: "npm run harness:smoke-cli-package",
        category: "smoke",
        tier: "main-only",
        bypassFixtureRequired: false,
        executionSurfaces: { packageJson: { check: true, checkPr: false } }
      }
    ]
  });
  writeJson(rootDir, "tools/gate-allowlists/check-gate-surface.json", {
    schema: "harness-anything/gate-allowlist/v1",
    gateId: "check-gate-surface",
    entries: {
      governed: [{ value: "tools/gate-manifest.json", ref: "ADR-0023#D6", reason: "Manifest is the gate authority." }]
    }
  });
  writeFile(rootDir, "tools/kernel-import-boundary-known-debt.mjs", [
    "export const kernelImportBoundaryKnownDebt = [{",
    "  file: 'packages/cli/src/index.ts',",
    "  specifier: '../../kernel/src/write-coordination/write-helpers.ts',",
    "  target: 'packages/kernel/src/write-coordination/write-helpers.ts',",
    "  decision: 'dec_GATE_DEFENSE_ROOT_CAUSE',",
    "  reason: 'fixture debt'",
    "}];",
    ""
  ].join("\n"));
  writeFile(rootDir, "tools/check-gate-surface.mjs", "export function checkPackageScripts() {}\nexport function checkRewriteCi() {}\nexport function checkBranchProtection() {}\nexport function checkBoundaryFields() {}\n");
  writeFile(rootDir, "packages/cli/src/index.ts", "import { helper } from '../../kernel/src/write-coordination/write-helpers.ts';\nvoid helper;\n");
}

function validGateRetroAnalysis(): string {
  return [
    "# Gate Retro",
    "",
    "<!-- gate-retro:ground-truth-warning -->",
    "## Ground-Truth Rule",
    "No unsupported claims.",
    "<!-- gate-retro:adr-checklist -->",
    "## ADR-0022 D6 Checklist",
    "No new findings.",
    "<!-- gate-retro:defect-patterns -->",
    "## Defect Pattern Attribution",
    "No new findings.",
    "<!-- gate-retro:evidence-ledger -->",
    "## Reproducible Evidence Ledger",
    "No rot accusations in this report.",
    "<!-- gate-retro:decision-projection -->",
    "## Decision / ADR Projection Gate",
    "No load-bearing issue found.",
    "<!-- gate-retro:verdict -->",
    "## Verdict",
    "Overall status: no new rot.",
    ""
  ].join("\n");
}

function invalidLoadBearingFinding(): string {
  return [
    validGateRetroAnalysis(),
    "<!-- finding:start -->",
    "### Finding: Load-bearing issue",
    "- Severity: load-bearing",
    "Command:",
    "```sh",
    "npm run check",
    "```",
    "Output:",
    "```text",
    "failed",
    "```",
    "Decision/ADR projection:",
    "No decision yet.",
    "<!-- finding:end -->",
    ""
  ].join("\n");
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(output) as Record<string, any>;
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return unwrapCommandReceipt(parsed);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "harness-gate-retro-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeJson(rootDir: string, relativePath: string, value: unknown): void {
  writeFile(rootDir, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}
