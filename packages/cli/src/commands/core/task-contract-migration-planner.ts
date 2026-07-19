import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileTaskContractSnapshot, parseTaskContractSnapshot } from "@harness-anything/application";
import {
  readFrontmatter,
  readNestedScalar,
  readScalar,
  type HarnessLayoutInput,
  type MaterializedTemplatePlan,
  type PresetManifest,
  type TemplateCatalog
} from "@harness-anything/kernel";
import { bundledTemplateCatalog } from "../extensions/bundled.ts";
import { isInvalidPreset, materializePresetTaskDocuments, resolvePresetEntry } from "../extensions/state.ts";
import { renderTemplateBody } from "../preset-task.ts";
import type {
  AuthoredTaskCreationEvidence,
  createAuthoredTaskCreationResolver,
  createHistoricalTaskContractResolver
} from "./task-contract-history.ts";

export interface MigrationEntry {
  readonly taskId: string;
  readonly status: "planned" | "current" | "manual" | "applied";
  readonly reason?: string;
  readonly path?: string;
  readonly preset?: string;
  readonly provenance?: "exact-current-scaffold" | "source-git-history";
  readonly sourceCommit?: string;
  readonly authoredCommit?: string;
}

export interface PlannedSnapshot {
  readonly taskId: string;
  readonly body: string;
  readonly path: string;
}

interface SelectedContract {
  readonly preset: PresetManifest;
  readonly profileId: string;
  readonly catalog: TemplateCatalog;
  readonly documents: ReadonlyArray<MaterializedTemplatePlan>;
  readonly provenance: "exact-current-scaffold" | "source-git-history";
  readonly sourceCommit?: string;
  readonly authoredCommit?: string;
}

export function planTaskContractMigration(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly rootDir: string;
  readonly indexPath: string;
  readonly locale: "zh-CN" | "en-US";
  readonly capturedAt: string;
  readonly resolveHistorical: ReturnType<typeof createHistoricalTaskContractResolver>;
  readonly resolveAuthoredCreation: ReturnType<typeof createAuthoredTaskCreationResolver>;
}): { readonly entry: MigrationEntry; readonly planned?: PlannedSnapshot } {
  const indexBody = readFileSync(input.indexPath, "utf8");
  const frontmatter = readFrontmatter(indexBody);
  const taskId = frontmatter ? readScalar(frontmatter, "task_id") : readMigrationTaskId(input.indexPath);
  if (!frontmatter || !taskId) {
    return { entry: { taskId: taskId || path.basename(path.dirname(input.indexPath)), status: "manual", reason: "task_frontmatter_missing" } };
  }
  const taskDir = path.dirname(input.indexPath);
  const contractPath = path.join(taskDir, "task-contract.json");
  const relativeContractPath = path.relative(input.rootDir, contractPath).split(path.sep).join("/");
  const vertical = readScalar(frontmatter, "vertical");
  const presetId = readScalar(frontmatter, "preset");
  const profileId = readScalar(frontmatter, "profile") || undefined;
  const title = readScalar(frontmatter, "title");
  const presetField = presetId ? { preset: presetId } : {};
  if (existsSync(contractPath)) return { entry: classifyExistingSnapshot(contractPath, relativeContractPath, taskId, vertical, presetId, profileId) };
  if (!vertical || !presetId || vertical === "default" || presetId === "default") {
    return { entry: { taskId, status: "manual", reason: "contract_metadata_incomplete", ...presetField } };
  }
  const preset = resolvePresetEntry(input.rootInput, presetId, vertical);
  if (!preset) return { entry: { taskId, status: "manual", reason: `preset_not_found:${presetId}`, preset: presetId } };
  if (isInvalidPreset(preset)) return { entry: { taskId, status: "manual", reason: `preset_invalid:${presetId}`, preset: presetId } };

  const currentCatalog = bundledTemplateCatalog(vertical);
  const current = materializePresetTaskDocuments(preset.manifest, { profileId, locale: input.locale });
  let selected: SelectedContract | undefined = currentCatalog && current.ok && current.profile && title && isExactScaffold(taskDir, title, current.documents)
    ? { preset: preset.manifest, profileId: current.profile.id, catalog: currentCatalog, documents: current.documents, provenance: "exact-current-scaffold" }
    : undefined;
  if (!selected && preset.layer === "builtin") {
    selected = selectHistoricalContract({ input, frontmatter, taskDir, title, vertical, presetId, profileId });
  }
  if (!selected) return { entry: { taskId, status: "manual", reason: "contract_provenance_unverified", preset: presetId } };
  try {
    const snapshot = compileTaskContractSnapshot({
      vertical,
      preset: selected.preset,
      profileId: selected.profileId,
      catalog: selected.catalog,
      documents: selected.documents,
      capturedAt: input.capturedAt,
      capturedBy: "legacy-migration"
    });
    return {
      entry: {
        taskId,
        status: "planned",
        path: relativeContractPath,
        preset: presetId,
        provenance: selected.provenance,
        ...(selected.sourceCommit ? { sourceCommit: selected.sourceCommit } : {}),
        ...(selected.authoredCommit ? { authoredCommit: selected.authoredCommit } : {})
      },
      planned: { taskId, body: `${JSON.stringify(snapshot, null, 2)}\n`, path: relativeContractPath }
    };
  } catch (error) {
    return { entry: { taskId, status: "manual", reason: `snapshot_compile_failed:${error instanceof Error ? error.message : String(error)}`, preset: presetId } };
  }
}

