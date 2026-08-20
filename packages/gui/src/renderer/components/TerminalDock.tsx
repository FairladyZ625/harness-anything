import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TerminalSessionRow } from "@harness-anything/daemon/gui-s3-control";
import { closeTerminalTab, reconcileTerminalGeneration, reduceTerminalStream, requestTerminalTermination, type TerminalTab } from "../terminal-model.ts";
import { terminalClient, terminalQueryKeys, type TerminalAttachInitial, type TerminalSpawnInput } from "../terminal-client.ts";
import { useDockResize } from "./terminal/dock-resize.ts";
import { TerminalPane } from "./terminal/TerminalPane.tsx";
import { t } from "../i18n/index.tsx";

export interface TerminalDockHandle { readonly detachAll: () => Promise<void> }
interface Props { readonly repoId: string; readonly daemonGeneration: number | null; readonly tasks: readonly { readonly taskId: string; readonly title: string }[]; readonly open: boolean; readonly onToggle: () => void }

/**
 * 本地直连 PTY 终端 dock。保真度升级(REQ-GUI-10 degraded 项):
 * <pre>+行式输入表单 → @xterm/xterm 真仿真(FitAddon 自适应 + onData 直发),
 * 固定高度 → 拖拽 resize(dock-resize)。detach/terminate 二次确认/daemon
 * generation reconcile 语义原样保留。
 */
