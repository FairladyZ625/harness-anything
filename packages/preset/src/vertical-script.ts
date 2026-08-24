import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import {
  VerticalDefinitionSchema,
  parseVerticalScriptAction,
  parseVerticalScriptPlan,
  resolveHarnessLayout,
  type VerticalDefinition,
  type VerticalScriptActionV1,
  type VerticalScriptPlanV1,
} from "../../kernel/src/index.ts";

export interface PreparedBuiltinVerticalScript {
  readonly action: VerticalScriptActionV1;
  readonly command: string;
  readonly contextArgument: string;
  readonly readRoots: readonly string[];
  readonly writePatterns: readonly string[];
  readonly producePatterns: readonly string[];
}
export class BuiltinVerticalScriptError extends Error {
  readonly code: "script_not_found" | "script_command_invalid" | "script_scope_violation" | "task_not_found";
  constructor(code: BuiltinVerticalScriptError["code"], message: string) {
    super(message);
    this.name = "BuiltinVerticalScriptError";
    this.code = code;
  }
}

const assetsRoot = fileURLToPath(new URL("../assets/software-coding", import.meta.url));

export function prepareBuiltinVerticalScriptExecution(input: {
  readonly rootDir: string;
  readonly action: unknown;
  readonly commitSha: string;
}): PreparedBuiltinVerticalScript {
  const action = parseVerticalScriptAction(input.action),
    layout = resolveHarnessLayout(input.rootDir),
    vertical = readVertical(),
    declaration = vertical.scripts.find(({ id }) => id === action.scriptId);
  if (!declaration)
    throw new BuiltinVerticalScriptError(
      "script_not_found",
      `Script ${action.scriptId} is not declared by software/coding.`,
    );
  const command = path.resolve(assetsRoot, declaration.command);
  if (!isWithinVerticalBoundary(assetsRoot, command) || !regularContainedFile(command))
    throw new BuiltinVerticalScriptError(
      "script_command_invalid",
      `Declared script command is unavailable: ${declaration.command}.`,
    );
  let outputRoot = layout.contextRoot;
  if (action.taskId !== null) {
    outputRoot = layout.taskPackagePath(action.taskId as Parameters<typeof layout.taskPackagePath>[0]);
    if (
      !existsSync(path.join(outputRoot, "INDEX.md")) ||
      !lstatSync(outputRoot).isDirectory() ||
      lstatSync(outputRoot).isSymbolicLink() ||
      !isWithinVerticalBoundary(realpathSync(layout.authoredRoot), realpathSync(outputRoot))
    )
      throw new BuiltinVerticalScriptError("task_not_found", `Task ${action.taskId} is unavailable.`);
  }
  const paths = {
      rootDir: layout.rootDir,
      authoredRoot: layout.authoredRoot,
      governanceRoot: layout.governanceRoot,
      standardsRoot: layout.standardsRoot,
      contextRoot: layout.contextRoot,
      tasksRoot: layout.tasksRoot,
      decisionsRoot: layout.decisionsRoot,
      sessionsRoot: layout.sessionsRoot,
      adrRoot: layout.adrRoot,
      milestonesRoot: layout.milestonesRoot,
      generatedRoot: layout.generatedRoot,
      localRoot: layout.localRoot,
    },
    tokens = {
      ...Object.fromEntries(Object.entries(paths).map(([key, value]) => [`paths.${key}`, value])),
      outputRoot,
    };
  const expand = (value: string) =>
      value.replace(/\{\{([^}]+)\}\}/gu, (_match, key: string) => tokens[key as keyof typeof tokens] ?? ""),
    writePatterns = declaration.writes.map(expand).map((value) => authoredPattern(layout.authoredRoot, value)),
    producePatterns = declaration.metadata.produces
      .map(expand)
      .map((value) => authoredPattern(layout.authoredRoot, value));
  const readRoots = [assetsRoot, ...[...declaration.reads.map(expand), ...declaration.writes.map(expand)].map(globBase)]
    .map((value) => path.resolve(value))
    .filter((value, index, all) => all.indexOf(value) === index);
  const context = {
    schema: "vertical-script-context/v1",
    scriptId: action.scriptId,
    taskId: action.taskId,
    dryRun: action.dryRun,
    inputs: { ...declaration.inputs, ...action.inputs },
    paths,
    outputRoot,
    repository: { commitSha: input.commitSha },
  };
  return {
    action,
    command,
    contextArgument: Buffer.from(JSON.stringify(context)).toString("base64url"),
    readRoots,
    writePatterns,
    producePatterns,
  };
}

export function acceptBuiltinVerticalScriptPlan(
  prepared: PreparedBuiltinVerticalScript,
  frame: string,
): VerticalScriptPlanV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(frame);
  } catch {
    throw new BuiltinVerticalScriptError("script_scope_violation", "Script output is not JSON.");
  }
  const plan = parseVerticalScriptPlan(raw);
  if (
    plan.scriptId !== prepared.action.scriptId ||
    plan.changes.some(
      ({ path: target }) =>
        !prepared.writePatterns.some((pattern) => matches(pattern, target)) ||
        !prepared.producePatterns.some((pattern) => matches(pattern, target)),
    )
  )
    throw new BuiltinVerticalScriptError(
      "script_scope_violation",
      "Script plan exceeds its declared writes or produces whitelist.",
    );
  return plan;
}

function readVertical(): VerticalDefinition {
  return Schema.decodeUnknownSync(VerticalDefinitionSchema)(
    JSON.parse(readFileSync(path.join(assetsRoot, "vertical.json"), "utf8")),
  );
}
function regularContainedFile(target: string): boolean {
  try {
    return lstatSync(target).isFile() && isWithinVerticalBoundary(realpathSync(assetsRoot), realpathSync(target));
  } catch {
    return false;
  }
}
function isWithinVerticalBoundary(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function globBase(value: string): string {
  const index = value.search(/[?*[]/u);
  return index < 0 ? path.dirname(value) : value.slice(0, index).replace(/[\\/]$/u, "");
}
function authoredPattern(authoredRoot: string, target: string): string {
  const base = globBase(target);
  if (!isWithinVerticalBoundary(authoredRoot, base))
    throw new BuiltinVerticalScriptError(
      "script_scope_violation",
      `Declared write is outside the authored root: ${target}.`,
    );
  return path.relative(authoredRoot, target).split(path.sep).join("/");
}
function matches(pattern: string, target: string): boolean {
  if (pattern.endsWith("/**")) return target.startsWith(pattern.slice(0, -2));
  if (pattern.endsWith("/*.md")) {
    const rest = target.slice(pattern.length - 4);
    return target.startsWith(pattern.slice(0, -4)) && !rest.includes("/") && rest.endsWith(".md");
  }
  return pattern === target;
}
