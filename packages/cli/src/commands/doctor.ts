import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput } from "@harness-anything/kernel";
import {
  inspectDeclaredIdentityState,
  rebuildTaskProjection,
  repairDeclaredIdentityState,
  resolveHarnessLayout,
  type DeclaredIdentityConflictReport,
  type DeclaredIdentityRepairReport
} from "@harness-anything/kernel";
import type { CliResult } from "../cli/types.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { resolveSettingsView, type ResolvedSettingRow } from "./resolved-settings-view.ts";
import {
  collectRuntimeAttestation,
  type RuntimeAttestationReport
} from "./runtime-attestation.ts";

export interface DoctorReport {
  readonly schema: "harness-doctor/v1";
  readonly readOnly: boolean;
  readonly node: {
    readonly version: string;
    readonly requiredMajor: 24;
    readonly ok: boolean;
  };
  readonly git: {
    readonly insideWorkTree: boolean;
  };
  readonly harness: {
    readonly authoredRoot: string;
    readonly authoredRootExists: boolean;
    readonly authoredRootGitExists: boolean;
    readonly localRoot: string;
    readonly localRootExists: boolean;
    readonly projectionCacheExists: boolean;
    readonly isolation: {
      readonly ok: boolean;
      readonly findings: ReadonlyArray<{
        readonly code: "harness_git_missing" | "outer_gitignore_missing";
        readonly severity: "warning";
        readonly message: string;
        readonly repairCommand: string;
      }>;
      readonly nextSteps: readonly string[];
    };
  };
  readonly cli: {
    readonly command: "harness-anything doctor";
    readonly json: "command-receipt/v2";
  };
  readonly settings: {
    readonly sourceAuthority: "@harness-anything/kernel:landed-settings-registry";
    readonly rows: ReadonlyArray<ResolvedSettingRow>;
    readonly error?: string;
  };
  readonly ledger: {
    readonly checked: boolean;
    readonly ok: boolean;
    readonly scope: string;
    readonly declaredIdentity: {
      readonly sourceCount: number;
      readonly conflictCount: number;
      readonly misplacedCount: number;
      readonly conflicts: ReadonlyArray<DeclaredIdentityConflictReport>;
    };
    readonly notChecked: ReadonlyArray<string>;
    readonly checkCommand: string;
    readonly repairCommand: string;
    readonly repair: {
      readonly requested: boolean;
      readonly changed: boolean;
      readonly report?: DeclaredIdentityRepairReport;
      readonly projectionRebuilt: boolean;
      readonly error?: string;
    };
  };
  readonly runtime: RuntimeAttestationReport;
  readonly recommendedCommands: readonly string[];
}

export function runDoctor(rootInput: HarnessLayoutInput, options: { readonly repair?: boolean } = {}): CliResult {
  const settings = resolveSettingsView(rootInput);
  const settingsRows = settings.ok ? settings.rows : [];
  const settingsError = settings.ok ? undefined : settings.result.error?.hint ?? "Harness settings could not be resolved.";
  const repairRequested = options.repair === true;
  let repairReport: DeclaredIdentityRepairReport | undefined;
  let repairError: string | undefined;
  let projectionRebuilt = false;
  if (repairRequested && existsSync(resolveHarnessLayout(rootInput).authoredRoot)) {
    try {
      repairReport = repairDeclaredIdentityState(rootInput);
      if (repairReport.unresolved.length === 0) {
        rebuildTaskProjection({ rootDir: resolveHarnessLayout(rootInput).rootDir });
        projectionRebuilt = true;
      }
    } catch (error) {
      repairError = error instanceof Error ? error.message : String(error);
    }
  }
  const report = collectDoctorReport(rootInput, settingsRows, {
    repairRequested,
    repairReport,
    projectionRebuilt,
    repairError,
    settingsError
  });
  const healthy = settings.ok && report.ledger.ok && report.ledger.repair.error === undefined && (report.ledger.repair.report?.unresolved.length ?? 0) === 0;
  return {
    ok: healthy,
    command: "doctor",
    report,
    ...(healthy ? {} : {
      error: settings.ok
        ? cliError(
          CliErrorCode.ProjectionCheckFailed,
          repairRequested
            ? "Ledger repair did not converge all declared identity conflicts; inspect the doctor report before retrying."
            : "Ledger contains declared identity conflicts; run ha doctor --repair --json before retrying reads."
        )
        : settings.result.error
    })
  };
}

