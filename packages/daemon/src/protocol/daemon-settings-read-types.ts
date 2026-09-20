import { repositorySettingsActionValues, type SettingsV1 } from "../../../kernel/src/index.ts";

/** `repo.settings.read` 返回的最近一条 `settings_changed` 归因:`actor` 是紧凑的
 * `<executor-kind>:<executor-id>` 或 `person:<personId>`;`revision` 是该事件的 workspace 修订。 */
export interface DaemonSettingsLastChange {
  readonly occurredAt: string;
  readonly actor: string;
  readonly revision: number;
}

/** `repo.settings.read` 的结果:`settings` 原样返回(含 locale 本地偏好),`values` 是 kernel
 * `repositorySettingsActionValues` 的扁平动作值面——派生设置表单据此回填,无需手写嵌套→扁平映射。
 * `lastChanged` 携带最近一条 settings_changed 事件的归因;仓库尚无设置变更事件时为 "initial"。 */
export interface DaemonSettingsRead {
  readonly schema: "daemon.settings-read/v1";
  readonly ok: true;
  readonly settings: SettingsV1;
  readonly values: ReturnType<typeof repositorySettingsActionValues>;
  readonly lastChanged: DaemonSettingsLastChange | "initial";
}

/** `repo.settings.read` 的唯一构造口:settings 原样返回(含 locale 本地偏好),
 * values 为 kernel 拍平的动作值面(键 = 契约字段,内部归一化仓库视图)。 */
export function daemonSettingsRead(
  settings: SettingsV1,
  lastChanged: DaemonSettingsLastChange | "initial",
): DaemonSettingsRead {
  return {
    schema: "daemon.settings-read/v1",
    ok: true,
    settings,
    values: repositorySettingsActionValues(settings),
    lastChanged,
  };
}
