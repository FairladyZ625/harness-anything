import path from "node:path";
import { INITIAL_SETTINGS_V1 } from "@harness-anything/kernel";
import { findLocalVerticalRoot, resolveVerticalAssetsRoot } from "./preset-assets.ts";
import { presetFailure } from "./preset-resolver-common.ts";
import { type PlannedScaffoldFile, writeScaffoldFiles } from "./vertical-scaffold-io.ts";
import { buildPresetFiles, buildSamplePayloads, buildVerticalFiles } from "./vertical-scaffold-templates.ts";

const verticalIdPattern = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/u,
  slugPattern = /^[a-z0-9][a-z0-9-]{0,127}$/u;

export interface ScaffoldVerticalInput {
  readonly rootDir: string;
  readonly verticalId: string;
  readonly title?: string;
  readonly slug?: string;
  readonly defaultPresetId?: string;
  readonly overwrite?: boolean;
  readonly dryRun?: boolean;
}

export interface VerticalScaffoldPlan {
  readonly verticalId: string;
  readonly slug: string;
  readonly title: string;
  readonly targetDir: string;
  readonly relativeTargetDir: string;
  readonly defaultPresetId: string;
  readonly workPresetId: "work-root";
  readonly gateId: string;
  readonly agentIds: readonly ["contributor", "closeout-reviewer"];
  readonly files: readonly PlannedScaffoldFile[];
}

export interface VerticalScaffoldReport {
  readonly schema: "vertical-scaffold-report/v1";
  readonly mode: "dry-run" | "apply";
  readonly verticalId: string;
  readonly slug: string;
  readonly title: string;
  readonly targetDir: string;
  readonly defaultPresetId: string;
  readonly workPresetId: "work-root";
  readonly gateId: string;
  readonly agentIds: readonly string[];
  readonly created: readonly string[];
  readonly overwritten: readonly string[];
  readonly nextAction: string;
}

export interface ScaffoldPresetInput {
  readonly rootDir: string;
  readonly presetId: string;
  readonly verticalId: string;
  readonly title?: string;
  readonly presetKind?: "template-content" | "process-action";
  readonly outputShape?: string;
  readonly overwrite?: boolean;
  readonly dryRun?: boolean;
}

export interface PresetScaffoldPlan {
  readonly presetId: string;
  readonly verticalId: string;
  readonly title: string;
  readonly targetDir: string;
  readonly relativeTargetDir: string;
  readonly bundledInLocalVertical: boolean;
  readonly gateId: string;
  readonly files: readonly PlannedScaffoldFile[];
}

export interface PresetScaffoldReport {
  readonly schema: "preset-scaffold-report/v1";
  readonly mode: "dry-run" | "apply";
  readonly presetId: string;
  readonly verticalId: string;
  readonly title: string;
  readonly targetDir: string;
  readonly bundledInLocalVertical: boolean;
  readonly gateId: string;
  readonly created: readonly string[];
  readonly overwritten: readonly string[];
  readonly nextAction: string;
}

