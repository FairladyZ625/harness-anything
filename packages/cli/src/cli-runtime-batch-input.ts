import { unknownFieldViolation } from "../../daemon/src/protocol/json-rpc-types.ts";
import {
  runtimeBatchDefaultConcurrency,
  runtimeBatchMaxConcurrency,
} from "./cli-types.ts";
import type {
  RuntimeBatchDeclaration,
  RuntimeBatchEntry,
} from "./cli-types.ts";
import {
  runtimeBatchDeclarationFields,
  runtimeRunEfforts,
} from "./cli/thin-command.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

export function readRuntimeBatch(
  command: ThinCommand,
): RuntimeBatchDeclaration {
  let value: unknown;
  try {
    value = JSON.parse(
      readFileSync(
        path.resolve(command.rootDir, String(command.action.batchFile)),
        "utf8",
      ),
    );
  } catch (error) {
    throw new Error(
      `Could not read batch declaration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseRuntimeBatchDeclaration(value, "Batch");
}

export function parseRuntimeBatchDeclaration(
  value: unknown,
  label: string,
): RuntimeBatchDeclaration {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} declaration must be a JSON object.`);
  const record = value as Record<string, unknown>,
    allowed = ["schema", "maxConcurrency", "dispatches"],
    unknownField = unknownFieldViolation(record, allowed);
  if (unknownField)
    throw new Error(`${label} declaration contains an ${unknownField}`);
  if (record.schema !== "runtime-batch/v1")
    throw new Error(`${label} declaration schema must be runtime-batch/v1.`);
  const maxConcurrency =
    record.maxConcurrency === undefined
      ? runtimeBatchDefaultConcurrency
      : record.maxConcurrency;
  if (
    !Number.isSafeInteger(maxConcurrency) ||
    Number(maxConcurrency) < 1 ||
    Number(maxConcurrency) > runtimeBatchMaxConcurrency
  )
    throw new Error(
      `${label} maxConcurrency must be an integer from 1 to ${runtimeBatchMaxConcurrency}.`,
    );
  if (!Array.isArray(record.dispatches) || record.dispatches.length === 0)
    throw new Error(
      `${label} declaration dispatches must be a non-empty array.`,
    );
  return {
    maxConcurrency: Number(maxConcurrency),
    dispatches: record.dispatches.map((entry, index) =>
      parseRuntimeBatchEntry(entry, index),
    ),
  };
}

export function parseRuntimeBatchEntry(
  value: unknown,
  index: number,
): RuntimeBatchEntry {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Batch dispatch ${index} must be an object.`);
  const record = value as Record<string, unknown>,
    allowed = runtimeBatchDeclarationFields(),
    unknownField = unknownFieldViolation(record, allowed);
  if (unknownField)
    throw new Error(`Batch dispatch ${index} contains an ${unknownField}`);
  const text = (field: string): string | undefined => {
    const item = record[field];
    if (item === undefined) return undefined;
    if (typeof item !== "string" || item.trim().length === 0)
      throw new Error(
        `Batch dispatch ${index} field ${field} must be a non-empty string.`,
      );
    return item;
  };
  const instance = text("instance"),
    prompt = text("prompt"),
    promptFile = text("prompt-file"),
    agent = text("agent"),
    to = text("to"),
    model = text("model"),
    effort = text("effort"),
    permissionMode = text("permission-mode"),
    cwd = text("cwd"),
    task = text("task");
  if (!instance) throw new Error(`Batch dispatch ${index} requires instance.`);
  if (Boolean(prompt) === Boolean(promptFile))
    throw new Error(
      `Batch dispatch ${index} requires exactly one of prompt or prompt-file.`,
    );
  if (to && !agent)
    throw new Error(`Batch dispatch ${index} uses to without agent.`);
  if (effort && !runtimeRunEfforts().includes(effort))
    throw new Error(
      `Batch dispatch ${index} effort must be minimal, low, medium, high, or xhigh.`,
    );
  if (
    permissionMode &&
    !["bypass", "workspace-write", "read-only"].includes(permissionMode)
  )
    throw new Error(
      `Batch dispatch ${index} permission-mode must be bypass, workspace-write, or read-only.`,
    );
  return {
    instance,
    ...(agent ? { agent } : {}),
    ...(to ? { to } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(prompt ? { prompt } : {}),
    ...(promptFile ? { promptFile } : {}),
    ...(cwd ? { cwd } : {}),
    ...(task ? { task } : {}),
  };
}
