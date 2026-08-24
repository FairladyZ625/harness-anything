import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TerminalSessionRow } from "../../../../daemon/src/gui-s3-control.ts";
import {
  closeTerminalTab,
  mostRecentAttachableTerminal,
  reconcileTerminalGeneration,
  reduceTerminalStream,
  requestTerminalTermination,
  type TerminalTab
} from "../terminal-model.ts";
import { terminalClient, terminalQueryKeys, type TerminalAttachInitial, type TerminalSpawnInput } from "../terminal-client.ts";
import {
  readTerminalPreferences,
  writeTerminalPreferences,
  type TerminalPreferences
} from "../terminal-preferences.ts";
import { useDockResize } from "./terminal/dock-resize.ts";
import { TerminalPane } from "./terminal/TerminalPane.tsx";
import { t } from "../i18n/index.tsx";

export interface TerminalDockHandle { readonly detachAll: () => Promise<void> }
interface Props { readonly repoId: string; readonly daemonGeneration: number | null; readonly tasks: readonly { readonly taskId: string; readonly title: string }[]; readonly open: boolean; readonly onToggle: () => void }
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
const floatingButtonClassName = [
  "fixed right-4 bottom-3 z-30 rounded-md border border-border-strong",
  "bg-surface-raised px-3 py-1.5 font-mono text-[12px] text-text shadow-xl"
].join(" ");
const bottomDockClassName = [
  "fixed right-0 bottom-0 left-0 z-30 flex flex-col border-t border-border-strong",
  "bg-surface shadow-2xl md:left-56"
].join(" ");
const rightDockClassName = [
  "fixed top-0 right-0 bottom-0 z-30 flex flex-col border-l border-border-strong",
  "bg-surface shadow-2xl"
].join(" ");
const warningClassName = [
  "border-b border-status-blocked/30 bg-status-blocked/10",
  "px-2 py-1 text-[11px] text-status-blocked"
].join(" ");

