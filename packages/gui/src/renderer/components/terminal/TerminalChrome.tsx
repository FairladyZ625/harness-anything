import { useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Gear, Plus, PlugsConnected } from "@phosphor-icons/react";
import type { TerminalSessionRow } from "../../../../../daemon/src/gui-s3-control.ts";
import type { TerminalPreferences } from "../../terminal-preferences.ts";
import { t } from "../../i18n/index.tsx";
import { isMacPlatform } from "../../platform.ts";
import { Popover } from "../Popover.tsx";
import { TerminalTaskTreePicker } from "./TerminalTaskTreePicker.tsx";
import type { TaskTreeNode } from "./task-tree.ts";

const shellOptions = ["default", "zsh", "bash", "sh", "fish"] as const;
const sidebarWidthKey = "harness:gui:terminal-sidebar-width";
const sidebarWidthRange = { min: 160, max: 480, initial: 224 } as const;

function readSidebarWidth(): number {
  const stored = Number(localStorage.getItem(sidebarWidthKey));
  return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : sidebarWidthRange.initial;
}
function clampWidth(width: number): number {
  return Math.min(sidebarWidthRange.max, Math.max(sidebarWidthRange.min, Math.round(width)));
}

/** 一个终端 tab(= pane group)在侧栏上的投影。 */
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
 * 终端页的左侧栏(PLT-TerminalWorkspace):顶部一排小功能区(新建 / 附加已有会话 / 启动
 * 选项),下面是纵向的 tab 列表,底部是 repo · generation。启动选项(后端、名称、cwd、
 * shell、task 绑定)与附加列表都收进气泡弹窗,不再常驻占高。右缘可拖拽调宽(localStorage)。
 * 除侧栏宽度外不持状态。
 *
 * tab 的语义仍是二级模型:一行 = 一个 group,行上的关闭键关的是整个 group(含全部 pane);
 * group 内部的 split/关闭 pane 由 pane 自己的 header 承担。
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
  readonly tasks: readonly TaskTreeNode[];
}) {
  const attachable = sessions.filter((row) => row.attachable && !openSessionIds.includes(row.sessionId));
  const [width, setWidth] = useState(readSidebarWidth);
  // 右缘拖拽调宽:按下后在 window 上跟指针(越过 xterm/iframe 也不丢),松手落 localStorage。
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const origin = event.clientX,
      base = width;
    const onMove = (move: PointerEvent) => setWidth(clampWidth(base + move.clientX - origin));
    const onUp = (up: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      localStorage.setItem(sidebarWidthKey, String(clampWidth(base + up.clientX - origin)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return (
    <aside
      data-testid="terminal-sidebar"
      style={{ width }}
      className="relative flex shrink-0 flex-col overflow-hidden border-r border-border bg-surface"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("terminal.view.sidebarResize")}
        data-testid="terminal-sidebar-resize"
        onPointerDown={startResize}
        className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize hover:bg-accent/40"
      />
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <button
          onClick={onNewTab}
          title={t("terminal.view.quickStartTitle")}
          aria-label={t("terminal.view.newTab")}
          className={
            "grid size-7 place-items-center rounded border border-accent/60 bg-accent/10 text-text " +
            "hover:bg-accent/20"
          }
        >
          <Plus weight="bold" />
        </button>
        <Popover label={t("terminal.view.attachExisting")} trigger={<PlugsConnected />} testId="terminal-attach">
          {(close) => (
            <div className="flex flex-col gap-0.5" data-testid="terminal-attach-list">
              <p className="px-1 pb-1 text-[11px] text-text-faint">{t("terminal.view.attachSession")}</p>
              {attachable.length === 0 && <p className="px-1 text-text-faint">{t("terminal.view.noAttachable")}</p>}
              {sessions
                .filter((row) => row.attachable)
                .map((row) => (
                  // 只列可附加的;同一会话被两个 pane 同时 attach 本波不支持,已在 pane 里的禁选。
                  <button
                    key={row.sessionId}
                    type="button"
                    data-session-id={row.sessionId}
                    disabled={!row.attachable || openSessionIds.includes(row.sessionId)}
                    onClick={() => {
                      onAttachSession(row.sessionId);
                      close();
                    }}
                    className={
                      "flex w-full flex-col items-start rounded px-2 py-1 text-left text-text " +
                      "hover:bg-surface disabled:cursor-not-allowed disabled:text-text-faint " +
                      "disabled:hover:bg-transparent"
                    }
                  >
                    <span className="w-full truncate">{row.name}</span>
                    <span className="font-mono text-[10px] text-text-faint">
                      {row.backend} · {row.status}
                    </span>
                  </button>
                ))}
            </div>
          )}
        </Popover>
        <span className="ml-auto" />
        <Popover
          label={t("terminal.view.launchOptions")}
          trigger={<Gear />}
          panelClassName="w-[22rem]"
          testId="terminal-launch-options"
        >
          {() => (
            <LaunchOptions
              preferences={preferences}
              onPreferenceChange={onPreferenceChange}
              spawn={spawn}
              onSpawnChange={onSpawnChange}
              onCreate={onCreate}
              tasks={tasks}
            />
          )}
        </Popover>
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1"
        role="tablist"
        aria-orientation="vertical"
      >
        {chips.map((chip) => (
          <div key={chip.groupId} className={tabClassName(activeGroupId === chip.groupId)}>
            <button
              role="tab"
              aria-selected={activeGroupId === chip.groupId}
              onClick={() => onSelectGroup(chip.groupId)}
              className="flex min-w-0 flex-1 flex-col items-start px-2 py-1 text-left"
            >
              <span className="w-full truncate text-[12px] text-text">{chip.title}</span>
              <span className="font-mono text-[10px] text-text-faint">
                {chip.backend}
                {chip.paneCount > 1 && ` · ${t("terminal.view.groupPaneCount", { count: chip.paneCount })}`}
              </span>
            </button>
            <button
              onClick={() => onCloseGroup(chip.groupId)}
              aria-label={t("terminal.view.closeTabAria", { name: chip.title })}
              title={t("terminal.view.closeDetachTitle")}
              className="self-stretch px-1.5 text-text-faint hover:bg-surface-overlay hover:text-text"
            >
              ×
            </button>
          </div>
        ))}
        {chips.length === 0 && <p className="px-2 py-3 text-[11px] text-text-faint">{t("terminal.view.startHint")}</p>}
      </div>
      <p
        className="truncate border-t border-border px-2 py-1 font-mono text-[10px] text-text-faint"
        title={splitShortcutHint()}
      >
        {t("terminal.view.repoGeneration", {
          repoId,
          generation: generation ?? t("views.settingsView.systemUnknownDash"),
        })}
      </p>
    </aside>
  );
}

/** 启动选项气泡:新会话后端 + 高级启动表单(名称 / cwd / shell / task 绑定)+ 快捷键提示。 */
function LaunchOptions({
  preferences,
  onPreferenceChange,
  spawn,
  onSpawnChange,
  onCreate,
  tasks,
}: {
  readonly preferences: TerminalPreferences;
  readonly onPreferenceChange: (update: Partial<TerminalPreferences>) => void;
  readonly spawn: TerminalSpawnDraft;
  readonly onSpawnChange: (update: Partial<TerminalSpawnDraft>) => void;
  readonly onCreate: (event: FormEvent) => void;
  readonly tasks: readonly TaskTreeNode[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <Field label={t("terminal.view.backendForNew")}>
        <span className="inline-flex self-start overflow-hidden rounded border border-border-strong">
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
      </Field>
      <form onSubmit={onCreate} className="flex flex-col gap-2 border-t border-border pt-2">
        <p className="text-[11px] text-text-muted">{t("terminal.view.advanced")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("terminal.view.name")}>
            <input
              value={spawn.name}
              onChange={(event) => onSpawnChange({ name: event.target.value })}
              className="control w-32"
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
        </div>
        <Field label={t("terminal.view.task")}>
          <TerminalTaskTreePicker tasks={tasks} value={spawn.taskId} onChange={(taskId) => onSpawnChange({ taskId })} />
        </Field>
        <button className="self-start rounded border border-accent/60 bg-accent/10 px-3 py-1 text-[12px] text-text">
          {t("terminal.view.startCustom")}
        </button>
      </form>
      <p className="border-t border-border pt-2 font-mono text-[10px] text-text-faint">
        {t("terminal.view.shortcut")} · {splitShortcutHint()}
      </p>
    </div>
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
    "flex items-stretch overflow-hidden rounded border",
    selected ? "border-accent/60 bg-surface-raised" : "border-transparent hover:bg-surface-raised/60",
  ].join(" ");
}
function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-text-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}
function splitShortcutHint(): string {
  return t(isMacPlatform() ? "terminal.view.splitShortcutMac" : "terminal.view.splitShortcut");
}
