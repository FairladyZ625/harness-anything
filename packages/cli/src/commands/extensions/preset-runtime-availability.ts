import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  evaluatePresetRuntimeAvailability,
  parseTaskContractSnapshot
} from "../../../../application/src/index.ts";
import {
  listTaskIndexPaths,
  readFrontmatter,
  readScalar,
  type HarnessLayoutInput,
  type PresetManifest
} from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";

export function presetRuntimeUnavailableResult(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly commandName: "preset-action" | "preset-run";
  readonly presetId: string;
  readonly taskId: string;
  readonly installedPreset?: PresetManifest;
}): CliResult | undefined {
  const contractPath = locateTaskContractPath(input.rootInput, input.taskId);
  if (!contractPath) return undefined;
  if (!existsSync(contractPath)) return undefined;
  let snapshot;
  try {
    snapshot = parseTaskContractSnapshot(readFileSync(contractPath, "utf8"));
  } catch {
    return undefined;
  }
  const availability = evaluatePresetRuntimeAvailability({
    requestedPresetId: input.presetId,
    snapshot,
    ...(input.installedPreset ? { installedPreset: input.installedPreset } : {})
  });
  if (availability.status !== "unavailable") return undefined;
  const identity = `${availability.preset.id}@${availability.preset.version}`;
  return {
    ok: false,
    command: input.commandName,
    taskId: input.taskId,
    preset: availability.preset,
    error: cliError(
      CliErrorCode.PresetRuntimeUnavailable,
      `Preset runtime unavailable for ${identity}; the Task still retains its historical contract snapshot.`
    )
  };
}

function locateTaskContractPath(rootInput: HarnessLayoutInput, taskId: string): string | undefined {
  for (const indexPath of listTaskIndexPaths(rootInput)) {
    const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8")) ?? "";
    if (readScalar(frontmatter, "task_id") === taskId) {
      return path.join(path.dirname(indexPath), "task-contract.json");
    }
  }
  return undefined;
}
