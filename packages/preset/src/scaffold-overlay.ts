import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { normalizeRelativeDocumentPath } from "../../kernel/src/index.ts";
import { canonicalPresetBytes, type TemplateSelectionV1 } from "./preset.contract.ts";

export interface ProjectTemplate {
  readonly body: string;
  readonly mediaType: "text/markdown" | "text/plain";
  readonly ref: string;
}
export interface ScaffoldSelection {
  readonly selection: TemplateSelectionV1;
  readonly owner: "doc-sync";
  readonly requiredAnchors: readonly string[];
  readonly project?: ProjectTemplate;
}
export interface ScaffoldOverlayOptions {
  readonly target?: string;
  readonly templateRoot: string;
  readonly schema: "task-scaffold/v1" | "repository-scaffold/v1";
  readonly errorCode: "invalid_task_scaffold" | "invalid_repository_scaffold";
  readonly pathAllowed?: (value: string) => boolean;
  readonly replaceAllowed?: (slot: string) => boolean;
}

export function mergeScaffoldOverlay(
  options: ScaffoldOverlayOptions,
  selections: Map<string, ScaffoldSelection>,
): { readonly digest: `sha256:${string}` | null } {
  if (!options.target || !existsSync(options.target)) return { digest: null };
  const body = requiredFile(options.target, options.errorCode);
  if (!isWithinScaffoldRoot(realpathSync.native(options.templateRoot), realpathSync.native(options.target)))
    throw scaffoldFailure(options.errorCode, `Project ${options.schema} path is unsafe.`);
  const raw = parseScaffoldJson(body, options.errorCode);
  if (
    !isScaffoldOverlayRecord(raw) ||
    !exact(raw, ["schema", "replaceTemplate", "addDocument"]) ||
    raw.schema !== options.schema ||
    !Array.isArray(raw.replaceTemplate) ||
    !Array.isArray(raw.addDocument)
  )
    throw scaffoldFailure(options.errorCode, `Project ${options.schema} fields are invalid.`);
  const bound: { readonly ref: string; readonly sha256: string }[] = [],
    used = new Set([...selections.values()].map(({ selection }) => fold(selection.materializeAs)));
  for (const item of raw.replaceTemplate) {
    if (
      !isScaffoldOverlayRecord(item) ||
      !exact(item, ["slot", "template"]) ||
      typeof item.slot !== "string" ||
      typeof item.template !== "string"
    )
      throw scaffoldFailure(options.errorCode, "replaceTemplate may only name slot and template.");
    const previous = selections.get(item.slot);
    if (!previous || options.replaceAllowed?.(item.slot) === false)
      throw scaffoldFailure(options.errorCode, `Cannot replace base slot ${item.slot}.`);
    const project = projectTemplate(options, item.template);
    anchors(project, previous.requiredAnchors, item.slot);
    bound.push({ ref: project.ref, sha256: scaffoldContentHash(project.body) });
    selections.set(item.slot, { ...previous, selection: { ...previous.selection, templateRef: project.ref }, project });
  }
  for (const item of raw.addDocument) {
    if (
      !isScaffoldOverlayRecord(item) ||
      !exact(item, ["slot", "path", "template", "requiredAnchors"]) ||
      typeof item.slot !== "string" ||
      typeof item.path !== "string" ||
      typeof item.template !== "string" ||
      !hasNonEmptyScaffoldStrings(item.requiredAnchors)
    )
      throw scaffoldFailure(options.errorCode, "addDocument may only name slot, path, template, and requiredAnchors.");
    if (selections.has(item.slot) || !/\.(?:md|txt)$/u.test(item.path))
      throw scaffoldFailure(options.errorCode, `Added slot ${item.slot} must be unique prose.`);
    safePath(item.path, used, options.pathAllowed);
    const project = projectTemplate(options, item.template);
    anchors(project, item.requiredAnchors, item.slot);
    bound.push({ ref: project.ref, sha256: scaffoldContentHash(project.body) });
    selections.set(item.slot, {
      selection: {
        slot: item.slot,
        templateRef: project.ref,
        materializeAs: item.path,
        localePolicy: { prefer: "project", fallback: "en-US" },
      },
      owner: "doc-sync",
      requiredAnchors: item.requiredAnchors,
      project,
    });
  }
  return {
    digest: `sha256:${scaffoldContentHash(
      canonicalPresetBytes({
        overlay: raw,
        templates: bound.sort((left, right) => left.ref.localeCompare(right.ref)),
      }),
    )}`,
  };
}

function projectTemplate(options: ScaffoldOverlayOptions, value: string): ProjectTemplate {
  let normalized: string;
  try {
    normalized = normalizeRelativeDocumentPath(value);
  } catch {
    throw scaffoldFailure(options.errorCode, `Project template ${value} is unsafe.`);
  }
  const target = path.resolve(options.templateRoot, ...normalized.split("/"));
  if (value !== normalized || !isWithinScaffoldRoot(options.templateRoot, target) || !/\.(?:md|txt)$/u.test(value))
    throw scaffoldFailure(options.errorCode, `Project template ${value} is unsafe.`);
  const body = requiredFile(target, `missing_${options.schema.slice(0, -3).replace("-", "_")}_template`);
  if (!isWithinScaffoldRoot(realpathSync.native(options.templateRoot), realpathSync.native(target)))
    throw scaffoldFailure(options.errorCode, `Project template ${value} is unsafe.`);
  return { body, mediaType: value.endsWith(".md") ? "text/markdown" : "text/plain", ref: `project://${normalized}` }; }
function safePath(value: string, used: Set<string>, allowed?: (value: string) => boolean): void {
  let normalized: string;
  try {
    normalized = normalizeRelativeDocumentPath(value);
  } catch {
    throw scaffoldFailure("reserved_path", `Template path ${value} is unsafe or duplicated.`);
  }
  const key = fold(normalized);
  if (value !== normalized || used.has(key) || allowed?.(normalized) === false)
    throw scaffoldFailure("reserved_path", `Template path ${value} is unsafe or duplicated.`);
  used.add(key);
}
function anchors(template: ProjectTemplate, required: readonly string[], slot: string): void {
  for (const anchor of required)
    if (!template.body.includes(anchor))
      throw scaffoldFailure("required_anchor", `Template for ${slot} is missing required anchor ${anchor}.`);
}
function requiredFile(target: string, code: string): string {
  if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())
    throw scaffoldFailure(code, `Required regular file ${target} is unavailable.`);
  return readFileSync(target, "utf8");
}
function parseScaffoldJson(body: string, code: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw scaffoldFailure(code, "JSON input is invalid.");
  }
}
function scaffoldContentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
function fold(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}
function isWithinScaffoldRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
function isScaffoldOverlayRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasNonEmptyScaffoldStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}
function scaffoldFailure(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
