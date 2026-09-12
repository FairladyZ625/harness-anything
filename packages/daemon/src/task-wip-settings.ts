import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_TASK_ROOT_THRESHOLD,
  DEFAULT_TASK_WIP_LIMIT,
  parseTaskWipLimit,
  resolveHarnessLayout,
  settingBlockValue,
} from "../../kernel/src/index.ts";

export const TASK_WIP_LIMIT_ENV = "HARNESS_TASK_WIP_LIMIT";
export const TASK_WIP_LIMIT_SETTING = "settings.tasks.wipLimit";
export const TASK_ROOT_THRESHOLD_ENV = "HARNESS_TASK_ROOT_THRESHOLD";
export const TASK_ROOT_THRESHOLD_SETTING = "settings.tasks.rootThreshold";

export interface TaskWipLimitSetting {
  readonly limit: number;
  readonly label: string;
}
export interface TaskRootThresholdSetting {
  readonly threshold: number;
  readonly label: string;
}

interface CachedTaskSettings {
  readonly mtimeMs: number;
  readonly wipLimit: string | undefined;
  readonly rootThreshold: string | undefined;
}

const taskSettingsCache = new Map<string, CachedTaskSettings>();

/** Effective WIP limit: environment override, then harness.yaml settings.tasks.wipLimit, then the default. Invalid values fail closed. */
export function resolveTaskWipLimit(rootDir: string, env: NodeJS.ProcessEnv = process.env): TaskWipLimitSetting {
  const fromEnv = env[TASK_WIP_LIMIT_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    const limit = parseTaskWipLimit(fromEnv);
    if (limit === undefined) throw taskWipLimitError(`${TASK_WIP_LIMIT_ENV} must be a positive integer.`);
    return { limit, label: TASK_WIP_LIMIT_ENV };
  }
  const raw = readTaskSettings(rootDir).wipLimit;
  if (raw !== undefined) {
    const limit = parseTaskWipLimit(raw);
    if (limit === undefined) throw taskWipLimitError(`${TASK_WIP_LIMIT_SETTING} must be a positive integer.`);
    return { limit, label: TASK_WIP_LIMIT_SETTING };
  }
  return { limit: DEFAULT_TASK_WIP_LIMIT, label: TASK_WIP_LIMIT_SETTING };
}

function taskWipLimitError(message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code: "task_wip_limit_invalid" });
}

/** Effective root threshold: environment override, then harness.yaml settings.tasks.rootThreshold, then the default. */
export function resolveTaskRootThreshold(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): TaskRootThresholdSetting {
  const fromEnv = env[TASK_ROOT_THRESHOLD_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    const threshold = parseTaskWipLimit(fromEnv);
    if (threshold === undefined) throw taskRootThresholdError(`${TASK_ROOT_THRESHOLD_ENV} must be a positive integer.`);
    return { threshold, label: TASK_ROOT_THRESHOLD_ENV };
  }
  const raw = readTaskSettings(rootDir).rootThreshold;
  if (raw !== undefined) {
    const threshold = parseTaskWipLimit(raw);
    if (threshold === undefined)
      throw taskRootThresholdError(`${TASK_ROOT_THRESHOLD_SETTING} must be a positive integer.`);
    return { threshold, label: TASK_ROOT_THRESHOLD_SETTING };
  }
  return { threshold: DEFAULT_TASK_ROOT_THRESHOLD, label: TASK_ROOT_THRESHOLD_SETTING };
}

function readTaskSettings(rootDir: string): CachedTaskSettings {
  const configPath = path.join(resolveHarnessLayout(rootDir).authoredRoot, "harness.yaml");
  if (!existsSync(configPath)) {
    taskSettingsCache.delete(configPath);
    return { mtimeMs: 0, wipLimit: undefined, rootThreshold: undefined };
  }
  const mtimeMs = statSync(configPath).mtimeMs,
    cached = taskSettingsCache.get(configPath);
  if (cached?.mtimeMs === mtimeMs) return cached;
  const body = readFileSync(configPath, "utf8"),
    settings = {
      mtimeMs,
      wipLimit: settingBlockValue(body, "tasks", "wipLimit"),
      rootThreshold: settingBlockValue(body, "tasks", "rootThreshold"),
    };
  taskSettingsCache.set(configPath, settings);
  return settings;
}

function taskRootThresholdError(message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code: "task_root_threshold_invalid" });
}