function titleFromIdentifier(value: string): string {
  return value
    .split(/[/-]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeVerticalId(raw: string): string {
  const verticalId = raw.trim();
  if (!verticalIdPattern.test(verticalId))
    throw presetFailure(
      "invalid_vertical_id",
      `Vertical id "${raw}" must match <domain>/<name> in lowercase kebab-case (e.g. procurement/review).`,
    );
  if (verticalId === INITIAL_SETTINGS_V1.defaultVertical)
    throw presetFailure(
      "reserved_vertical",
      `Vertical "${verticalId}" is a protected builtin vertical and cannot be scaffolded under verticals/.`,
    );
  return verticalId;
}

function normalizeIdentifier(raw: string, label: string, code: string): string {
  const value = raw.trim();
  if (!slugPattern.test(value)) throw presetFailure(code, `${label} "${raw}" must match /^[a-z0-9][a-z0-9-]{0,127}$/.`);
  return value;
}

/** Pure planner for `ha vertical init` (consumable by both CLI and GUI-FDE without disk I/O). */
export function planVerticalScaffold(input: ScaffoldVerticalInput): VerticalScaffoldPlan {
  const rootDir = path.resolve(input.rootDir),
    verticalId = normalizeVerticalId(input.verticalId),
    slug = normalizeIdentifier(input.slug ?? verticalId.replaceAll("/", "-"), "Vertical slug", "invalid_slug"),
    defaultPresetId = normalizeIdentifier(
      input.defaultPresetId ?? "domain-task",
      "Default preset id",
      "invalid_preset_id",
    );
  if (defaultPresetId === "work-root")
    throw presetFailure("invalid_preset_id", 'Default preset id cannot be "work-root"; work-root is reserved.');
  const title = input.title?.trim() || titleFromIdentifier(verticalId),
    defaultPresetTitle = titleFromIdentifier(defaultPresetId),
    gateId = "deliverable-contract",
    sourceId = `${slug}/${gateId}`,
    predicateType = `${verticalId}/${gateId}/v1`,
    artifactSchema = `${verticalId}/deliverable/v1`,
    artifactPath = "artifacts/deliverable.json",
    relativeTargetDir = `verticals/${slug}`,
    targetDir = path.join(rootDir, "verticals", slug),
    files = buildVerticalFiles({
      verticalId,
      slug,
      title,
      defaultPresetId,
      defaultPresetTitle,
      gateId,
      sourceId,
      predicateType,
      artifactSchema,
      artifactPath,
    });
  return {
    verticalId,
    slug,
    title,
    targetDir,
    relativeTargetDir,
    defaultPresetId,
    workPresetId: "work-root",
    gateId,
    agentIds: ["contributor", "closeout-reviewer"],
    files,
  };
}

/** Scaffold a complete, immediately-valid local vertical under `verticals/<slug>/`. */
export function scaffoldVerticalPackage(input: ScaffoldVerticalInput): VerticalScaffoldReport {
  const plan = planVerticalScaffold(input),
    dryRun = input.dryRun === true,
    written = writeScaffoldFiles({
      rootDir: input.rootDir,
      targetDir: plan.targetDir,
      files: plan.files,
      overwrite: input.overwrite === true,
      dryRun,
    });
  return {
    schema: "vertical-scaffold-report/v1",
    mode: dryRun ? "dry-run" : "apply",
    verticalId: plan.verticalId,
    slug: plan.slug,
    title: plan.title,
    targetDir: plan.relativeTargetDir,
    defaultPresetId: plan.defaultPresetId,
    workPresetId: plan.workPresetId,
    gateId: plan.gateId,
    agentIds: [...plan.agentIds],
    created: written.created,
    overwritten: written.overwritten,
    nextAction: `ha vertical simulate --source ${plan.verticalId}`,
  };
}

/** Pure planner for `ha preset init` (consumable by both CLI and GUI-FDE without disk I/O). */
export function planPresetScaffold(input: ScaffoldPresetInput): PresetScaffoldPlan {
  const rootDir = path.resolve(input.rootDir),
    presetId = normalizeIdentifier(input.presetId, "Preset id", "invalid_preset_id"),
    verticalId = input.verticalId.trim();
  if (!verticalIdPattern.test(verticalId))
    throw presetFailure(
      "invalid_vertical_id",
      `Vertical id "${input.verticalId}" must match <domain>/<name> in lowercase kebab-case.`,
    );
  // Fail closed when the target vertical is not known in the repository or builtin catalog.
  resolveVerticalAssetsRoot(verticalId, rootDir);
  const localVerticalRoot = findLocalVerticalRoot(verticalId, rootDir),
    bundledInLocalVertical = localVerticalRoot !== null,
    targetDir = bundledInLocalVertical
      ? path.join(localVerticalRoot, "presets", presetId)
      : path.join(rootDir, "presets", presetId),
    relativeTargetDir = path.relative(rootDir, targetDir).split(path.sep).join("/"),
    title = input.title?.trim() || titleFromIdentifier(presetId),
    presetKind = input.presetKind ?? "template-content",
    outputShape = input.outputShape?.trim() || "task-package-artifact",
    gateId = `${presetId}-contract`,
    sourceId = `${presetId}/deliverable-contract`,
    predicateType = `${verticalId}/${presetId}-contract/v1`,
    artifactSchema = `${verticalId}/${presetId}/v1`,
    artifactPath = `artifacts/${presetId}.json`,
    presetFiles = buildPresetFiles({
      verticalId,
      presetId,
      title,
      presetKind,
      outputShape,
      gateId,
      sourceId,
      predicateType,
      artifactSchema,
      artifactPath,
      includeCompletionDeclaration: true,
    }),
    samples = buildSamplePayloads({ artifactSchema, artifactPath, title }),
    sampleFiles: PlannedScaffoldFile[] = bundledInLocalVertical
      ? [
          {
            relativePath: `../../samples/${gateId}/positive.json`,
            body: `${JSON.stringify({ artifacts: samples.positive }, null, 2)}\n`,
          },
          {
            relativePath: `../../samples/${gateId}/negative.json`,
            body: `${JSON.stringify({ artifacts: samples.negative }, null, 2)}\n`,
          },
        ]
      : [];
  const files: PlannedScaffoldFile[] = bundledInLocalVertical
    ? [
        ...presetFiles.map((entry) => ({
          relativePath: `presets/${presetId}/${entry.relativePath}`,
          body: entry.body,
        })),
        ...sampleFiles.map((entry) => ({
          relativePath: entry.relativePath.replace(/^\.\.\/\.\.\//u, ""),
          body: entry.body,
        })),
      ]
    : presetFiles;
  return {
    presetId,
    verticalId,
    title,
    targetDir: bundledInLocalVertical ? localVerticalRoot : targetDir,
    relativeTargetDir,
    bundledInLocalVertical,
    gateId,
    files,
  };
}

/** Scaffold a valid `preset-manifest/v3` package with bilingual templates and declarative gate. */
export function scaffoldPresetPackage(input: ScaffoldPresetInput): PresetScaffoldReport {
  const plan = planPresetScaffold(input),
    dryRun = input.dryRun === true,
    written = writeScaffoldFiles({
      rootDir: input.rootDir,
      targetDir: plan.targetDir,
      files: plan.files,
      overwrite: input.overwrite === true,
      dryRun,
    });
  return {
    schema: "preset-scaffold-report/v1",
    mode: dryRun ? "dry-run" : "apply",
    presetId: plan.presetId,
    verticalId: plan.verticalId,
    title: plan.title,
    targetDir: plan.relativeTargetDir,
    bundledInLocalVertical: plan.bundledInLocalVertical,
    gateId: plan.gateId,
    created: written.created,
    overwritten: written.overwritten,
    nextAction: plan.bundledInLocalVertical
      ? `ha vertical simulate --source ${plan.verticalId} --preset ${plan.presetId}`
      : `ha preset validate --source ${plan.relativeTargetDir} && ha preset install --source ${plan.relativeTargetDir}`,
  };
}