function collectDoctorReport(
  rootInput: HarnessLayoutInput,
  settingsRows: ReadonlyArray<ResolvedSettingRow>,
  options: {
    readonly repairRequested: boolean;
    readonly repairReport?: DeclaredIdentityRepairReport;
    readonly projectionRebuilt: boolean;
    readonly repairError?: string;
    readonly settingsError?: string;
  } = { repairRequested: false, projectionRebuilt: false }
): DoctorReport {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const gitInsideWorkTree = isInsideDoctorGitWorkTree(rootDir);
  const harnessIsolation = inspectHarnessIsolation(rootDir, doctorRelativeLayoutPath(rootDir, layout.authoredRoot), gitInsideWorkTree);
  const ledger = collectLedgerReport(rootInput, options);
  const runtime = collectRuntimeAttestation({
    rootDir,
    cliPackageRoot: resolveCliPackageRoot(),
    bindingRoot: path.join(layout.generatedRoot, "worktree-bindings")
  });
  return {
    schema: "harness-doctor/v1",
    readOnly: !options.repairRequested,
    node: {
      version: process.versions.node,
      requiredMajor: 24,
      ok: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 24
    },
    git: {
      insideWorkTree: gitInsideWorkTree
    },
    harness: {
      authoredRoot: doctorRelativeLayoutPath(rootDir, layout.authoredRoot),
      authoredRootExists: existsSync(layout.authoredRoot),
      authoredRootGitExists: existsSync(path.join(layout.authoredRoot, ".git")),
      localRoot: doctorRelativeLayoutPath(rootDir, layout.localRoot),
      localRootExists: existsSync(layout.localRoot),
      projectionCacheExists: existsSync(path.join(layout.cacheRoot, "projections.sqlite")),
      isolation: harnessIsolation
    },
    cli: {
      command: "harness-anything doctor",
      json: "command-receipt/v2"
    },
    settings: {
      sourceAuthority: "@harness-anything/kernel:landed-settings-registry",
      rows: settingsRows,
      ...(options.settingsError ? { error: options.settingsError } : {})
    },
    ledger,
    runtime,
    recommendedCommands: recommendedDoctorCommands(ledger, runtime),
  };
}

function recommendedDoctorCommands(ledger: DoctorReport["ledger"], runtime: RuntimeAttestationReport): readonly string[] {
  const commands = [
      "harness-anything init",
      "harness-anything status --json",
      "harness-anything check --post-merge --json",
      "harness-anything git-diff --json"
  ];
  const repairNeeded = !ledger.ok || ledger.repair.error !== undefined || (ledger.repair.report?.unresolved.length ?? 0) > 0;
  if (repairNeeded) commands.push("harness-anything doctor --repair --json");
  const runtimeNeedsRestart = runtime.findings.some((finding) =>
    finding.findingCode === "daemon_socket_orphan"
    || finding.findingCode === "daemon_socket_missing_with_owner"
    || finding.findingCode === "daemon_process_stale"
    || finding.findingCode === "daemon_socket_owner_unknown");
  const runtimeNeedsRebuild = runtime.findings.some((finding) =>
    finding.findingCode === "cli_dist_missing"
    || finding.findingCode === "cli_dist_stale"
    || finding.findingCode === "daemon_provenance_drift"
    || finding.findingCode === "daemon_provenance_unavailable");
  if (runtimeNeedsRebuild && !commands.includes("npm -w @harness-anything/cli run build")) {
    commands.push("npm -w @harness-anything/cli run build");
  }
  if (runtimeNeedsRestart && !commands.includes("harness-anything daemon restart")) {
    commands.push("harness-anything daemon restart");
  }
  return commands;
}

