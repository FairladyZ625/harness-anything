import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TerminalSessionRow } from "../../../../daemon/src/gui-s3-control.ts";
import {
  closeTerminalTab,
  mostRecentAttachableTerminal,
  reconcileTerminalGeneration,
  reduceTerminalStream,
  requestTerminalTermination,
  type TerminalTab,
} from "../terminal-model.ts";
import {
  terminalClient,
  terminalQueryKeys,
  type TerminalAttachInitial,
  type TerminalSpawnInput,
} from "../terminal-client.ts";
import {
  readTerminalPreferences,
  writeTerminalPreferences,
  type TerminalPreferences,
} from "../terminal-preferences.ts";
import { TerminalPane } from "../components/terminal/TerminalPane.tsx";
import { t } from "../i18n/index.tsx";

/**
 * 终端一等页面(PLT-TerminalWorkspace W0):承接原底部终端 dock 的全部能力——
 * 多 tab、快速新建、attach 已有会话、断线重连(generation 对账)、gap 提示、
 * exit 只读、tmux/direct-pty 双后端。状态机复用 terminal-model,渲染复用 TerminalPane,
 * 本组件只搬 UI 壳。页面语义:进入页面 = 打开终端面;离开页面(或切仓)= 停止全部
 * 流并 detach 全部附件(与 dock 关闭路径同一条 closeTerminalTab/terminalClient.detach 通路)。
 */
interface Props {
  readonly repoId: string;
  readonly daemonGeneration: number | null;
  readonly tasks: readonly { readonly taskId: string; readonly title: string }[];
}
type AttachRow = Pick<
  TerminalSessionRow,
  | "sessionId"
  | "name"
  | "status"
  | "outputSeq"
  | "cwd"
  | "requestedBackend"
  | "backend"
  | "durability"
  | "warning"
  | "attachable"
>;
const shellOptions = ["default", "zsh", "bash", "sh", "fish"] as const;
const warningClassName = [
  "border-b border-status-blocked/30 bg-status-blocked/10",
  "px-2 py-1 text-[11px] text-status-blocked",
].join(" ");