export function readMigrationTaskId(indexPath: string): string {
  try {
    const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
    return frontmatter ? readScalar(frontmatter, "task_id") : "";
  } catch {
    return "";
  }
}

function classifyExistingSnapshot(
  contractPath: string,
  relativePath: string,
  taskId: string,
  vertical: string,
  presetId: string,
  profileId: string | undefined
): MigrationEntry {
  try {
    const snapshot = parseTaskContractSnapshot(readFileSync(contractPath, "utf8"));
    if (snapshot.vertical !== vertical || snapshot.preset.id !== presetId || (profileId && snapshot.profile.id !== profileId)) {
      return { taskId, status: "manual", reason: "existing_snapshot_metadata_mismatch", path: relativePath, ...(presetId ? { preset: presetId } : {}) };
    }
    return { taskId, status: "current", path: relativePath, ...(presetId ? { preset: presetId } : {}) };
  } catch (error) {
    return { taskId, status: "manual", reason: `invalid_existing_snapshot:${error instanceof Error ? error.message : String(error)}`, path: relativePath, ...(presetId ? { preset: presetId } : {}) };
  }
}

function selectHistoricalContract(args: {
  readonly input: Parameters<typeof planTaskContractMigration>[0];
  readonly frontmatter: string;
  readonly taskDir: string;
  readonly title: string;
  readonly vertical: string;
  readonly presetId: string;
  readonly profileId?: string;
}): SelectedContract | undefined {
  const historical = args.input.resolveHistorical({
    capturedAt: readNestedScalar(args.frontmatter, "bindingCreatedAt"),
    vertical: args.vertical,
    presetId: args.presetId,
    profileId: args.profileId,
    locale: args.input.locale
  });
  if (!historical.ok) return undefined;
  const authored = args.input.resolveAuthoredCreation(args.taskDir, historical.documents.map((document) => document.materializeAs));
  if (!isHistoricalScaffoldCompatible(args.taskDir, args.title, historical.documents, authored)) return undefined;
  return {
    preset: historical.preset,
    profileId: historical.profile.id,
    catalog: historical.catalog,
    documents: historical.documents,
    provenance: "source-git-history",
    sourceCommit: historical.sourceCommit,
    ...(authored ? { authoredCommit: authored.sourceCommit } : {})
  };
}

function isExactScaffold(taskDir: string, title: string, documents: ReadonlyArray<MaterializedTemplatePlan>): boolean {
  return documents.every((document) => {
    const documentPath = path.join(taskDir, document.materializeAs);
    return existsSync(documentPath) && readFileSync(documentPath, "utf8") === renderTemplateBody(document.body, title);
  });
}

function isHistoricalScaffoldCompatible(
  taskDir: string,
  title: string,
  documents: ReadonlyArray<MaterializedTemplatePlan>,
  authored?: AuthoredTaskCreationEvidence
): boolean {
  let exactFingerprintCount = 0;
  for (const document of documents) {
    const documentPath = path.join(taskDir, document.materializeAs);
    if (!existsSync(documentPath)) return false;
    const actual = readFileSync(documentPath, "utf8");
    if (document.requiredAnchors.some((anchor) => !actual.includes(anchor))) return false;
    const evidenceBody = authored?.documents.get(document.materializeAs) ?? actual;
    if (evidenceBody === renderTemplateBody(document.body, authored?.title ?? title)) exactFingerprintCount += 1;
  }
  return exactFingerprintCount > 0;
}