function collectLedgerReport(
  rootInput: HarnessLayoutInput,
  options: {
    readonly repairRequested: boolean;
    readonly repairReport?: DeclaredIdentityRepairReport;
    readonly projectionRebuilt: boolean;
    readonly repairError?: string;
  }
): DoctorReport["ledger"] {
  const layout = resolveHarnessLayout(rootInput);
  const baseRepair = {
    requested: options.repairRequested,
    changed: options.repairReport?.changed ?? false,
    ...(options.repairReport ? { report: options.repairReport } : {}),
    projectionRebuilt: options.projectionRebuilt,
    ...(options.repairError ? { error: options.repairError } : {})
  } satisfies DoctorReport["ledger"]["repair"];
  if (!existsSync(layout.authoredRoot)) {
    return {
      checked: false,
      ok: true,
      scope: "No authored harness root exists; declaration identity checks were not applicable.",
      declaredIdentity: { sourceCount: 0, conflictCount: 0, misplacedCount: 0, conflicts: [] },
      notChecked: ["projection cache integrity", "materializer/session branch state"],
      checkCommand: "ha check --post-merge --json",
      repairCommand: "ha doctor --repair --json",
      repair: baseRepair
    };
  }
  try {
    const inspection = inspectDeclaredIdentityState(rootInput);
    return {
      checked: true,
      ok: inspection.conflicts.length === 0 && inspection.misplaced.length === 0,
      scope: "Read-only scan of authored declared entity sources and their layout-derived canonical paths.",
      declaredIdentity: {
        sourceCount: inspection.sourceCount,
        conflictCount: inspection.conflicts.length,
        misplacedCount: inspection.misplaced.length,
        conflicts: inspection.conflicts
      },
      notChecked: ["projection cache integrity", "materializer/session branch state"],
      checkCommand: "ha check --post-merge --json",
      repairCommand: "ha doctor --repair --json",
      repair: baseRepair
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      scope: "Read-only scan of authored declared entity sources and their layout-derived canonical paths.",
      declaredIdentity: { sourceCount: 0, conflictCount: 0, misplacedCount: 0, conflicts: [] },
      notChecked: ["projection cache integrity", "materializer/session branch state"],
      checkCommand: "ha check --post-merge --json",
      repairCommand: "ha doctor --repair --json",
      repair: {
        ...baseRepair,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function inspectHarnessIsolation(
  rootDir: string,
  authoredRoot: string,
  outerGitInsideWorkTree: boolean
): DoctorReport["harness"]["isolation"] {
  const findings: Array<DoctorReport["harness"]["isolation"]["findings"][number]> = [];
  const authoredRootPath = path.join(rootDir, authoredRoot);
  if (existsSync(authoredRootPath) && !existsSync(path.join(authoredRootPath, ".git"))) {
    findings.push({
      code: "harness_git_missing",
      severity: "warning",
      message: `${authoredRoot}/ exists but is not an independent git repository.`,
      repairCommand: "harness-anything init"
    });
  }
  if (existsSync(authoredRootPath) && outerGitInsideWorkTree && !gitignoreContainsHarness(rootDir, authoredRoot)) {
    findings.push({
      code: "outer_gitignore_missing",
      severity: "warning",
      message: `.gitignore does not isolate ${authoredRoot}/ from the outer code repository.`,
      repairCommand: "harness-anything init"
    });
  }
  return {
    ok: findings.length === 0,
    findings,
    nextSteps: findings.length === 0
      ? []
      : [
        "harness-anything init",
        `git -C ${authoredRoot} status`
      ]
  };
}

function gitignoreContainsHarness(rootDir: string, authoredRoot: string): boolean {
  const gitignorePath = path.join(rootDir, ".gitignore");
  if (!existsSync(gitignorePath)) return false;
  const entries = readFileSync(gitignorePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return entries.some((entry) => entry === `${authoredRoot}/` || entry === `/${authoredRoot}/`);
}

function doctorRelativeLayoutPath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function isInsideDoctorGitWorkTree(rootDir: string): boolean {
  try {
    const output = execFileSync("git", ["-C", rootDir, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
    return output === "true";
  } catch {
    return false;
  }
}

// Resolve the CLI's own package root from this module's location so the
// runtime attestation can compare src/ and dist/ mtimes regardless of whether
// doctor is loaded from TypeScript source (dev / test) or compiled dist.
function resolveCliPackageRoot(): string {
  let current = path.resolve(import.meta.dirname);
  for (let depth = 0; depth < 8; depth++) {
    const manifestPath = path.join(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { readonly name?: unknown };
        if (manifest.name === "@harness-anything/cli") return current;
      } catch {
        // Skip malformed package.json and keep walking.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(import.meta.dirname, "../..");
}
