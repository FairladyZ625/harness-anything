import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { landedSettingDefaults } from "@harness-anything/kernel";
import { readFrontmatter, readNestedScalar, readScalar, resolveHarnessLayout } from "@harness-anything/kernel";
import { toSlash } from "./machine-evidence-registry.ts";
import type { ResolvedPresetPolicy } from "./preset-policy.ts";
import { trustedScriptRepositoryContext } from "./script-repository-context.ts";
import { isPathInside } from "./script-scope.ts";
import type { ResolvedPreset } from "./state.ts";

type ResolvedLayout = ReturnType<typeof resolveHarnessLayout>;

interface PresetContextTask {
  readonly taskId: string;
  readonly title: string;
  readonly parent: string;
  readonly status: string;
  readonly preset: string;
  readonly indexPath: string;
  readonly packagePath: string;
  readonly taskPlanSummary: string;
}

interface PresetContextDecision {
  readonly decisionId: string;
  readonly state: string;
  readonly sourcePath: string;
  readonly claims: ReadonlyArray<{ readonly id: string; readonly loadBearing: boolean }>;
  readonly relations: ReadonlyArray<{ readonly source: string; readonly target: string }>;
}

export function buildPresetContext(options: {
  readonly layout: ResolvedLayout;
  readonly projectRoot: string;
  readonly preset: ResolvedPreset;
  readonly entrypointName: string;
  readonly taskId: string;
  readonly inputs: Record<string, unknown>;
  readonly readRoots: ReadonlyArray<string>;
  readonly writeRoots: ReadonlyArray<string>;
  readonly outputRoot: string;
  readonly policy: ResolvedPresetPolicy | null;
}): Record<string, unknown> {
  return {
    schema: "preset-context/v1",
    presetId: options.preset.manifest.id,
    presetTitle: options.preset.manifest.title,
    entrypoint: options.entrypointName,
    taskId: options.taskId,
    paths: {
      projectRoot: options.projectRoot,
      rootDir: options.layout.rootDir,
      authoredRoot: options.layout.authoredRoot,
      tasksRoot: options.layout.tasksRoot,
      decisionsRoot: options.layout.decisionsRoot,
      sessionsRoot: options.layout.sessionsRoot,
      adrRoot: options.layout.adrRoot,
      milestonesRoot: options.layout.milestonesRoot,
      generatedRoot: options.layout.generatedRoot,
      localRoot: options.layout.localRoot
    },
    inputs: options.inputs,
    repository: trustedScriptRepositoryContext(options.projectRoot),
    policy: options.policy,
    readScopes: options.readRoots,
    writeScopes: options.writeRoots,
    outputRoot: options.outputRoot,
    ...buildPresetContextProjections({
      layout: options.layout,
      outputRoot: options.outputRoot,
      readRoots: options.readRoots
    })
  };
}

export function buildPresetContextProjections(options: {
  readonly layout: ResolvedLayout;
  readonly outputRoot: string;
  readonly readRoots: ReadonlyArray<string>;
  readonly maxMilestoneFiles?: number;
  readonly maxMilestoneNotes?: number;
  readonly env?: NodeJS.ProcessEnv;
}): Record<string, unknown> {
  const milestoneLimits = resolvePresetContextMilestoneLimits(options);
  return {
    taskIndex: readTaskIndexContext(options.layout, options.readRoots),
    taskEvidence: readTaskEvidenceContext(options.layout, options.outputRoot, options.readRoots),
    milestoneCriteria: readMilestoneCriteriaContext(options.layout, options.readRoots),
    milestoneNotes: readMilestoneNotesContext(options.layout, options.readRoots, milestoneLimits),
    decisions: readDecisionContext(options.layout, options.readRoots),
    factRefs: readFactRefsContext(options.layout, options.readRoots)
  };
}

