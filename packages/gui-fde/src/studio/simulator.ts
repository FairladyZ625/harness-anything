import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  planPresetScaffold,
  scaffoldPresetPackage,
  scaffoldVerticalPackage,
  simulateVerticalPackage,
  type PresetScaffoldPlan,
  type PresetScaffoldReport,
  type ScaffoldPresetInput,
  type SimulationSamplePair,
} from "@harness-anything/preset";
import { compileStudioDraft } from "./compiler.ts";
import type { FdeDomainDraft, FdeLocale } from "./domain-draft.ts";
import type { FdePersistResult, FdeSimulateReportDto, FdeSimulationResult } from "./studio-api.ts";

export interface SimulateStudioDraftInput {
  readonly draft: FdeDomainDraft;
  readonly rootDir: string;
  readonly locale?: FdeLocale;
  readonly presetId?: string;
  readonly profileId?: string;
  readonly sampleOverrides?: Readonly<Record<string, SimulationSamplePair>>;
}

export interface PersistStudioDraftInput {
  readonly draft: FdeDomainDraft;
  readonly rootDir: string;
  readonly overwrite?: boolean;
  readonly dryRun?: boolean;
}

/**
 * Run V4's zero-side-effect `simulateVerticalPackage` inside an isolated ephemeral sandbox
 * populated with the compiled draft, returning real schema/bootstrap/agent/gate verdicts.
 */
export async function simulateStudioDraft(input: SimulateStudioDraftInput): Promise<FdeSimulationResult> {
  const compiled = compileStudioDraft(input.draft, input.rootDir);
  const sandboxRoot = mkdtempSync(path.join(tmpdir(), "ha-gui-fde-sim-"));
  const sandboxUserRoot = path.join(sandboxRoot, "user-presets");
  const verticalTarget = path.join(sandboxRoot, compiled.relativeTargetDir);
  try {
    for (const file of compiled.files) {
      const targetPath = path.join(verticalTarget, file.relativePath);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, file.body, "utf8");
    }
    const report = await simulateVerticalPackage({
      rootDir: sandboxRoot,
      source: compiled.relativeTargetDir,
      locale: input.locale ?? input.draft.locale,
      ...(input.presetId ? { presetId: input.presetId } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      userRoot: sandboxUserRoot,
      ...(input.sampleOverrides ? { samplePayloads: input.sampleOverrides } : {}),
    });
    return {
      compiled,
      report: report as unknown as FdeSimulateReportDto,
    };
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

/**
 * Persist a drafted vertical package to `verticals/<slug>/` through V4's canonical
 * `scaffoldVerticalPackage`, then apply the visual edits deterministically when not dry-run.
 */
export function persistStudioDraft(input: PersistStudioDraftInput): FdePersistResult {
  const compiled = compileStudioDraft(input.draft, input.rootDir);
  const report = scaffoldVerticalPackage({
    rootDir: input.rootDir,
    verticalId: input.draft.verticalId,
    slug: input.draft.slug,
    title: input.draft.title,
    defaultPresetId: input.draft.defaultPresetId,
    overwrite: input.overwrite === true,
    dryRun: input.dryRun === true,
  });
  if (input.dryRun !== true) {
    const targetRoot = path.resolve(input.rootDir, compiled.relativeTargetDir);
    for (const file of compiled.files) {
      const targetPath = path.join(targetRoot, file.relativePath);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, file.body, "utf8");
    }
  }
  return {
    ok: true,
    mode: report.mode,
    verticalId: report.verticalId,
    targetDir: report.targetDir,
    created: report.created,
    overwritten: report.overwritten,
    nextAction: report.nextAction,
  };
}

export function previewPresetScaffold(input: ScaffoldPresetInput): PresetScaffoldPlan {
  return planPresetScaffold(input);
}

export function applyPresetScaffold(input: ScaffoldPresetInput): PresetScaffoldReport {
  return scaffoldPresetPackage(input);
}
