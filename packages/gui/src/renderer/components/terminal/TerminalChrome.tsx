import type { FormEvent, ReactNode } from "react";
import type { TerminalSessionRow } from "../../../../../daemon/src/gui-s3-control.ts";
import type { TerminalPreferences } from "../../terminal-preferences.ts";
import { t } from "../../i18n/index.tsx";
import { isMacPlatform } from "../../platform.ts";
import { TerminalTaskPicker } from "./TerminalTaskPicker.tsx";

const shellOptions = ["default", "zsh", "bash", "sh", "fish"] as const;

/** 一个终端 tab(= pane group)在 tab 条上的投影。 */
export interface TerminalTabChip {
  readonly groupId: string;
  readonly title: string;
  readonly backend: string;
  readonly paneCount: number;
}
export interface TerminalSpawnDraft {
  readonly name: string;
  readonly cwdScope: "repo-root" | "repo-relative";
  readonly path: string;
  readonly shellProfileId: string;
  readonly taskId: string;
}

/**
 * 终端页的固定 chrome:标题栏、tab 条、高级启动表单(PLT-TerminalWorkspace,W1 从
 * TerminalView 抽出以隔离状态机与展示)。纯展示组件,不持状态、不直接调 terminal-client。
 *
 * tab 条的语义是 W1 的二级模型:一个 chip = 一个 group,chip 上的关闭键关的是整个 group
 * (含其中全部 pane);group 内部的 split/关闭 pane 由 pane 自己的 header 承担。
 */
