import path from "node:path";
import {
  compileFdeStudioDraft,
  createSimulationSandbox,
  planPresetScaffold,
  scaffoldPresetPackage,
  simulateVerticalPackage,
  writeScaffoldFiles,
  type FdeDomainDraft,
  type FdeLocale,
  type PresetScaffoldPlan,
  type PresetScaffoldReport,
  type ScaffoldPresetInput,
  type SimulationSamplePair,
} from "@harness-anything/preset";
import { buildHtmlPreviews } from "./html-preview.ts";
import type { FdeCompiledPackage, FdePersistResult, FdeSimulateReportDto, FdeSimulationResult } from "./studio-api.ts";

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
 * Delegate Vertical/Preset/Gate/LivingDossier compilation to `@harness-anything/preset`'s
 * pure `compileFdeStudioDraft` port (dec_42EB7B8F636C12381A447E52A3/CH2) and attach UI HTML previews.
 */
export function compileStudioDraft(draft: FdeDomainDraft, rootDir: string): FdeCompiledPackage {
  const plan = compileFdeStudioDraft(draft, rootDir);
  return {
    verticalId: plan.verticalId,
    slug: plan.slug,
    title: plan.title,
    relativeTargetDir: plan.relativeTargetDir,
    defaultPresetId: plan.defaultPresetId,
    workPresetId: plan.workPresetId,
    files: plan.files,
    htmlPreviews: buildHtmlPreviews(draft, plan.livingDossier),
    dossierValidation: plan.dossierValidation,
  };
}

/**
 * Run V4's zero-side-effect `simulateVerticalPackage` inside an isolated ephemeral sandbox
 * managed by `@harness-anything/preset`'s canonical scaffold I/O port.
 */
export async function simulateStudioDraft(input: SimulateStudioDraftInput): Promise<FdeSimulationResult> {
  const compiled = compileStudioDraft(input.draft, input.rootDir);
  const sandbox = createSimulationSandbox("ha-gui-fde-sim-");
  const sandboxUserRoot = path.join(sandbox.directory, "user-presets");
  const verticalTarget = path.join(sandbox.directory, compiled.relativeTargetDir);
  try {
    writeScaffoldFiles({
      rootDir: sandbox.directory,
      targetDir: verticalTarget,
      files: compiled.files,
      overwrite: true,
      dryRun: false,
    });
    const report = await simulateVerticalPackage({
      rootDir: sandbox.directory,
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
    sandbox.close();
  }
}

/**
 * Persist a drafted vertical package to `verticals/<slug>/` through `@harness-anything/preset`'s
 * bounded `writeScaffoldFiles` port (atomic overwrite guard, containment check, dry-run support).
 */
export function persistStudioDraft(input: PersistStudioDraftInput): FdePersistResult {
  const compiled = compileStudioDraft(input.draft, input.rootDir);
  const targetDir = path.resolve(input.rootDir, compiled.relativeTargetDir);
  const written = writeScaffoldFiles({
    rootDir: input.rootDir,
    targetDir,
    files: compiled.files,
    overwrite: input.overwrite === true,
    dryRun: input.dryRun === true,
  });
  return {
    ok: true,
    mode: input.dryRun === true ? "dry-run" : "apply",
    verticalId: compiled.verticalId,
    targetDir: compiled.relativeTargetDir,
    created: written.created,
    overwritten: written.overwritten,
    nextAction: `ha vertical simulate ${compiled.relativeTargetDir}`,
  };
}

export function previewPresetScaffold(input: ScaffoldPresetInput): PresetScaffoldPlan {
  return planPresetScaffold(input);
}

export function applyPresetScaffold(input: ScaffoldPresetInput): PresetScaffoldReport {
  return scaffoldPresetPackage(input);
}