export const TerminalDock = forwardRef<TerminalDockHandle, Props>(function TerminalDock({ repoId, daemonGeneration, tasks, open, onToggle }, ref) {
  const queryClient = useQueryClient(), [tabs, setTabs] = useState<readonly TerminalTab[]>([]), tabsRef = useRef(tabs), stops = useRef(new Map<string, () => void>());
  // 输入串行化:每个 session 一条 promise 链,clientSeq 严格 = 上次 ack + 1。
  const ackSeq = useRef(new Map<string, number>()), inflight = useRef(new Map<string, Promise<void>>());
  const [activeId, setActiveId] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [confirmId, setConfirmId] = useState<string | null>(null);
  const [spawn, setSpawn] = useState({ name: t("terminal.dock.title"), cwdScope: "repo-root" as "repo-root" | "repo-relative", path: "", shellProfileId: "default", taskId: "" });
  const resize = useDockResize();
  const sessions = useQuery({ queryKey: terminalQueryKeys.sessions(repoId), queryFn: () => terminalClient.list(repoId), enabled: open && repoId !== "unselected", staleTime: 1_000 });
  tabsRef.current = tabs;
  const generation = daemonGeneration ?? sessions.data?.daemonGeneration;

  const detachAll = async (): Promise<void> => {
    const current = [...tabsRef.current];
    await Promise.all(current.map(async (tab) => { try { await closeTerminalTab(repoId, tab, { stopStream: stops.current.get(tab.sessionId) ?? (() => undefined), detach: terminalClient.detach }); } catch (cause) { consumeKnownError(cause); /* daemon restart can invalidate an attachment */ } }));
    stops.current.clear(); setTabs([]); setActiveId(null);
  };
  useImperativeHandle(ref, () => ({ detachAll }), [repoId]);
  useEffect(() => () => { for (const stop of stops.current.values()) stop(); stops.current.clear(); }, []);
  useEffect(() => { if (generation !== null && generation !== undefined) setTabs((current) => reconcileTerminalGeneration(current, generation)); }, [generation]);

  const attach = (row: Pick<TerminalSessionRow, "sessionId" | "name" | "status" | "outputSeq">, afterSeq = 0) => {
    stops.current.get(row.sessionId)?.();
    setTabs((current) => current.some((tab) => tab.sessionId === row.sessionId) ? current : [...current, { sessionId: row.sessionId, name: row.name, state: row.status, daemonGeneration: generation ?? 0, attachmentId: null, lastSeq: afterSeq, output: "", notice: null }]);
    setActiveId(row.sessionId); setError(null);
    try {
      const stop = terminalClient.attach(repoId, row.sessionId, afterSeq, (value) => setTabs((current) => current.map((tab) => tab.sessionId !== row.sessionId ? tab : isInitial(value)
        ? { ...tab, daemonGeneration: value.daemonGeneration, attachmentId: value.attachmentId, notice: value.status === "gap" ? t("terminal.dock.replayGap") : tab.notice }
        : reduceTerminalStream(tab, value))));
      stops.current.set(row.sessionId, stop);
    } catch (cause) { consumeKnownError(cause); setError(message(cause)); }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault(); setError(null);
    const cwd: TerminalSpawnInput["cwd"] = spawn.cwdScope === "repo-root" ? { scope: "repo-root" } : { scope: "repo-relative", path: spawn.path };
    try {
      const receipt = await terminalClient.spawn(repoId, { idempotencyKey: `terminal-gui-${crypto.randomUUID()}`, name: spawn.name || undefined, cwd, shellProfileId: spawn.shellProfileId || undefined, taskId: spawn.taskId || undefined });
      if (receipt.outcome !== "applied" || !receipt.sessionId) throw new Error(typeof receipt.error?.hint === "string" ? receipt.error.hint : t("terminal.dock.spawnRejected", { operationId: receipt.operationId }));
      await queryClient.invalidateQueries({ queryKey: terminalQueryKeys.sessions(repoId) });
      attach({ sessionId: receipt.sessionId, name: spawn.name || t("terminal.dock.title"), status: "running", outputSeq: 0 });
    } catch (cause) { consumeKnownError(cause); setError(message(cause)); }
  };
  const close = async (tab: TerminalTab) => {
    try { await closeTerminalTab(repoId, tab, { stopStream: stops.current.get(tab.sessionId) ?? (() => undefined), detach: terminalClient.detach }); }
    catch (cause) { consumeKnownError(cause); setError(message(cause)); }
    stops.current.delete(tab.sessionId); setTabs((current) => current.filter((item) => item.sessionId !== tab.sessionId)); setActiveId((current) => current === tab.sessionId ? null : current);
  };
  // xterm onData → 串行发 daemon(clientSeq 链式递增,失败不阻断后续输入)。
  const send = (sessionId: string, utf8: string) => {
    const tail = inflight.current.get(sessionId) ?? Promise.resolve();
    const next = tail
      .then(async () => {
        const seq = (ackSeq.current.get(sessionId) ?? 0) + 1;
        ackSeq.current.set(sessionId, await terminalClient.input(repoId, sessionId, seq, utf8));
      })
      .catch((cause: unknown) => { consumeKnownError(cause); setError(message(cause)); });
    inflight.current.set(sessionId, next);
  };
  const refit = (sessionId: string, cols: number, rows: number) => {
    void terminalClient.resize(repoId, sessionId, cols, rows).catch((cause) => { consumeKnownError(cause); setError(message(cause)); });
  };
  const terminate = async (tab: TerminalTab) => {
    if (confirmId !== tab.sessionId) { setConfirmId(tab.sessionId); return; }
    try { await requestTerminalTermination(repoId, tab, true, { terminate: terminalClient.terminate }); setTabs((current) => current.map((item) => item.sessionId === tab.sessionId ? { ...item, state: "exited", notice: t("terminal.dock.terminationConfirmed") } : item)); setConfirmId(null); }
    catch (cause) { consumeKnownError(cause); setError(message(cause)); }
  };
  const active = tabs.find((tab) => tab.sessionId === activeId) ?? null;

  if (!open) return <button onClick={onToggle} className="fixed right-4 bottom-3 z-30 rounded-md border border-border-strong bg-surface-raised px-3 py-1.5 font-mono text-[12px] text-text shadow-xl" title={t("terminal.dock.shortcut")}>{t("terminal.dock.title")} · {t("terminal.dock.shortcut")}</button>;
  return <section aria-label={t("terminal.dock.title")} className="fixed right-0 bottom-0 left-0 z-30 flex flex-col border-t border-border-strong bg-surface shadow-2xl md:left-56" style={{ height: `${resize.height}px` }}>
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={t("terminal.dock.resizeHandleAria")}
      title={t("terminal.dock.resizeHandleTitle")}
      data-testid="terminal-dock-resize-handle"
      className={`absolute inset-x-0 -top-1 z-20 h-2 cursor-row-resize touch-none hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none ${resize.resizing ? "bg-accent/50" : ""}`}
      onPointerDown={resize.onHandlePointerDown}
      onPointerMove={resize.onHandlePointerMove}
      onPointerUp={resize.onHandlePointerUp}
      onPointerCancel={resize.onHandlePointerUp}
      onKeyDown={resize.onHandleKeyDown}
    />
    <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
      <strong className="text-[13px]">{t("terminal.dock.localDirectPty")}</strong><span className="font-mono text-[11px] text-text-faint">{t("terminal.dock.repoGeneration", { repoId, generation: generation ?? t("views.settingsView.systemUnknownDash") })}</span>
      <button onClick={onToggle} className="ml-auto rounded px-2 py-1 text-[12px] text-text-muted hover:bg-surface-raised">{t("terminal.dock.close")} · {t("terminal.dock.shortcut")}</button>
    </header>
    <form onSubmit={create} className="flex flex-wrap items-end gap-2 border-b border-border px-3 py-2">
      <Field label={t("terminal.dock.name")}><input value={spawn.name} onChange={(event) => setSpawn({ ...spawn, name: event.target.value })} className="control w-28" /></Field>
      <Field label={t("terminal.dock.cwd")}><select value={spawn.cwdScope} onChange={(event) => setSpawn({ ...spawn, cwdScope: event.target.value as typeof spawn.cwdScope })} className="control"><option value="repo-root">repo-root</option><option value="repo-relative">repo-relative</option></select></Field>
      {spawn.cwdScope === "repo-relative" && <Field label={t("terminal.dock.path")}><input required value={spawn.path} onChange={(event) => setSpawn({ ...spawn, path: event.target.value })} className="control w-36" /></Field>}
      <Field label={t("terminal.dock.shell")}><select value={spawn.shellProfileId} onChange={(event) => setSpawn({ ...spawn, shellProfileId: event.target.value })} className="control"><option value="default">default</option><option value="zsh">zsh</option><option value="bash">bash</option><option value="sh">sh</option><option value="fish">fish</option></select></Field>
      <Field label={t("terminal.dock.task")}><select value={spawn.taskId} onChange={(event) => setSpawn({ ...spawn, taskId: event.target.value })} className="control max-w-44"><option value="">{t("terminal.dock.unbound")}</option>{tasks.map((task) => <option key={task.taskId} value={task.taskId}>{task.taskId} · {task.title}</option>)}</select></Field>
      <button className="rounded border border-accent/60 bg-accent/10 px-3 py-1 text-[12px] text-text">{t("terminal.dock.newTab")}</button>
      <select aria-label={t("terminal.dock.attachExisting")} defaultValue="" onChange={(event) => { const row = sessions.data?.sessions.find((item) => item.sessionId === event.target.value); if (row) attach(row, 0); event.target.value = ""; }} className="control ml-auto"><option value="">{t("terminal.dock.attachSession")}</option>{sessions.data?.sessions.map((row) => <option key={row.sessionId} value={row.sessionId}>{row.name} · {row.status}</option>)}</select>
    </form>
    <div className="flex min-h-0 flex-1">
      <aside className="w-44 shrink-0 overflow-y-auto border-r border-border p-1.5">{tabs.length === 0 ? <p className="p-2 text-[12px] text-text-faint">{t("terminal.dock.empty")}</p> : tabs.map((tab) => <button key={tab.sessionId} onClick={() => setActiveId(tab.sessionId)} className={`mb-1 block w-full rounded px-2 py-1.5 text-left ${activeId === tab.sessionId ? "bg-surface-raised text-text" : "text-text-muted"}`}><span className="block truncate text-[12px] font-medium">{tab.name}</span><span className="font-mono text-[10px]">{tab.state} · seq {tab.lastSeq}</span></button>)}</aside>
      <div className="flex min-w-0 flex-1 flex-col">{active ? <>
        <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-[11px]"><span className="font-mono text-text-faint">{active.sessionId}</span><button onClick={() => { void close(active); }} className="ml-auto rounded px-2 py-1 text-text-muted hover:bg-surface-raised" title={t("terminal.dock.closeDetachTitle")}>{t("terminal.dock.closeDetach")}</button><button onClick={() => { void terminate(active); }} className="rounded px-2 py-1 text-status-blocked hover:bg-surface-raised">{confirmId === active.sessionId ? t("terminal.dock.confirmTerminate") : t("terminal.dock.terminate")}</button></div>
        {active.notice && <p role="status" className="border-b border-status-blocked/30 bg-status-blocked/10 px-2 py-1 text-[11px] text-status-blocked">{active.notice}</p>}
        {active.state === "running" || active.output ? <TerminalPane output={active.output} interactive={active.state === "running"} onInput={(utf8) => send(active.sessionId, utf8)} onFit={(cols, rows) => refit(active.sessionId, cols, rows)} /> : <div className="grid flex-1 place-items-center px-4 text-center text-[12px] text-text-faint">{active.notice ?? t("terminal.dock.sessionNotInteractive")}</div>}
      </> : <div className="grid h-full place-items-center text-[12px] text-text-faint">{t("terminal.dock.startHint")}</div>}</div>
    </div>
    {error && <p role="alert" className="border-t border-status-blocked/30 px-3 py-1 text-[11px] text-status-blocked">{error}</p>}
  </section>;
});

function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) { return <label className="grid gap-0.5 font-mono text-[10px] uppercase tracking-wide text-text-faint">{label}{children}</label>; }
function isInitial(value: TerminalAttachInitial | import("../terminal-model.ts").TerminalStreamFrame): value is TerminalAttachInitial { return value.schema === "terminal-attach/v1"; }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function consumeKnownError(value: unknown): void { void value; }