export function TerminalChrome({
  repoId,
  generation,
  preferences,
  onPreferenceChange,
  chips,
  activeGroupId,
  onSelectGroup,
  onCloseGroup,
  onNewTab,
  sessions,
  openSessionIds,
  onAttachSession,
  spawn,
  onSpawnChange,
  onCreate,
  tasks,
}: {
  readonly repoId: string;
  readonly generation: number | null | undefined;
  readonly preferences: TerminalPreferences;
  readonly onPreferenceChange: (update: Partial<TerminalPreferences>) => void;
  readonly chips: readonly TerminalTabChip[];
  readonly activeGroupId: string | null;
  readonly onSelectGroup: (groupId: string) => void;
  readonly onCloseGroup: (groupId: string) => void;
  readonly onNewTab: () => void;
  readonly sessions: readonly TerminalSessionRow[];
  readonly openSessionIds: readonly string[];
  readonly onAttachSession: (sessionId: string) => void;
  readonly spawn: TerminalSpawnDraft;
  readonly onSpawnChange: (update: Partial<TerminalSpawnDraft>) => void;
  readonly onCreate: (event: FormEvent) => void;
  readonly tasks: readonly { readonly taskId: string; readonly title: string }[];
}) {
  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <strong className="text-[13px]">{t("terminal.view.localTerminal")}</strong>
        <span className="font-mono text-[11px] text-text-faint">
          {t("terminal.view.repoGeneration", {
            repoId,
            generation: generation ?? t("views.settingsView.systemUnknownDash"),
          })}
        </span>
        <span
          className="inline-flex overflow-hidden rounded border border-border-strong"
          aria-label={t("terminal.view.backendForNew")}
        >
          <button
            aria-pressed={preferences.backend === "direct-pty"}
            onClick={() => onPreferenceChange({ backend: "direct-pty" })}
            className={toggleClassName(preferences.backend === "direct-pty")}
          >
            {t("terminal.view.backendDirect")}
          </button>
          <button
            aria-pressed={preferences.backend === "tmux"}
            onClick={() => onPreferenceChange({ backend: "tmux" })}
            className={toggleClassName(preferences.backend === "tmux")}
          >
            {t("terminal.view.backendTmux")}
          </button>
        </span>
        <span className="ml-auto font-mono text-[11px] text-text-faint" title={splitShortcutHint()}>
          {t("terminal.view.shortcut")} · {splitShortcutHint()}
        </span>
      </header>
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
        {chips.map((chip) => (
          <span key={chip.groupId} className={tabClassName(activeGroupId === chip.groupId)}>
            <button
              onClick={() => onSelectGroup(chip.groupId)}
              className="max-w-44 truncate px-2 py-1 text-[11px] text-text"
            >
              {chip.title} <span className="font-mono text-text-faint">· {chip.backend}</span>
              {chip.paneCount > 1 && (
                <span className="font-mono text-text-faint">
                  {" "}
                  · {t("terminal.view.groupPaneCount", { count: chip.paneCount })}
                </span>
              )}
            </button>
            <button
              onClick={() => onCloseGroup(chip.groupId)}
              aria-label={t("terminal.view.closeTabAria", { name: chip.title })}
              title={t("terminal.view.closeDetachTitle")}
              className="border-l border-border px-1.5 text-text-faint hover:bg-surface-overlay"
            >
              ×
            </button>
          </span>
        ))}
        <button
          onClick={onNewTab}
          title={t("terminal.view.quickStartTitle")}
          aria-label={t("terminal.view.newTab")}
          className="shrink-0 rounded border border-accent/60 bg-accent/10 px-2 py-1 text-[13px] text-text"
        >
          +
        </button>
        <select
          aria-label={t("terminal.view.attachExisting")}
          defaultValue=""
          onChange={(event) => {
            if (event.target.value) onAttachSession(event.target.value);
            event.target.value = "";
          }}
          className="control ml-auto shrink-0"
        >
          <option value="">{t("terminal.view.attachSession")}</option>
          {sessions.map((row) => (
            // 同一会话被两个 pane 同时 attach 的语义本波不支持:已在某个 pane 里的会话直接禁选。
            <option
              key={row.sessionId}
              value={row.sessionId}
              disabled={!row.attachable || openSessionIds.includes(row.sessionId)}
            >
              {row.name} · {row.backend} · {row.status}
            </option>
          ))}
        </select>
      </div>
      <details className="border-b border-border px-3 py-1 text-[11px]">
        <summary className="cursor-pointer text-text-muted">{t("terminal.view.advanced")}</summary>
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-2 py-2">
          <Field label={t("terminal.view.name")}>
            <input
              value={spawn.name}
              onChange={(event) => onSpawnChange({ name: event.target.value })}
              className="control w-28"
            />
          </Field>
          <Field label={t("terminal.view.cwd")}>
            <select
              value={spawn.cwdScope}
              onChange={(event) => onSpawnChange({ cwdScope: event.target.value as TerminalSpawnDraft["cwdScope"] })}
              className="control"
            >
              <option value="repo-root">repo-root</option>
              <option value="repo-relative">repo-relative</option>
            </select>
          </Field>
          {spawn.cwdScope === "repo-relative" && (
            <Field label={t("terminal.view.path")}>
              <input
                required
                value={spawn.path}
                onChange={(event) => onSpawnChange({ path: event.target.value })}
                className="control w-36"
              />
            </Field>
          )}
          <Field label={t("terminal.view.shell")}>
            <select
              value={spawn.shellProfileId}
              onChange={(event) => onSpawnChange({ shellProfileId: event.target.value })}
              className="control"
            >
              {shellOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("terminal.view.task")}>
            <TerminalTaskPicker tasks={tasks} value={spawn.taskId} onChange={(taskId) => onSpawnChange({ taskId })} />
          </Field>
          <button className="rounded border border-accent/60 bg-accent/10 px-3 py-1 text-[12px] text-text">
            {t("terminal.view.startCustom")}
          </button>
        </form>
      </details>
    </>
  );
}

function toggleClassName(selected: boolean): string {
  return [
    "px-2 py-1 text-[11px]",
    selected ? "bg-accent text-accent-fg" : "text-text-muted hover:bg-surface-raised",
  ].join(" ");
}
function tabClassName(selected: boolean): string {
  return [
    "inline-flex shrink-0 overflow-hidden rounded border",
    selected ? "border-accent/60 bg-surface-raised" : "border-border",
  ].join(" ");
}
function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="grid gap-0.5 font-mono text-[10px] uppercase tracking-wide text-text-faint">
      {label}
      {children}
    </label>
  );
}

function splitShortcutHint(): string {
  return t(isMacPlatform() ? "terminal.view.splitShortcutMac" : "terminal.view.splitShortcut");
}
