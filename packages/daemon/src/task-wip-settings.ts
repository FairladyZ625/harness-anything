import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_TASK_WIP_LIMIT, parseTaskWipLimit, resolveHarnessLayout, settingBlockValue } from "../../kernel/src/index.ts";

export const TASK_WIP_LIMIT_ENV = "HARNESS_TASK_WIP_LIMIT";
export const TASK_WIP_LIMIT_SETTING = "settings.tasks.wipLimit";

export interface TaskWipLimitSetting { readonly limit: number; readonly label: string }

/** Effective WIP limit: environment override, then harness.yaml settings.tasks.wipLimit, then the default. Invalid values fail closed. */
export function resolveTaskWipLimit(rootDir: string, env: NodeJS.ProcessEnv = process.env): TaskWipLimitSetting {
  const fromEnv = env[TASK_WIP_LIMIT_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    const limit = parseTaskWipLimit(fromEnv);
    if (limit === undefined) throw taskWipLimitError(`${TASK_WIP_LIMIT_ENV} must be a positive integer.`);
    return { limit, label: TASK_WIP_LIMIT_ENV };
  }
  const configPath = path.join(resolveHarnessLayout(rootDir).authoredRoot, "harness.yaml");
  if (existsSync(configPath)) {
    const raw = settingBlockValue(readFileSync(configPath, "utf8"), "tasks", "wipLimit");
    if (raw !== undefined) {
      const limit = parseTaskWipLimit(raw);
      if (limit === undefined) throw taskWipLimitError(`${TASK_WIP_LIMIT_SETTING} must be a positive integer.`);
      return { limit, label: TASK_WIP_LIMIT_SETTING };
    }
  }
  return { limit: DEFAULT_TASK_WIP_LIMIT, label: TASK_WIP_LIMIT_SETTING };
}

function taskWipLimitError(message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code: "task_wip_limit_invalid" });
}