export function TerminalView({ repoId, daemonGeneration, tasks }: Props) {
  const queryClient = useQueryClient(),
    [tabs, setTabs] = useState<readonly TerminalTab[]>([]);
  const tabsRef = useRef(tabs),
    stops = useRef(new Map<string, () => void>()),
    repoIdRef = useRef(repoId),
    mountedRef = useRef(true);
  const ackSeq = useRef(new Map<string, number>()),
    inflight = useRef(new Map<string, Promise<void>>());
  const autoStarted = useRef(new Set<string>());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null),
    [confirmId, setConfirmId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<TerminalPreferences>(() =>
    readTerminalPreferences(window.localStorage),
  );
  const [spawn, setSpawn] = useState({
    name: t("terminal.view.title"),
    cwdScope: "repo-root" as "repo-root" | "repo-relative",
    path: "",
    shellProfileId: "default",
    taskId: "",
  });
  const sessions = useQuery({
    queryKey: terminalQueryKeys.sessions(repoId),
    queryFn: () => terminalClient.list(repoId),
    enabled: repoId !== "unselected",
    staleTime: 1_000,
  });
  const generation = daemonGeneration ?? sessions.data?.daemonGeneration;
  tabsRef.current = tabs;
  useEffect(() => {
    writeTerminalPreferences(window.localStorage, preferences);
  }, [preferences]);

  /** 离开页面/切仓:停止全部流并 detach 全部附件;tab 列表随页面状态一并清空。 */
  const releaseTabs = useCallback(async (detachRepoId: string): Promise<void> => {
    const current = [...tabsRef.current];
    for (const stop of stops.current.values()) stop();
    stops.current.clear();
    setTabs([]);
    setActiveId(null);
    await Promise.all(
      current.flatMap((tab) =>
        tab.attachmentId
          ? [terminalClient.detach(detachRepoId, tab.sessionId, tab.attachmentId).catch(consumeKnownError)]
          : [],
      ),
    );
  }, []);
  useEffect(
    () => () => {
      mountedRef.current = false;
      void releaseTabs(repoIdRef.current);
    },
    [releaseTabs],
  );
  // 仓内 session 全部按 repoId 限定:切仓而页面未卸载时,旧仓 tab 必须先释放,
  // 否则后续 input/resize 会以新 repoId 打到旧仓 session 上。
  useEffect(() => {
    if (repoIdRef.current === repoId) return;
    const previous = repoIdRef.current;
    repoIdRef.current = repoId;
    autoStarted.current.delete(previous);
    void releaseTabs(previous);
  }, [repoId, releaseTabs]);

  const attach = useCallback(
    (row: AttachRow, afterSeq = 0) => {
      if (!row.attachable || row.status !== "running") {
        setError(t("terminal.view.sessionNotAttachable"));
        return;
      }
      stops.current.get(row.sessionId)?.();
      setTabs((current) => {
        const found = current.find((tab) => tab.sessionId === row.sessionId);
        const next = tabFromRow(row, generation ?? 0, found, afterSeq);
        return found ? current.map((tab) => (tab.sessionId === row.sessionId ? next : tab)) : [...current, next];
      });
      setActiveId(row.sessionId);
      setError(null);
      try {
        const stop = terminalClient.attach(repoId, row.sessionId, afterSeq, (value) =>
          setTabs((current) =>
            current.map((tab) => {
              if (tab.sessionId !== row.sessionId) return tab;
              if (!isInitial(value)) return reduceTerminalStream(tab, value);
              return {
                ...tab,
                daemonGeneration: value.daemonGeneration,
                attachmentId: value.attachmentId,
                notice: value.status === "gap" ? t("terminal.view.replayGap") : tab.notice,
              };
            }),
          ),
        );
        stops.current.set(row.sessionId, stop);
      } catch (cause) {
        consumeKnownError(cause);
        setError(message(cause));
      }
    },
    [generation, repoId],
  );

  const start = useCallback(
    async (custom: boolean) => {
      setError(null);
      const cwd: TerminalSpawnInput["cwd"] =
        custom && spawn.cwdScope === "repo-relative"
          ? { scope: "repo-relative", path: spawn.path }
          : { scope: "repo-root" };
      const name = custom ? spawn.name : t("terminal.view.title");
      try {
        const receipt = await terminalClient.spawn(repoId, {
          idempotencyKey: `terminal-gui-${crypto.randomUUID()}`,
          backend: preferences.backend,
          name: name || undefined,
          cwd,
          shellProfileId: custom ? spawn.shellProfileId || undefined : "default",
          taskId: custom ? spawn.taskId || undefined : undefined,
        });
        if (receipt.outcome !== "applied" || !receipt.sessionId)
          throw new Error(
            typeof receipt.error?.hint === "string"
              ? receipt.error.hint
              : t("terminal.view.spawnRejected", { operationId: receipt.operationId }),
          );
        // spawn 往返期间页面可能已离开/切仓:此时不再 attach(会话在 daemon 侧仍持久,
        // 重新进页时由自动附加路径接回),避免给已卸载的壳留下无主流/附件。
        if (!mountedRef.current || repoIdRef.current !== repoId) return;
        const listed = await terminalClient.list(repoId);
        queryClient.setQueryData(terminalQueryKeys.sessions(repoId), listed);
        const row = listed.sessions.find((item) => item.sessionId === receipt.sessionId);
        if (!row) throw new Error(t("terminal.view.spawnMissing"));
        attach(row, 0);
      } catch (cause) {
        consumeKnownError(cause);
        setError(message(cause));
      }
    },
    [attach, preferences.backend, queryClient, repoId, spawn],
  );

  useEffect(() => {
    if (generation !== null && generation !== undefined)
      setTabs((current) => reconcileTerminalGeneration(current, generation));
  }, [generation]);
  useEffect(() => {
    const shouldSkip =
      repoId === "unselected" || !sessions.isSuccess || tabsRef.current.length > 0 || autoStarted.current.has(repoId);
    if (shouldSkip) return;
    autoStarted.current.add(repoId);
    const restored = mostRecentAttachableTerminal(sessions.data.sessions);
    if (restored) attach(restored, 0);
    else void start(false);
  }, [attach, repoId, sessions.data, sessions.isSuccess, start]);

  const create = (event: FormEvent) => {
    event.preventDefault();
    void start(true);
  };
  const close = async (tab: TerminalTab) => {
    try {
      await closeTerminalTab(repoId, tab, {
        stopStream: stops.current.get(tab.sessionId) ?? (() => undefined),
        detach: terminalClient.detach,
      });
    } catch (cause) {
      consumeKnownError(cause);
      setError(message(cause));
    }
    stops.current.delete(tab.sessionId);
    setTabs((current) => current.filter((item) => item.sessionId !== tab.sessionId));
    setActiveId((current) => (current === tab.sessionId ? null : current));
  };
  const send = (sessionId: string, utf8: string) => {
    const tail = inflight.current.get(sessionId) ?? Promise.resolve();
    const next = tail
      .then(async () => {
        const seq = (ackSeq.current.get(sessionId) ?? 0) + 1;
        ackSeq.current.set(sessionId, await terminalClient.input(repoId, sessionId, seq, utf8));
      })
      .catch((cause: unknown) => {
        consumeKnownError(cause);
        setError(message(cause));
      });
    inflight.current.set(sessionId, next);
  };
  const refit = (sessionId: string, cols: number, rows: number) => {
    void terminalClient.resize(repoId, sessionId, cols, rows).catch((cause: unknown) => {
      consumeKnownError(cause);
      setError(message(cause));
    });
  };
  const terminate = async (tab: TerminalTab) => {
    try {
      await requestTerminalTermination(repoId, tab, true, { terminate: terminalClient.terminate });
      setTabs((current) =>
        current.map((item) =>
          item.sessionId === tab.sessionId
            ? { ...item, state: "exited", attachable: false, notice: t("terminal.view.terminationConfirmed") }
            : item,
        ),
      );
      setConfirmId(null);
    } catch (cause) {
      consumeKnownError(cause);
      setError(message(cause));
    }
  };
  const active = tabs.find((tab) => tab.sessionId === activeId) ?? null;
  const setPreference = (update: Partial<TerminalPreferences>) =>
    setPreferences((current) => ({ ...current, ...update }));

  return (
    <section
      aria-label={t("terminal.view.title")}
      data-testid="terminal-view"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
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
            onClick={() => setPreference({ backend: "direct-pty" })}
            className={toggleClassName(preferences.backend === "direct-pty")}
          >
            {t("terminal.view.backendDirect")}
          </button>
          <button
            aria-pressed={preferences.backend === "tmux"}
            onClick={() => setPreference({ backend: "tmux" })}
            className={toggleClassName(preferences.backend === "tmux")}
          >
            {t("terminal.view.backendTmux")}
          </button>
        </span>
        <span className="ml-auto font-mono text-[11px] text-text-faint" title={t("terminal.view.shortcut")}>
          {t("terminal.view.shortcut")}
        </span>
      </header>
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
        {tabs.map((tab) => (
          <span key={tab.sessionId} className={tabClassName(activeId === tab.sessionId)}>
            <button
              onClick={() => setActiveId(tab.sessionId)}
              className="max-w-44 truncate px-2 py-1 text-[11px] text-text"
            >
              {tab.name} <span className="font-mono text-text-faint">· {tab.backend}</span>
            </button>
            <button
              onClick={() => {
                void close(tab);
              }}
              aria-label={t("terminal.view.closeTabAria", { name: tab.name })}
              title={t("terminal.view.closeDetachTitle")}
              className="border-l border-border px-1.5 text-text-faint hover:bg-surface-overlay"
            >
              ×
            </button>
          </span>
        ))}
        <button
          onClick={() => {
            void start(false);
          }}
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
            const row = sessions.data?.sessions.find((item) => item.sessionId === event.target.value);
            if (row) attach(row, 0);
            event.target.value = "";
          }}
          className="control ml-auto shrink-0"
        >
          <option value="">{t("terminal.view.attachSession")}</option>
          {sessions.data?.sessions.map((row) => (
            <option key={row.sessionId} value={row.sessionId} disabled={!row.attachable}>
              {row.name} · {row.backend} · {row.status}
            </option>
          ))}
        </select>
      </div>
      <details className="border-b border-border px-3 py-1 text-[11px]">
        <summary className="cursor-pointer text-text-muted">{t("terminal.view.advanced")}</summary>
        <form onSubmit={create} className="flex flex-wrap items-end gap-2 py-2">
          <Field label={t("terminal.view.name")}>
            <input
              value={spawn.name}
              onChange={(event) => setSpawn({ ...spawn, name: event.target.value })}
              className="control w-28"
            />
          </Field>
          <Field label={t("terminal.view.cwd")}>
            <select
              value={spawn.cwdScope}
              onChange={(event) =>
                setSpawn({
                  ...spawn,
                  cwdScope: event.target.value as typeof spawn.cwdScope,
                })
              }
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
                onChange={(event) => setSpawn({ ...spawn, path: event.target.value })}
                className="control w-36"
              />
            </Field>
          )}
          <Field label={t("terminal.view.shell")}>
            <select
              value={spawn.shellProfileId}
              onChange={(event) => setSpawn({ ...spawn, shellProfileId: event.target.value })}
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
            <select
              value={spawn.taskId}
              onChange={(event) => setSpawn({ ...spawn, taskId: event.target.value })}
              className="control max-w-44"
            >
              <option value="">{t("terminal.view.unbound")}</option>
              {tasks.map((task) => (
                // G10:实体 ID 不落在不可激活文本里;taskId 走机器值/tooltip,文本用标题。
                <option key={task.taskId} value={task.taskId} title={task.taskId}>
                  {task.title}
                </option>
              ))}
            </select>
          </Field>
          <button className="rounded border border-accent/60 bg-accent/10 px-3 py-1 text-[12px] text-text">
            {t("terminal.view.startCustom")}
          </button>
        </form>
      </details>
      {/* pane 区:中性容器,占满剩余高度;W1 分屏(pane 树)在此容器内落地。 */}
      <div data-testid="terminal-pane-region" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {active ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1 text-[11px]">
              <span className="font-mono text-text-faint">
                {active.cwd} · {active.backend} · {active.durability} · {active.state}
              </span>
              <span className="font-mono text-[10px] text-text-faint">{active.sessionId}</span>
              <button
                onClick={() => {
                  void close(active);
                }}
                className="ml-auto rounded px-2 py-1 text-text-muted hover:bg-surface-raised"
                title={t("terminal.view.closeDetachTitle")}
              >
                {t("terminal.view.closeDetach")}
              </button>
              {confirmId === active.sessionId ? (
                <>
                  <span className="text-status-blocked">{t("terminal.view.confirmTerminatePrompt")}</span>
                  <button
                    onClick={() => setConfirmId(null)}
                    className="rounded px-2 py-1 text-text-muted hover:bg-surface-raised"
                  >
                    {t("terminal.view.cancel")}
                  </button>
                  <button
                    onClick={() => {
                      void terminate(active);
                    }}
                    className="rounded px-2 py-1 text-status-blocked hover:bg-surface-raised"
                  >
                    {t("terminal.view.confirmTerminate")}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmId(active.sessionId)}
                  className="rounded px-2 py-1 text-status-blocked hover:bg-surface-raised"
                >
                  {t("terminal.view.terminate")}
                </button>
              )}
            </div>
            {active.warning && (
              <p role="status" className={warningClassName}>
                {active.backend === "direct-pty"
                  ? t("terminal.view.tmuxFallbackWarning")
                  : t("terminal.view.tmuxUnavailableWarning")}
              </p>
            )}
            {active.notice && (
              <p role="status" className={warningClassName}>
                {active.notice}
              </p>
            )}
            {active.state === "running" || active.output ? (
              <TerminalPane
                output={active.output}
                interactive={active.state === "running" && active.attachable}
                onInput={(utf8) => send(active.sessionId, utf8)}
                onFit={(cols, rows) => refit(active.sessionId, cols, rows)}
              />
            ) : (
              <div className="grid flex-1 place-items-center px-4 text-center text-[12px] text-text-faint">
                {active.notice ?? t("terminal.view.sessionNotInteractive")}
              </div>
            )}
          </>
        ) : (
          <div className="grid h-full place-items-center px-4 text-center text-[12px] text-text-faint">
            {t("terminal.view.startHint")}
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="border-t border-status-blocked/30 px-3 py-1 text-[11px] text-status-blocked">
          {error}
        </p>
      )}
    </section>
  );
}

function tabFromRow(
  row: AttachRow,
  daemonGeneration: number,
  existing: TerminalTab | undefined,
  afterSeq: number,
): TerminalTab {
  return {
    sessionId: row.sessionId,
    name: row.name,
    state: row.status,
    daemonGeneration,
    attachmentId: null,
    lastSeq: existing?.lastSeq ?? afterSeq,
    output: existing?.output ?? "",
    notice: existing?.notice ?? null,
    cwd: row.cwd,
    requestedBackend: row.requestedBackend,
    backend: row.backend,
    durability: row.durability,
    warning: row.warning,
    attachable: row.attachable,
  };
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
function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <label className="grid gap-0.5 font-mono text-[10px] uppercase tracking-wide text-text-faint">
      {label}
      {children}
    </label>
  );
}
function isInitial(
  value: TerminalAttachInitial | import("../terminal-model.ts").TerminalStreamFrame,
): value is TerminalAttachInitial {
  return value.schema === "terminal-attach/v1";
}
function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
function consumeKnownError(value: unknown): void {
  void value;
}
