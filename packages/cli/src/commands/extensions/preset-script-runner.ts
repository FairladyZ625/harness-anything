import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import { PresetManifestSchema } from "../../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { readFrontmatter, readNestedScalar, readScalar, resolveHarnessLayout, taskPackagePath } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode, isCliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { ResolvedPreset } from "./state.ts";
import type { ScriptEntry } from "./script-host.ts";
import {
  isPathInside,
  listGeneratedFiles,
  permissionPathsForScope,
  resolveDeclaredReadScopes,
  resolveDeclaredWriteScopes,
  uniquePermissionPaths
} from "./script-scope.ts";

type PresetManifest = Schema.Schema.Type<typeof PresetManifestSchema>;
type ScriptEntrypoint = Extract<NonNullable<PresetManifest["entrypoints"]>[string], { readonly type: "script" }>;
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

export function presetScriptEntry(preset: ResolvedPreset, entrypoint: ScriptEntrypoint, entrypointName: string): ScriptEntry {
  return {
    id: `preset:${preset.manifest.id}:${entrypointName}`,
    source: "preset",
    type: "script",
    command: entrypoint.command,
    reads: entrypoint.reads ?? [],
    writes: entrypoint.writes,
    inputs: entrypoint.inputs ?? {},
    metadata: {
      description: `${preset.manifest.title} ${entrypointName}`,
      purpose: presetScriptPurpose(entrypointName),
      contractVersion: "script-entry/v1",
      produces: entrypoint.writes
    }
  };
}

function presetScriptPurpose(entrypointName: string): ScriptEntry["metadata"]["purpose"] {
  if (entrypointName === "scaffold") return "scaffold";
  if (entrypointName === "check" || entrypointName === "audit") return "audit";
  return "generate";
}

export function runScriptEntrypoint(
  rootInput: HarnessLayoutInput,
  preset: ResolvedPreset,
  presetSummary: unknown,
  entrypoint: ScriptEntrypoint,
  entrypointName: string,
  taskId: string,
  evidenceDir: string,
  commandName: "preset-run" | "preset-action"
): { readonly ok: true; readonly generated: ReadonlyArray<string>; readonly scriptedResult?: Record<string, unknown> } | { readonly ok: false; readonly result: CliResult } {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const presetRoot = path.dirname(preset.sourcePath);
  const scriptPath = path.resolve(presetRoot, entrypoint.command);
  if (!isPathInside(presetRoot, scriptPath) || !existsSync(scriptPath)) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        error: cliError(CliErrorCode.PresetScriptNotFound, "Preset script entrypoint was not found inside the preset package.")
      }
    };
  }
  const outputRoot = taskPackagePath(rootInput, taskId);
  const writeScope = resolveDeclaredWriteScopes(entrypoint.writes, layout, outputRoot);
  const readScope = entrypoint.reads
    ? resolveDeclaredReadScopes(entrypoint.reads, layout, outputRoot)
    : { ok: true as const, roots: [], permissions: [] };
  if (!readScope.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        error: cliError(CliErrorCode.PresetReadScopeInvalid, "Preset script reads must declare supported project-local scopes.")
      }
    };
  }
  if (!writeScope.ok || !writeScope.roots.some((allowedRoot) => isPathInside(allowedRoot, outputRoot))) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        error: cliError(CliErrorCode.PresetWriteScopeInvalid, "Preset script writes must declare a supported scope that covers the generated output root.")
      }
    };
  }
  mkdirSync(outputRoot, { recursive: true });
  const contextPath = path.join(evidenceDir, "context.json");
  writeFileSync(contextPath, JSON.stringify(buildPresetContext({
    layout,
    preset,
    entrypointName,
    taskId,
    inputs: entrypoint.inputs ?? {},
    readRoots: readScope.roots,
    writeRoots: writeScope.roots,
    outputRoot
  }), null, 2), "utf8");
  const beforeFiles = new Set(listGeneratedFiles(outputRoot));
  const readablePaths = uniquePermissionPaths([
    ...permissionPathsForScope(presetRoot, true),
    ...scriptRelativeImportPermissions(scriptPath, presetRoot),
    contextPath,
    ...readScope.permissions
  ]);
  const writablePaths = uniquePermissionPaths(writeScope.permissions);
  const result = spawnSync(process.execPath, [
    "--permission",
    ...readablePaths.map((allowedPath) => `--allow-fs-read=${allowedPath}`),
    ...writablePaths.map((allowedPath) => `--allow-fs-write=${allowedPath}`),
    scriptPath
  ], {
    cwd: presetRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_PRESET_CONTEXT: contextPath
    }
  });
  writeFileSync(path.join(evidenceDir, "stdout.txt"), result.stdout ?? "", "utf8");
  writeFileSync(path.join(evidenceDir, "stderr.txt"), result.stderr ?? "", "utf8");
  if (result.status !== 0) {
    const permissionOutput = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    const accessDenied = permissionOutput.includes("ERR_ACCESS_DENIED");
    const readDenied = accessDenied && permissionOutput.includes("FileSystemRead");
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        evidenceBundle: path.relative(rootDir, evidenceDir).split(path.sep).join("/"),
        error: accessDenied
          ? readDenied
            ? cliError(CliErrorCode.PresetReadScopeViolation, "Preset script attempted filesystem read outside its declared permission scope.")
            : cliError(CliErrorCode.PresetWriteScopeViolation, "Preset script attempted filesystem write outside its declared permission scope.")
          : cliError(CliErrorCode.PresetScriptFailed, `Preset script exited with status ${result.status ?? "unknown"}.`)
      }
    };
  }
  const generatedFiles = listGeneratedFiles(outputRoot);
  const outOfScope = generatedFiles.filter((filePath) => !writeScope.roots.some((allowedRoot) => isPathInside(allowedRoot, filePath)));
  if (outOfScope.length > 0) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        evidenceBundle: path.relative(rootDir, evidenceDir).split(path.sep).join("/"),
        generated: generatedFiles.map((filePath) => path.relative(rootDir, filePath).split(path.sep).join("/")),
        error: cliError(CliErrorCode.PresetWriteScopeViolation, "Preset script produced files outside its declared write scopes.")
      }
    };
  }
  return {
    ok: true,
    generated: generatedFiles
      .filter((filePath) => !beforeFiles.has(filePath))
      .map((filePath) => path.relative(rootDir, filePath).split(path.sep).join("/")),
    scriptedResult: readScriptedResult(outputRoot)
  };
}