export const TerminalDock = forwardRef<TerminalDockHandle, Props>(function TerminalDock({ repoId, daemonGeneration, tasks, open, onToggle }, ref) {
  const queryClient = useQueryClient(), [tabs, setTabs] = useState<readonly TerminalTab[]>([]);
  const tabsRef = useRef(tabs), stops = useRef(new Map<string, () => void>());
  const ackSeq = useRef(new Map<string, number>()), inflight = useRef(new Map<string, Promise<void>>());
  const autoStarted = useRef(new Set<string>()), previousOpen = useRef(open);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [confirmId, setConfirmId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<TerminalPreferences>(() =>
    readTerminalPreferences(window.localStorage)
  );
  const [spawn, setSpawn] = useState({ name: t("terminal.dock.title"), cwdScope: "repo-root" as "repo-root" | "repo-relative", path: "", shellProfileId: "default", taskId: "" });
  const resize = useDockResize({
    position: preferences.dockPosition,
    initialHeight: preferences.bottomHeight,
    initialWidth: preferences.rightWidth,
    onSizesChange: (sizes) =>
      setPreferences((current) =>
        current.bottomHeight === sizes.height && current.rightWidth === sizes.width
          ? current
          : { ...current, bottomHeight: sizes.height, rightWidth: sizes.width }
      )
  });
  const sessions = useQuery({
    queryKey: terminalQueryKeys.sessions(repoId),
    queryFn: () => terminalClient.list(repoId),
    enabled: open && repoId !== "unselected",
    staleTime: 1_000
  });
  const generation = daemonGeneration ?? sessions.data?.daemonGeneration;
  tabsRef.current = tabs;
  useEffect(() => { writeTerminalPreferences(window.localStorage, preferences); }, [preferences]);

  const attach = useCallback((row: AttachRow, afterSeq = 0) => {
    if (!row.attachable || row.status !== "running") { setError(t("terminal.dock.sessionNotAttachable")); return; }
    stops.current.get(row.sessionId)?.();
    setTabs((current) => {
      const found = current.find((tab) => tab.sessionId === row.sessionId);
      const next = tabFromRow(row, generation ?? 0, found, afterSeq);
      return found
        ? current.map((tab) => tab.sessionId === row.sessionId ? next : tab)
        : [...current, next];
    });
    setActiveId(row.sessionId); setError(null);
    try {
      const stop = terminalClient.attach(repoId, row.sessionId, afterSeq, (value) =>
        setTabs((current) => current.map((tab) => {
          if (tab.sessionId !== row.sessionId) return tab;
          if (!isInitial(value)) return reduceTerminalStream(tab, value);
          return {
            ...tab,
            daemonGeneration: value.daemonGeneration,
            attachmentId: value.attachmentId,
            notice: value.status === "gap" ? t("terminal.dock.replayGap") : tab.notice
          };
        }))
      );
      stops.current.set(row.sessionId, stop);
    } catch (cause) { consumeKnownError(cause); setError(message(cause)); }
  }, [generation, repoId]);

  const start = useCallback(async (custom: boolean) => {
    setError(null);
    const cwd: TerminalSpawnInput["cwd"] = custom && spawn.cwdScope === "repo-relative"
      ? { scope: "repo-relative", path: spawn.path }
      : { scope: "repo-root" };
    const name = custom ? spawn.name : t("terminal.dock.title");
    try {
      const receipt = await terminalClient.spawn(repoId, {
        idempotencyKey: `terminal-gui-${crypto.randomUUID()}`,
        backend: preferences.backend,
        name: name || undefined,
        cwd,
        shellProfileId: custom ? spawn.shellProfileId || undefined : "default",
        taskId: custom ? spawn.taskId || undefined : undefined
      });
      if (receipt.outcome !== "applied" || !receipt.sessionId) throw new Error(typeof receipt.error?.hint === "string" ? receipt.error.hint : t("terminal.dock.spawnRejected", { operationId: receipt.operationId }));
      const listed = await terminalClient.list(repoId);
      queryClient.setQueryData(terminalQueryKeys.sessions(repoId), listed);
      const row = listed.sessions.find((item) => item.sessionId === receipt.sessionId);
      if (!row) throw new Error(t("terminal.dock.spawnMissing")); attach(row, 0);
    } catch (cause) { consumeKnownError(cause); setError(message(cause)); }
  }, [attach, preferences.backend, queryClient, repoId, spawn]);

  const detachAll = async (): Promise<void> => {
    const current = [...tabsRef.current];
    await Promise.all(current.map(async (tab) => {
      try {
        await closeTerminalTab(repoId, tab, {
          stopStream: stops.current.get(tab.sessionId) ?? (() => undefined),
          detach: terminalClient.detach
        });
      } catch (cause) { consumeKnownError(cause); }
    }));
    stops.current.clear();
    setTabs([]);
    setActiveId(null);
  };
  useImperativeHandle(ref, () => ({ detachAll }), [repoId]);
  useEffect(() => () => { for (const stop of stops.current.values()) stop(); stops.current.clear(); }, []);
  useEffect(() => {
    if (generation !== null && generation !== undefined)
      setTabs((current) => reconcileTerminalGeneration(current, generation));
  }, [generation]);
  useEffect(() => {
    const wasOpen = previousOpen.current; previousOpen.current = open;
    if (wasOpen && !open) {
      const current = [...tabsRef.current];
      for (const stop of stops.current.values()) stop();
      stops.current.clear();
      setTabs((items) => items.map((tab) => ({ ...tab, attachmentId: null })));
      void Promise.all(current.flatMap((tab) => tab.attachmentId
        ? [terminalClient.detach(repoId, tab.sessionId, tab.attachmentId).catch(consumeKnownError)]
        : []));
    } else if (!wasOpen && open) {
      for (const tab of tabsRef.current) {
        const row = sessions.data?.sessions.find((item) => item.sessionId === tab.sessionId);
        if (row?.attachable) attach(row, tab.lastSeq);
      }
    }
  }, [attach, open, repoId, sessions.data]);
  useEffect(() => {
    const shouldSkip =
      !open ||
      repoId === "unselected" ||
      !sessions.isSuccess ||
      tabsRef.current.length > 0 ||
      autoStarted.current.has(repoId);
    if (shouldSkip) return;
    autoStarted.current.add(repoId);
    const restored = mostRecentAttachableTerminal(sessions.data.sessions);
    if (restored) attach(restored, 0);
    else void start(false);
  }, [attach, open, repoId, sessions.data, sessions.isSuccess, start]);

  const create = (event: FormEvent) => { event.preventDefault(); void start(true); };
  const close = async (tab: TerminalTab) => {
    try {
      await closeTerminalTab(repoId, tab, {
        stopStream: stops.current.get(tab.sessionId) ?? (() => undefined),
        detach: terminalClient.detach
      });
    } catch (cause) { consumeKnownError(cause); setError(message(cause)); }
    stops.current.delete(tab.sessionId);
    setTabs((current) => current.filter((item) => item.sessionId !== tab.sessionId));
    setActiveId((current) => current === tab.sessionId ? null : current);
  };
  const send = (sessionId: string, utf8: string) => {
    const tail = inflight.current.get(sessionId) ?? Promise.resolve();
    const next = tail.then(async () => {
      const seq = (ackSeq.current.get(sessionId) ?? 0) + 1;
      ackSeq.current.set(sessionId, await terminalClient.input(repoId, sessionId, seq, utf8));
    }).catch((cause: unknown) => { consumeKnownError(cause); setError(message(cause)); });
    inflight.current.set(sessionId, next);
  };
  const refit = (sessionId: string, cols: number, rows: number) => {
    void terminalClient.resize(repoId, sessionId, cols, rows)
      .catch((cause) => { consumeKnownError(cause); setError(message(cause)); });
  };
  const terminate = async (tab: TerminalTab) => {
    try {
      await requestTerminalTermination(repoId, tab, true, { terminate: terminalClient.terminate });
      setTabs((current) => current.map((item) => item.sessionId === tab.sessionId
        ? { ...item, state: "exited", attachable: false, notice: t("terminal.dock.terminationConfirmed") }
        : item));
      setConfirmId(null);
    } catch (cause) { consumeKnownError(cause); setError(message(cause)); }
  };
  const active = tabs.find((tab) => tab.sessionId === activeId) ?? null;
  const dockPosition = preferences.dockPosition;
  const setPreference = (update: Partial<TerminalPreferences>) =>
    setPreferences((current) => ({ ...current, ...update }));
  const dockClassName = dockPosition === "bottom" ? bottomDockClassName : rightDockClassName;
  const resizeHandleClassName = [
    dockPosition === "bottom"
      ? "absolute inset-x-0 -top-1 h-2 cursor-row-resize"
      : "absolute inset-y-0 -left-1 w-2 cursor-col-resize",
    "z-20 touch-none hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none",
    resize.resizing ? "bg-accent/50" : ""
  ].join(" ");

  if (!open) return <button
    onClick={onToggle}
    className={floatingButtonClassName}
    title={t("terminal.dock.shortcut")}
  >
    {t("terminal.dock.title")} · {t("terminal.dock.shortcut")}
  </button>;
  return <section
    aria-label={t("terminal.dock.title")}
    data-dock-position={dockPosition}
    className={dockClassName}
    style={dockPosition === "bottom" ? { height: `${resize.height}px` } : { width: `${resize.width}px` }}
  >
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={dockPosition === "bottom" ? "horizontal" : "vertical"}
      aria-label={dockPosition === "bottom"
        ? t("terminal.dock.resizeHeightAria")
        : t("terminal.dock.resizeWidthAria")}
      title={dockPosition === "bottom"
        ? t("terminal.dock.resizeHeightTitle")
        : t("terminal.dock.resizeWidthTitle")}
      data-testid="terminal-dock-resize-handle"
      className={resizeHandleClassName}
      onPointerDown={resize.onHandlePointerDown}
      onPointerMove={resize.onHandlePointerMove}
      onPointerUp={resize.onHandlePointerUp}
      onPointerCancel={resize.onHandlePointerUp}
      onKeyDown={resize.onHandleKeyDown}
    />
    <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
      <strong className="text-[13px]">{t("terminal.dock.localTerminal")}</strong>
      <span className="font-mono text-[11px] text-text-faint">
        {t("terminal.dock.repoGeneration", {
          repoId,
          generation: generation ?? t("views.settingsView.systemUnknownDash")
        })}
      </span>
      <span
        className="inline-flex overflow-hidden rounded border border-border-strong"
        aria-label={t("terminal.dock.backendForNew")}
      >
        <button
          aria-pressed={preferences.backend === "direct-pty"}
          onClick={() => setPreference({ backend: "direct-pty" })}
          className={toggleClassName(preferences.backend === "direct-pty")}
        >{t("terminal.dock.backendDirect")}</button>
        <button
          aria-pressed={preferences.backend === "tmux"}
          onClick={() => setPreference({ backend: "tmux" })}
          className={toggleClassName(preferences.backend === "tmux")}
        >{t("terminal.dock.backendTmux")}</button>
      </span>
      <span className="ml-auto inline-flex overflow-hidden rounded border border-border-strong">
        <button
          data-testid="terminal-dock-bottom"
          aria-pressed={dockPosition === "bottom"}
          onClick={() => setPreference({ dockPosition: "bottom" })}
          className={toggleClassName(dockPosition === "bottom")}
        >{t("terminal.dock.positionBottom")}</button>
        <button
          data-testid="terminal-dock-right"
          aria-pressed={dockPosition === "right"}
          onClick={() => setPreference({ dockPosition: "right" })}
          className={toggleClassName(dockPosition === "right")}
        >{t("terminal.dock.positionRight")}</button>
      </span>
      <button
        onClick={onToggle}
        className="rounded px-2 py-1 text-[12px] text-text-muted hover:bg-surface-raised"
      >{t("terminal.dock.close")} · {t("terminal.dock.shortcut")}</button>
    </header>
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
      {tabs.map((tab) => <span key={tab.sessionId} className={tabClassName(activeId === tab.sessionId)}>
        <button
          onClick={() => setActiveId(tab.sessionId)}
          className="max-w-44 truncate px-2 py-1 text-[11px] text-text"
        >
          {tab.name} <span className="font-mono text-text-faint">· {tab.backend}</span>
        </button>
        <button
          onClick={() => { void close(tab); }}
          aria-label={t("terminal.dock.closeTabAria", { name: tab.name })}
          title={t("terminal.dock.closeDetachTitle")}
          className="border-l border-border px-1.5 text-text-faint hover:bg-surface-overlay"
        >×</button>
      </span>)}
      <button
        onClick={() => { void start(false); }}
        title={t("terminal.dock.quickStartTitle")}
        aria-label={t("terminal.dock.newTab")}
        className="shrink-0 rounded border border-accent/60 bg-accent/10 px-2 py-1 text-[13px] text-text"
      >+</button>
      <select
        aria-label={t("terminal.dock.attachExisting")}
        defaultValue=""
        onChange={(event) => {
          const row = sessions.data?.sessions.find((item) => item.sessionId === event.target.value);
          if (row) attach(row, 0);
          event.target.value = "";
        }}
        className="control ml-auto shrink-0"
      >
        <option value="">{t("terminal.dock.attachSession")}</option>
        {sessions.data?.sessions.map((row) => <option
          key={row.sessionId}
          value={row.sessionId}
          disabled={!row.attachable}
        >{row.name} · {row.backend} · {row.status}</option>)}
      </select>
    </div>
    <details className="border-b border-border px-3 py-1 text-[11px]">
      <summary className="cursor-pointer text-text-muted">{t("terminal.dock.advanced")}</summary>
      <form onSubmit={create} className="flex flex-wrap items-end gap-2 py-2">
        <Field label={t("terminal.dock.name")}>
          <input
            value={spawn.name}
            onChange={(event) => setSpawn({ ...spawn, name: event.target.value })}
            className="control w-28"
          />
        </Field>
        <Field label={t("terminal.dock.cwd")}>
          <select
            value={spawn.cwdScope}
            onChange={(event) => setSpawn({
              ...spawn,
              cwdScope: event.target.value as typeof spawn.cwdScope
            })}
            className="control"
          >
            <option value="repo-root">repo-root</option>
            <option value="repo-relative">repo-relative</option>
          </select>
        </Field>
        {spawn.cwdScope === "repo-relative" && <Field label={t("terminal.dock.path")}>
          <input
            required
            value={spawn.path}
            onChange={(event) => setSpawn({ ...spawn, path: event.target.value })}
            className="control w-36"
          />
        </Field>}
        <Field label={t("terminal.dock.shell")}>
          <select
            value={spawn.shellProfileId}
            onChange={(event) => setSpawn({ ...spawn, shellProfileId: event.target.value })}
            className="control"
          >
            {shellOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </Field>
        <Field label={t("terminal.dock.task")}>
          <select
            value={spawn.taskId}
            onChange={(event) => setSpawn({ ...spawn, taskId: event.target.value })}
            className="control max-w-44"
          >
            <option value="">{t("terminal.dock.unbound")}</option>
            {tasks.map((task) => <option key={task.taskId} value={task.taskId}>
              {task.taskId} · {task.title}
            </option>)}
          </select>
        </Field>
        <button className="rounded border border-accent/60 bg-accent/10 px-3 py-1 text-[12px] text-text">
          {t("terminal.dock.startCustom")}
        </button>
      </form>
    </details>
    <div className="flex min-h-0 flex-1 flex-col">
      {active ? <>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1 text-[11px]">
          <span className="font-mono text-text-faint">
            {active.cwd} · {active.backend} · {active.durability} · {active.state}
          </span>
          <span className="font-mono text-[10px] text-text-faint">{active.sessionId}</span>
          <button
            onClick={() => { void close(active); }}
            className="ml-auto rounded px-2 py-1 text-text-muted hover:bg-surface-raised"
            title={t("terminal.dock.closeDetachTitle")}
          >{t("terminal.dock.closeDetach")}</button>
          {confirmId === active.sessionId ? <>
            <span className="text-status-blocked">{t("terminal.dock.confirmTerminatePrompt")}</span>
            <button
              onClick={() => setConfirmId(null)}
              className="rounded px-2 py-1 text-text-muted hover:bg-surface-raised"
            >{t("terminal.dock.cancel")}</button>
            <button
              onClick={() => { void terminate(active); }}
              className="rounded px-2 py-1 text-status-blocked hover:bg-surface-raised"
            >{t("terminal.dock.confirmTerminate")}</button>
          </> : <button
            onClick={() => setConfirmId(active.sessionId)}
            className="rounded px-2 py-1 text-status-blocked hover:bg-surface-raised"
          >{t("terminal.dock.terminate")}</button>}
        </div>
        {active.warning && <p role="status" className={warningClassName}>
          {active.backend === "direct-pty"
            ? t("terminal.dock.tmuxFallbackWarning")
            : t("terminal.dock.tmuxUnavailableWarning")}
        </p>}
        {active.notice && <p role="status" className={warningClassName}>{active.notice}</p>}
        {active.state === "running" || active.output ? <TerminalPane
          output={active.output}
          interactive={active.state === "running" && active.attachable}
          onInput={(utf8) => send(active.sessionId, utf8)}
          onFit={(cols, rows) => refit(active.sessionId, cols, rows)}
        /> : <div className="grid flex-1 place-items-center px-4 text-center text-[12px] text-text-faint">
          {active.notice ?? t("terminal.dock.sessionNotInteractive")}
        </div>}
      </> : <div className="grid h-full place-items-center text-[12px] text-text-faint">
        {t("terminal.dock.startHint")}
      </div>}
    </div>
    {error && <p
      role="alert"
      className="border-t border-status-blocked/30 px-3 py-1 text-[11px] text-status-blocked"
    >{error}</p>}
  </section>;
});

function tabFromRow(
  row: AttachRow,
  daemonGeneration: number,
  existing: TerminalTab | undefined,
  afterSeq: number
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
    attachable: row.attachable
  };
}
function toggleClassName(selected: boolean): string {
  return [
    "px-2 py-1 text-[11px]",
    selected ? "bg-accent text-accent-fg" : "text-text-muted hover:bg-surface-raised"
  ].join(" ");
}
function tabClassName(selected: boolean): string {
  return [
    "inline-flex shrink-0 overflow-hidden rounded border",
    selected ? "border-accent/60 bg-surface-raised" : "border-border"
  ].join(" ");
}
function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) { return <label className="grid gap-0.5 font-mono text-[10px] uppercase tracking-wide text-text-faint">{label}{children}</label>; }
function isInitial(value: TerminalAttachInitial | import("../terminal-model.ts").TerminalStreamFrame): value is TerminalAttachInitial { return value.schema === "terminal-attach/v1"; }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function consumeKnownError(value: unknown): void { void value; }
