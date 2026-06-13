import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CliResult } from "../cli/types.ts";
import { evaluateFullCutoverEvidence } from "./full-cutover.ts";

export interface MigratePlanAction {
  readonly kind: "migrate-plan";
  readonly limit: number;
}

export interface MigrateStructureAction {
  readonly kind: "migrate-structure";
  readonly mode: "plan" | "apply";
  readonly confirmPlan: boolean;
}

export interface MigrateRunAction {
  readonly kind: "migrate-run";
  readonly planOnly: boolean;
  readonly outDir: string;
}

export interface MigrateVerifyAction {
  readonly kind: "migrate-verify";
  readonly sessionPath: string;
  readonly fullCutover: boolean;
}

interface MigrationAction {
  readonly kind: "task" | "module-task" | "template-remove";
  readonly source: string;
  readonly target: string;
}

interface MigrationPlan {
  readonly schema: "harness-migration-plan/v1";
  readonly mode: "baseline-preserve";
  readonly actions: ReadonlyArray<MigrationAction>;
  readonly summary: {
    readonly actionCount: number;
    readonly taskCount: number;
    readonly moduleTaskCount: number;
  };
  readonly digest: `sha256:${string}`;
}

interface MigrationSession {
  readonly schema: "harness-migration-session/v1";
  readonly planDigest: `sha256:${string}`;
  readonly applied: boolean;
  readonly sourcePack: {
    readonly schema: "harness-source-pack/v1";
    readonly digest: `sha256:${string}`;
    readonly actionCount: number;
  };
  readonly actions: ReadonlyArray<MigrationAction>;
}

export function runMigratePlan(rootDir: string, action: MigratePlanAction): CliResult {
  const plan = buildPlan(rootDir, action.limit);
  return {
    ok: true,
    command: "migrate-plan",
    rows: plan.actions.length,
    report: plan
  };
}

export function runMigrateStructure(rootDir: string, action: MigrateStructureAction): CliResult {
  const plan = buildPlan(rootDir, Number.POSITIVE_INFINITY);
  if (action.mode === "plan") {
    return {
      ok: true,
      command: "migrate-structure",
      migrationMode: "plan",
      rows: plan.actions.length,
      report: plan
    };
  }
  if (!action.confirmPlan) {
    return {
      ok: false,
      command: "migrate-structure",
      migrationMode: "apply",
      report: plan,
      error: {
        code: "plan_confirmation_required",
        hint: "Run migrate-structure --plan first, inspect the plan, then rerun --apply --confirm-plan."
      }
    };
  }
  try {
    applyPlan(rootDir, plan);
  } catch (error) {
    return migrationFailure("migrate-structure", error, plan);
  }
  return {
    ok: true,
    command: "migrate-structure",
    migrationMode: "apply",
    rows: plan.actions.length,
    report: plan
  };
}

export function runMigrateRun(rootDir: string, action: MigrateRunAction): CliResult {
  const plan = buildPlan(rootDir, Number.POSITIVE_INFINITY);
  const applied = !action.planOnly;
  if (applied) {
    try {
      applyPlan(rootDir, plan);
    } catch (error) {
      return migrationFailure("migrate-run", error, plan);
    }
  }
  const session = buildSession(plan, applied);
  const sessionPath = writeSession(rootDir, action.outDir, session);
  return {
    ok: true,
    command: "migrate-run",
    path: relative(rootDir, sessionPath),
    rows: plan.actions.length,
    report: session
  };
}

export function runMigrateVerify(rootDir: string, action: MigrateVerifyAction): CliResult {
  const sessionPath = path.resolve(rootDir, action.sessionPath);
  const session = JSON.parse(readFileSync(sessionPath, "utf8")) as MigrationSession;
  const missing = session.actions
    .filter((entry) => entry.kind !== "template-remove")
    .filter((entry) => !existsSync(path.join(rootDir, entry.target)));
  const digestOk = session.sourcePack.digest === digestJson(session.actions);
  const migrationOk = missing.length === 0 && digestOk;
  const fullCutoverEvidence = action.fullCutover ? evaluateFullCutoverEvidence(rootDir) : undefined;
  const ok = migrationOk && (fullCutoverEvidence?.ok ?? true);
  return {
    ok,
    command: "migrate-verify",
    rows: session.actions.length,
    report: {
      schema: "harness-migration-verify-report/v1",
      ok,
      planDigest: session.planDigest,
      digestOk,
      missingTargets: missing.map((entry) => entry.target),
      fullCutover: action.fullCutover,
      fullCutoverEvidence
    },
    error: ok ? undefined : {
      code: action.fullCutover ? "full_cutover_verify_failed" : "migration_verify_failed",
      hint: action.fullCutover
        ? "Migration session or final cutover evidence does not satisfy M2-P7."
        : "Migration session evidence does not match the target tree."
    }
  };
}