function buildPresetContext(options: {
  readonly layout: ResolvedLayout;
  readonly preset: ResolvedPreset;
  readonly entrypointName: string;
  readonly taskId: string;
  readonly inputs: Record<string, unknown>;
  readonly readRoots: ReadonlyArray<string>;
  readonly writeRoots: ReadonlyArray<string>;
  readonly outputRoot: string;
}): Record<string, unknown> {
  return {
    schema: "preset-context/v1",
    presetId: options.preset.manifest.id,
    presetTitle: options.preset.manifest.title,
    entrypoint: options.entrypointName,
    taskId: options.taskId,
    paths: {
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
    readScopes: options.readRoots,
    writeScopes: options.writeRoots,
    outputRoot: options.outputRoot,
    taskIndex: readTaskIndexContext(options.layout, options.readRoots),
    taskEvidence: readTaskEvidenceContext(options.layout, options.outputRoot, options.readRoots),
    milestoneCriteria: readMilestoneCriteriaContext(options.layout, options.readRoots),
    milestoneNotes: readMilestoneNotesContext(options.layout, options.readRoots),
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

function readMilestoneNotesContext(layout: ResolvedLayout, readRoots: ReadonlyArray<string>): ReadonlyArray<string> {
  const notes: string[] = [];
  for (const filename of collectMarkdownFiles(readRoots).filter((filePath) => isPathInside(layout.milestonesRoot, filePath)).slice(0, 20)) {
    for (const line of readOptionalFile(filename).split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (/acceptance|验收|criteria/iu.test(trimmed)) notes.push(trimmed.replace(/^[-*#\s]+/u, ""));
      if (notes.length >= 3) return notes;
    }
  }
  return notes;
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

function toSlash(value: string): string {
  return value.split(path.sep).join("/");
}

function scriptRelativeImportPermissions(scriptPath: string, presetRoot: string): ReadonlyArray<string> {
  const source = readFileSync(scriptPath, "utf8");
  const scriptRoot = path.dirname(scriptPath);
  const imports = [...source.matchAll(/^\s*import\s+(?:[^"']+\s+from\s+)?["'](\.{1,2}\/[^"']+)["'];?/gmu)];
  return uniquePermissionPaths(imports.flatMap((match) => {
    const targetPath = path.resolve(scriptRoot, match[1]);
    if (!isPathInside(presetRoot, targetPath)) return [];
    return existsSync(targetPath) ? permissionPathsForScope(targetPath, false) : [];
  }));
}

export function scriptCliResult(options: {
  readonly rootDir: string;
  readonly evidenceDir: string;
  readonly commandName: "preset-run" | "preset-action";
  readonly preset: unknown;
  readonly generated: ReadonlyArray<string>;
  readonly scriptedResult: Record<string, unknown>;
}): CliResult {
  const ok = options.scriptedResult.ok === true;
  const report = options.scriptedResult.report ?? options.scriptedResult;
  return {
    ok,
    command: options.commandName,
    preset: options.preset,
    evidenceBundle: path.relative(options.rootDir, options.evidenceDir).split(path.sep).join("/"),
    generated: options.generated,
    warnings: Array.isArray(options.scriptedResult.warnings) ? options.scriptedResult.warnings : undefined,
    rows: typeof options.scriptedResult.rows === "number" ? options.scriptedResult.rows : undefined,
    report,
    error: ok ? undefined : scriptError(options.scriptedResult.error)
  };
}

function scriptError(value: unknown): CliResult["error"] {
  if (value && typeof value === "object" && "code" in value && "hint" in value) {
    const error = value as { readonly code?: unknown; readonly hint?: unknown };
    if (isCliErrorCode(error.code) && typeof error.hint === "string") {
      return cliError(error.code, error.hint);
    }
  }
  return cliError(CliErrorCode.PresetScriptResultFailed, "Preset script reported a failed result.");
}

function readScriptedResult(outputRoot: string): Record<string, unknown> | undefined {
  const resultPath = path.join(outputRoot, "artifacts", "preset-result.json");
  if (!existsSync(resultPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return {
      ok: false,
      error: cliError(CliErrorCode.PresetScriptResultInvalid, "Preset script wrote invalid artifacts/preset-result.json.")
    };
  }
}
