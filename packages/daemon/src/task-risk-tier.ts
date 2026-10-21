import { readFileSync } from "node:fs";
import path from "node:path";
import type { TaskMetadataV1, TaskRiskTierAssessmentV1 } from "@harness-anything/kernel";
import { runProcessExitAsync } from "./process-port.ts";
import { reviewLanePaths, reviewPathLanes } from "./review-path-lanes.ts";

export type RiskTier = NonNullable<TaskMetadataV1["riskTier"]>;
export const taskRiskManifestPath = "tools/task-risk-manifest.json";

export interface TaskRiskTierScript {
  readonly id: string;
  readonly command: readonly string[];
}

export interface TaskRiskManifest {
  readonly scripts: readonly TaskRiskTierScript[];
  readonly lowGuiAcceptance: boolean;
}

export interface TaskRiskTierScriptInput {
  readonly schema: "task-risk-tier-input/v1";
  readonly task: {
    readonly taskId: string;
    readonly declaredTier: RiskTier;
    readonly verticalId: string;
    readonly presetId: string;
    readonly workKind: TaskMetadataV1["workKind"];
  };
  readonly delivery: {
    readonly baseSha: string | null;
    readonly headSha: string | null;
    readonly files: readonly {
      readonly path: string;
      readonly status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";
      readonly additions: number;
      readonly deletions: number;
      readonly binary: boolean;
      readonly patch: string;
    }[];
  };
  readonly matchedPathReviewers: readonly { readonly agentId: string; readonly paths: readonly string[] }[];
}

interface TaskRiskTierScriptResult {
  readonly minimumTier: RiskTier;
  readonly reasons: readonly string[];
}

export class TaskRiskTierConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRiskTierConfigurationError";
  }
}