function buildPlan(rootDir: string, limit: number): MigrationPlan {
  const actions = [
    ...collectRootTasks(rootDir),
    ...collectModuleTasks(rootDir),
    ...collectTemplateRemovals(rootDir)
  ].slice(0, Number.isFinite(limit) ? Math.max(0, limit) : undefined);
  const planWithoutDigest = {
    schema: "harness-migration-plan/v1",
    mode: "baseline-preserve",
    actions,
    summary: {
      actionCount: actions.length,
      taskCount: actions.filter((entry) => entry.kind === "task").length,
      moduleTaskCount: actions.filter((entry) => entry.kind === "module-task").length
    }
  } satisfies Omit<MigrationPlan, "digest">;
  return {
    ...planWithoutDigest,
    digest: digestJson(planWithoutDigest)
  };
}

function collectRootTasks(rootDir: string): ReadonlyArray<MigrationAction> {
  return listDirectories(path.join(rootDir, "docs/09-PLANNING/TASKS"))
    .filter((name) => !name.startsWith("_"))
    .map((name) => ({
      kind: "task" as const,
      source: `docs/09-PLANNING/TASKS/${name}`,
      target: `harness/planning/tasks/${name}`
    }));
}

function collectModuleTasks(rootDir: string): ReadonlyArray<MigrationAction> {
  const modulesRoot = path.join(rootDir, "docs/09-PLANNING/MODULES");
  return listDirectories(modulesRoot).flatMap((moduleKey) => {
    if (moduleKey.startsWith("_")) return [];
    return listDirectories(path.join(modulesRoot, moduleKey, "TASKS"))
      .filter((name) => !name.startsWith("_"))
      .map((name) => ({
        kind: "module-task" as const,
        source: `docs/09-PLANNING/MODULES/${moduleKey}/TASKS/${name}`,
        target: `harness/planning/modules/${moduleKey}/tasks/${name}`
      }));
  });
}

function collectTemplateRemovals(rootDir: string): ReadonlyArray<MigrationAction> {
  return [
    "docs/09-PLANNING/MODULES/_task-template",
    "harness/planning/modules/_task-template"
  ].filter((entry) => existsSync(path.join(rootDir, entry))).map((entry) => ({
    kind: "template-remove" as const,
    source: entry,
    target: entry
  }));
}

function applyPlan(rootDir: string, plan: MigrationPlan): void {
  assertPlanSafe(rootDir, plan);
  for (const action of plan.actions) {
    const source = path.join(rootDir, action.source);
    const target = path.join(rootDir, action.target);
    if (action.kind === "template-remove") {
      rmSync(source, { recursive: true, force: true });
      continue;
    }
    copyTree(source, target);
    ensureTaskCloseoutFiles(target);
  }
}

function assertPlanSafe(rootDir: string, plan: MigrationPlan): void {
  const targets = new Set<string>();
  for (const action of plan.actions) {
    if (action.kind === "template-remove") continue;
    const source = path.join(rootDir, action.source);
    const target = path.join(rootDir, action.target);
    if (!existsSync(source)) throw new Error(`migration source missing: ${action.source}`);
    if (existsSync(target)) throw new Error(`migration target already exists: ${action.target}`);
    if (targets.has(action.target)) throw new Error(`duplicate migration target: ${action.target}`);
    targets.add(action.target);
  }
}

function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(sourcePath, targetPath);
      continue;
    }
    writeFileSync(targetPath, readFileSync(sourcePath));
  }
}

function ensureTaskCloseoutFiles(target: string): void {
  const defaults = {
    "walkthrough.md": "# Walkthrough\n\nMigrated task requires agent review.\n",
    "visual_map.md": "# Visual Map\n\nMigrated task requires visual map normalization.\n"
  };
  for (const [file, body] of Object.entries(defaults)) {
    const targetPath = path.join(target, file);
    if (!existsSync(targetPath)) writeFileSync(targetPath, body, "utf8");
  }
}

function buildSession(plan: MigrationPlan, applied: boolean): MigrationSession {
  return {
    schema: "harness-migration-session/v1",
    planDigest: plan.digest,
    applied,
    sourcePack: {
      schema: "harness-source-pack/v1",
      digest: digestJson(plan.actions),
      actionCount: plan.actions.length
    },
    actions: plan.actions
  };
}

function writeSession(rootDir: string, outDir: string, session: MigrationSession): string {
  const directory = path.resolve(rootDir, outDir);
  mkdirSync(directory, { recursive: true });
  const sessionPath = path.join(directory, "session.json");
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  return sessionPath;
}

function listDirectories(directory: string): ReadonlyArray<string> {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function relative(rootDir: string, targetPath: string): string {
  return path.relative(rootDir, targetPath).split(path.sep).join("/");
}

function migrationFailure(command: string, error: unknown, plan: MigrationPlan): CliResult {
  return {
    ok: false,
    command,
    report: plan,
    error: {
      code: "migration_preflight_failed",
      hint: error instanceof Error ? error.message : "Migration preflight failed."
    }
  };
}