function readTaskIndexContext(layout: ResolvedLayout, readRoots: ReadonlyArray<string>): ReadonlyArray<PresetContextTask> {
  return collectMarkdownFiles(readRoots)
    .filter((filePath) => path.basename(filePath) === "INDEX.md" && isPathInside(layout.tasksRoot, filePath))
    .flatMap((indexPath) => {
      const body = readOptionalFile(indexPath);
      const frontmatter = readFrontmatter(body);
      if (!frontmatter) return [];
      const taskId = scalar(frontmatter, "task_id");
      if (!taskId) return [];
      const taskPlanPath = path.join(path.dirname(indexPath), "task_plan.md");
      return [{
        taskId,
        title: scalar(frontmatter, "title"),
        parent: scalar(frontmatter, "parent"),
        status: nestedScalar(frontmatter, "status") || scalar(frontmatter, "status") || "unknown",
        preset: scalar(frontmatter, "preset"),
        indexPath: relativeContextPath(layout.rootDir, indexPath),
        packagePath: relativeContextPath(layout.rootDir, path.dirname(indexPath)),
        taskPlanSummary: isReadablePath(taskPlanPath, readRoots) ? summarizeMarkdown(readOptionalFile(taskPlanPath)) : ""
      }];
    })
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function readTaskEvidenceContext(
  layout: ResolvedLayout,
  outputRoot: string,
  readRoots: ReadonlyArray<string>
): ReadonlyArray<{ readonly sourcePath: string; readonly body: string }> {
  if (!isReadablePath(outputRoot, readRoots)) return [];
  return collectMarkdownFiles([outputRoot])
    .filter((filePath) => !toSlash(path.relative(outputRoot, filePath)).startsWith("artifacts/"))
    .map((filePath) => ({
      sourcePath: relativeContextPath(layout.rootDir, filePath),
      body: readOptionalFile(filePath)
    }));
}

function readMilestoneCriteriaContext(
  layout: ResolvedLayout,
  readRoots: ReadonlyArray<string>
): ReadonlyArray<{ readonly status: "red"; readonly reason: "unclassified"; readonly sourcePath: string; readonly line: number; readonly checked: boolean; readonly text: string }> {
  return collectMarkdownFiles(readRoots)
    .filter((filePath) => isPathInside(layout.milestonesRoot, filePath))
    .filter((filePath) => /(?:^|\/)(?:feature-breakdown|milestone-closeout|exit-criteria)\.md$/u.test(toSlash(filePath)))
    .flatMap((filePath) => {
      const relativePath = relativeContextPath(layout.rootDir, filePath);
      return readOptionalFile(filePath).split(/\r?\n/u).flatMap((line, index) => {
        const match = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/u.exec(line);
        if (!match) return [];
        return [{
          status: "red" as const,
          reason: "unclassified" as const,
          sourcePath: relativePath,
          line: index + 1,
          checked: match[1] !== " ",
          text: match[2].trim()
        }];
      });
    });
}

function readMilestoneNotesContext(
  layout: ResolvedLayout,
  readRoots: ReadonlyArray<string>,
  limits: { readonly maxFiles: number; readonly maxNotes: number }
): ReadonlyArray<string> {
  const notes: string[] = [];
  for (const filename of collectMarkdownFiles(readRoots).filter((filePath) => isPathInside(layout.milestonesRoot, filePath)).slice(0, limits.maxFiles)) {
    for (const line of readOptionalFile(filename).split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (/acceptance|验收|criteria/iu.test(trimmed)) notes.push(trimmed.replace(/^[-*#\s]+/u, ""));
      if (notes.length >= limits.maxNotes) return notes;
    }
  }
  return notes;
}

export function resolvePresetContextMilestoneLimits(options: {
  readonly maxMilestoneFiles?: number;
  readonly maxMilestoneNotes?: number;
  readonly env?: NodeJS.ProcessEnv;
} = {}): { readonly maxFiles: number; readonly maxNotes: number } {
  const env = options.env ?? process.env;
  return {
    maxFiles: contextLimit("HARNESS_PRESET_CONTEXT_MAX_MILESTONES", options.maxMilestoneFiles, env.HARNESS_PRESET_CONTEXT_MAX_MILESTONES, landedSettingDefaults.presetContextMaxMilestones, 200),
    maxNotes: contextLimit("HARNESS_PRESET_CONTEXT_MAX_NOTES", options.maxMilestoneNotes, env.HARNESS_PRESET_CONTEXT_MAX_NOTES, landedSettingDefaults.presetContextMaxNotes, 50)
  };
}

function contextLimit(name: string, explicit: number | undefined, raw: string | undefined, fallback: number, maximum: number): number {
  const value = explicit ?? (raw === undefined ? fallback : /^[0-9]+$/u.test(raw.trim()) ? Number(raw) : Number.NaN);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function readDecisionContext(layout: ResolvedLayout, readRoots: ReadonlyArray<string>): ReadonlyArray<PresetContextDecision> {
  return collectMarkdownFiles(readRoots)
    .filter((filePath) => path.basename(filePath) === "decision.md" && isPathInside(layout.decisionsRoot, filePath))
    .flatMap((filePath) => {
      const body = readOptionalFile(filePath);
      const frontmatter = readFrontmatter(body);
      if (!frontmatter) return [];
      return [{
        decisionId: scalar(frontmatter, "decision_id") || path.basename(path.dirname(filePath)).replace(/^decision-/u, ""),
        state: scalar(frontmatter, "state"),
        sourcePath: relativeContextPath(layout.rootDir, filePath),
        claims: readDecisionClaims(frontmatter),
        relations: readDecisionRelations(frontmatter)
      }];
    });
}

function readFactRefsContext(layout: ResolvedLayout, readRoots: ReadonlyArray<string>): ReadonlyArray<string> {
  const refs = new Set<string>();
  for (const factsPath of collectMarkdownFiles(readRoots).filter((filePath) => path.basename(filePath) === "facts.md" && isPathInside(layout.tasksRoot, filePath))) {
    const taskDir = path.dirname(factsPath);
    const taskId = readTaskId(taskDir) || path.basename(taskDir);
    for (const match of readOptionalFile(factsPath).matchAll(/\bfact_id:\s*"?([A-Za-z0-9_-]+)"?/gu)) {
      refs.add(`fact/${taskId}/${match[1]}`);
    }
  }
  return [...refs].sort();
}

function readTaskId(taskDir: string): string {
  const frontmatter = readFrontmatter(readOptionalFile(path.join(taskDir, "INDEX.md")));
  return frontmatter ? scalar(frontmatter, "task_id") : "";
}

function readDecisionClaims(frontmatter: string): PresetContextDecision["claims"] {
  return readFlowBlock(frontmatter, "claims").flatMap((line) => {
    const object = parseFlowObjectLine(line);
    if (!object.id) return [];
    return [{ id: object.id, loadBearing: object.load_bearing !== "false" }];
  });
}

function readDecisionRelations(frontmatter: string): PresetContextDecision["relations"] {
  return readFlowBlock(frontmatter, "relations").flatMap((line) => {
    const object = parseFlowObjectLine(line);
    return object.source && object.target ? [{ source: object.source, target: object.target }] : [];
  });
}

function readFlowBlock(body: string, key: string): ReadonlyArray<string> {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start < 0) return [];
  const output: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    if (/^\s*-\s*\{/u.test(line)) output.push(line.trim());
  }
  return output;
}

function parseFlowObjectLine(line: string): Record<string, string> {
  const body = line.replace(/^\s*-\s*\{\s*/u, "").replace(/\s*\}\s*$/u, "");
  const object: Record<string, string> = {};
  for (const part of splitTopLevel(body)) {
    const separator = part.indexOf(":");
    if (separator <= 0) continue;
    object[part.slice(0, separator).trim()] = unquote(part.slice(separator + 1).trim());
  }
  return object;
}

function splitTopLevel(value: string): ReadonlyArray<string> {
  const parts: string[] = [];
  let inString = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (char === "\"" && previous !== "\\") inString = !inString;
    if (!inString && char === ",") {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function scalar(frontmatter: string, key: string): string {
  return unquote(readScalar(frontmatter, key));
}

function nestedScalar(frontmatter: string, key: string): string {
  return unquote(readNestedScalar(frontmatter, key));
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function collectMarkdownFiles(roots: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(roots.flatMap((root) => walkMarkdown(root)))].sort();
}

function walkMarkdown(root: string): ReadonlyArray<string> {
  if (!root || !existsSync(root)) return [];
  const stats = statSync(root);
  if (stats.isFile()) return root.endsWith(".md") ? [root] : [];
  if (!stats.isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry): ReadonlyArray<string> => {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return walkMarkdown(entryPath);
    if (entry.isFile() && entry.name.endsWith(".md")) return [entryPath];
    return [];
  });
}

function isReadablePath(candidate: string, readRoots: ReadonlyArray<string>): boolean {
  return readRoots.some((readRoot) => isPathInside(readRoot, candidate));
}

function summarizeMarkdown(markdown: string): string {
  return markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("---"))
    .slice(0, 3)
    .join(" ");
}

function readOptionalFile(filename: string): string {
  try {
    return readFileSync(filename, "utf8");
  } catch {
    return "";
  }
}

function relativeContextPath(rootDir: string, targetPath: string): string {
  return toSlash(path.relative(rootDir, targetPath));
}
