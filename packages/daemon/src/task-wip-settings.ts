import {
  INITIAL_SETTINGS_V1,
  parseTaskWipLimit,
  repositorySettings,
  SETTINGS_ID,
  type RepositorySettingsV1,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";

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
type TaskSettings = {
  readonly tasks: {
    readonly wipLimit: number;
    readonly rootThreshold: number;
  };
};
/** Effective WIP limit: environment override, then the canonical Settings entity. Invalid overrides fail closed. */
export function resolveTaskWipLimit(settings: TaskSettings, env: NodeJS.ProcessEnv = process.env): TaskWipLimitSetting {
  const fromEnv = env[TASK_WIP_LIMIT_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    const limit = parseTaskWipLimit(fromEnv);
    if (limit === undefined) throw taskWipLimitError(`${TASK_WIP_LIMIT_ENV} must be a positive integer.`);
    return { limit, label: TASK_WIP_LIMIT_ENV };
  }
  return { limit: settings.tasks.wipLimit, label: TASK_WIP_LIMIT_SETTING };
}

function taskWipLimitError(message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code: "task_wip_limit_invalid" });
}

/** Effective root threshold: environment override, then the canonical Settings entity. Invalid overrides fail closed. */
export function resolveTaskRootThreshold(
  settings: TaskSettings,
  env: NodeJS.ProcessEnv = process.env,
): TaskRootThresholdSetting {
  const fromEnv = env[TASK_ROOT_THRESHOLD_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    const threshold = parseTaskWipLimit(fromEnv);
    if (threshold === undefined) throw taskRootThresholdError(`${TASK_ROOT_THRESHOLD_ENV} must be a positive integer.`);
    return { threshold, label: TASK_ROOT_THRESHOLD_ENV };
  }
  return { threshold: settings.tasks.rootThreshold, label: TASK_ROOT_THRESHOLD_SETTING };
}

export function projectedTaskSettings(projection: TaskProjectionQueries): RepositorySettingsV1 & TaskSettings {
  const projected = projection.getEntity("settings", SETTINGS_ID)?.value;
  return repositorySettings(
    projected === undefined ? INITIAL_SETTINGS_V1 : (projected as unknown as RepositorySettingsV1),
  ) as RepositorySettingsV1 & TaskSettings;
}

function taskRootThresholdError(message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code: "task_root_threshold_invalid" });
}