export function readTaskRiskManifest(rootDir: string): TaskRiskManifest {
  const manifestPath = path.join(rootDir, taskRiskManifestPath);
  let body: string;
  try {
    body = readFileSync(manifestPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { scripts: [], lowGuiAcceptance: true };
    throw new TaskRiskTierConfigurationError(`Cannot read ${taskRiskManifestPath}: ${errorMessage(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch (error) {
    throw new TaskRiskTierConfigurationError(`${taskRiskManifestPath} is not valid JSON: ${errorMessage(error)}`);
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schema", "scripts", "lowGuiAcceptance"]) ||
    value.schema !== "task-risk-manifest/v1"
  )
    throw new TaskRiskTierConfigurationError(`${taskRiskManifestPath} must use task-risk-manifest/v1.`);
  if (value.lowGuiAcceptance !== undefined && typeof value.lowGuiAcceptance !== "boolean")
    throw new TaskRiskTierConfigurationError(`${taskRiskManifestPath}.lowGuiAcceptance must be boolean.`);
  if (!Array.isArray(value.scripts))
    throw new TaskRiskTierConfigurationError(`${taskRiskManifestPath}.scripts must be an array.`);
  const scripts: TaskRiskTierScript[] = value.scripts.map((script, index) => {
    if (
      !isRecord(script) ||
      !hasOnlyKeys(script, ["id", "command"]) ||
      !isNonEmptyString(script.id) ||
      !Array.isArray(script.command) ||
      script.command.length === 0 ||
      !script.command.every(isNonEmptyString)
    )
      throw new TaskRiskTierConfigurationError(
        `${taskRiskManifestPath}.scripts[${String(index)}] requires a unique id and a non-empty command array.`,
      );
    return { id: script.id, command: script.command };
  });
  if (new Set(scripts.map(({ id }) => id)).size !== scripts.length)
    throw new TaskRiskTierConfigurationError(`${taskRiskManifestPath} script ids must be unique.`);
  return { scripts, lowGuiAcceptance: value.lowGuiAcceptance ?? true };
}

export async function assessTaskRiskTier(input: {
  readonly rootDir: string;
  readonly task: TaskRiskTierScriptInput["task"];
  readonly delivery: TaskRiskTierScriptInput["delivery"];
  readonly pathReviewers?: readonly string[];
  readonly matchedPathReviewers: TaskRiskTierScriptInput["matchedPathReviewers"];
  readonly previousEffectiveTier?: RiskTier;
}): Promise<TaskRiskTierAssessmentV1> {
  const manifest = readTaskRiskManifest(input.rootDir),
    matchedPathReviewers = input.pathReviewers
      ? [
          ...reviewLanePaths(
            input.delivery.files.map(({ path: filePath }) => filePath),
            reviewPathLanes(input.pathReviewers),
          ),
        ].map(([agentId, paths]) => ({ agentId, paths }))
      : input.matchedPathReviewers,
    scriptInput: TaskRiskTierScriptInput = {
      schema: "task-risk-tier-input/v1",
      task: input.task,
      delivery: input.delivery,
      matchedPathReviewers,
    },
    tiers: RiskTier[] = [
      input.task.declaredTier,
      ...(input.previousEffectiveTier ? [input.previousEffectiveTier] : []),
    ],
    reasons: string[] = [];
  for (const lane of matchedPathReviewers)
    reasons.push(`matched review.pathReviewers lane ${lane.agentId}: ${lane.paths.join(", ")}`);
  for (const script of manifest.scripts) {
    let processResult: Awaited<ReturnType<typeof runProcessExitAsync>>;
    try {
      processResult = await runProcessExitAsync(
        script.command[0]!,
        script.command.slice(1),
        input.rootDir,
        undefined,
        JSON.stringify(scriptInput),
        undefined,
        { timeoutMs: 30_000 },
      );
    } catch (error) {
      throw new TaskRiskTierConfigurationError(`Task risk script ${script.id} failed: ${processErrorOutput(error)}`);
    }
    if (processResult.exitCode !== 0)
      throw new TaskRiskTierConfigurationError(
        `Task risk script ${script.id} exited ${String(processResult.exitCode)}: ` +
          (processResult.stderr.trim() || processResult.stdout.trim() || "no error output"),
      );
    const result = parseScriptResult(script.id, processResult.stdout);
    tiers.push(result.minimumTier);
    reasons.push(...result.reasons.map((reason) => `${script.id}: ${reason}`));
  }
  const effectiveTier = tiers.reduce(maxTier);
  if (!reasons.length)
    reasons.push(manifest.scripts.length ? `declared tier ${effectiveTier}` : "no repository risk scripts configured");
  return {
    schema: "task-risk-tier-assessment/v1",
    declaredTier: input.task.declaredTier,
    effectiveTier,
    deliveryBaseSha: input.delivery.baseSha,
    deliveryHeadSha: input.delivery.headSha,
    matchedPathReviewers,
    reasons,
    guiAcceptanceRequired:
      manifest.lowGuiAcceptance &&
      input.task.declaredTier === "low" &&
      input.delivery.files.some(({ path: filePath }) => filePath.startsWith("packages/gui/")),
  };
}

function parseScriptResult(scriptId: string, stdout: string): TaskRiskTierScriptResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new TaskRiskTierConfigurationError(
      `Task risk script ${scriptId} returned invalid JSON: ${errorMessage(error)}; output: ${stdout.trim() || "<empty>"}`,
    );
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schema", "minimumTier", "reasons"]) ||
    value.schema !== "task-risk-tier-result/v1" ||
    !isRiskTier(value.minimumTier) ||
    !Array.isArray(value.reasons) ||
    !value.reasons.every(isNonEmptyString)
  )
    throw new TaskRiskTierConfigurationError(
      `Task risk script ${scriptId} returned a malformed task-risk-tier-result/v1 document.`,
    );
  return { minimumTier: value.minimumTier, reasons: value.reasons };
}

function processErrorOutput(error: unknown): string {
  if (isRecord(error)) {
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "",
      stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    if (stderr || stdout) return stderr || stdout;
  }
  return errorMessage(error);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRiskTier(value: unknown): value is RiskTier {
  return value === "low" || value === "medium" || value === "high";
}

function maxTier(left: RiskTier, right: RiskTier): RiskTier {
  const rank: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };
  return rank[left] >= rank[right] ? left : right;
}
