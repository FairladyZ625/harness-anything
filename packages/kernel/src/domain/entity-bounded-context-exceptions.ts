/**
 * 动作驻留的例外表:这些动作在 RepoCell 台账里**没有**规范事件,因为它们作用的状态
 * 本来就住在别的边界内(daemon 用户根、preset 库、终端宿主进程)。表是显式的、有理由的,
 * 由 `explainEntityKindContract` 原样投影出去——让「没有 canonical event」成为可被读到的
 * 声明,而不是散在各处的隐性缺口。
 */
export interface BoundedContextActionException {
  readonly actions: readonly string[];
  readonly boundedContext: "preset-library" | "daemon-user-root" | "terminal-host";
  readonly residency: "runtime-local";
  readonly reason: string;
}

export const boundedContextExceptions: readonly BoundedContextActionException[] = Object.freeze([
  Object.freeze({
    actions: Object.freeze(["settings-update"]),
    boundedContext: "daemon-user-root" as const,
    residency: "runtime-local" as const,
    reason: "The locale field is a daemon-local preference and never appears in settings-event/v1.",
  }),
  Object.freeze({
    actions: Object.freeze(["preset-install", "preset-seed", "preset-uninstall"]),
    boundedContext: "preset-library" as const,
    residency: "runtime-local" as const,
    reason: "Preset library installation mutates the selected workspace library and has no canonical repository event.",
  }),
  Object.freeze({
    actions: Object.freeze([
      "daemon.runtimeInstance.create",
      "daemon.runtimeInstance.list",
      "daemon.runtimeInstance.show",
      "daemon.runtimeInstance.update",
      "daemon.runtimeInstance.delete",
    ]),
    boundedContext: "daemon-user-root" as const,
    residency: "runtime-local" as const,
    reason: "Runtime instance configuration belongs to the daemon user's host registry, outside a RepoCell ledger.",
  }),
  Object.freeze({
    actions: Object.freeze([
      "repo.terminal.spawn",
      "repo.terminal.input",
      "repo.terminal.resize",
      "repo.terminal.detach",
      "repo.terminal.terminate",
      "repo.terminal.attach",
    ]),
    boundedContext: "terminal-host" as const,
    residency: "runtime-local" as const,
    reason: "Terminal process state is ephemeral host state and never claims canonical repository settlement.",
  }),
]);
